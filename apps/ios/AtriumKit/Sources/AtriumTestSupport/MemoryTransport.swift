import AtriumRemote
import Foundation
import Synchronization

/// One direction of an in-memory connection: frames in order, then how it ended.
///
/// - Remark: Waiters are resumed outside the lock.
final class Mailbox: Sendable {
  /// The mailbox's state.
  ///
  /// - Remark: `ending` is set once, by the first close.
  private struct State {
    var queue: [Data] = []
    var waiters: [CheckedContinuation<Data, any Error>] = []
    var ending: TransportError?
  }

  private let state = Mutex(State())

  /// Delivers a frame, or drops it when the mailbox is closed.
  ///
  /// - Remark: Returns whether it was delivered, so a send to a closed peer fails.
  /// - SideEffects: Queues the frame or resumes a waiter.
  /// - Parameter frame: The frame.
  /// - Returns: Whether the mailbox was open.
  @discardableResult
  func put(_ frame: Data) -> Bool {
    let (open, waiter): (Bool, CheckedContinuation<Data, any Error>?) = state.withLock { state in
      guard state.ending == nil else { return (false, nil) }
      if state.waiters.isEmpty {
        state.queue.append(frame)
        return (true, nil)
      }
      return (true, state.waiters.removeFirst())
    }
    waiter?.resume(returning: frame)
    return open
  }

  /// Takes the next frame, waiting for one.
  ///
  /// - Remark: Queued frames are still delivered after a close, like a socket's buffer.
  /// - SideEffects: Suspends until a frame or the close.
  /// - Returns: The frame.
  /// - Throws: The ``TransportError`` the mailbox was closed with.
  func take() async throws(TransportError) -> Data {
    do {
      return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, any Error>) in
        let result: Result<Data, TransportError>? = state.withLock { state in
          if !state.queue.isEmpty { return .success(state.queue.removeFirst()) }
          if let ending = state.ending { return .failure(ending) }
          state.waiters.append(continuation)
          return nil
        }
        if let result { continuation.resume(with: result) }
      }
    } catch let error as TransportError {
      throw error
    } catch {
      throw .failed
    }
  }

  /// Closes the mailbox; waiting and later takes fail with `ending` once the queue is empty.
  ///
  /// - Remark: Only the first close counts.
  /// - SideEffects: Resumes waiters.
  /// - Parameter ending: How the connection ended for this side.
  func close(_ ending: TransportError) {
    let waiters = state.withLock { state in
      if state.ending == nil { state.ending = ending }
      defer { state.waiters = [] }
      return state.waiters
    }
    for waiter in waiters { waiter.resume(throwing: ending) }
  }

  /// Whether it has been closed.
  var isClosed: Bool { state.withLock { $0.ending != nil } }
}

/// One end of an in-memory WebSocket, as ``RemoteTransport``.
///
/// - Remark: The phone's end goes to the code under test, the host's end to the test, which can close
///   it with a relay close code such as `4404 offline:<s>`.
public final class MemoryTransport: RemoteTransport {
  private let inbox: Mailbox
  private let outbox: Mailbox
  private let sentFrames = Mutex<[Data]>([])
  private let failure: TransportError?

  /// Wires an end to its two mailboxes.
  ///
  /// - Remark: Use ``pair()`` or ``failing(_:)``.
  /// - SideEffects: none
  /// - Parameters:
  ///   - inbox: What this end receives.
  ///   - outbox: What the other end receives.
  ///   - failure: What every call throws, for a connection that never opens.
  init(inbox: Mailbox, outbox: Mailbox, failure: TransportError? = nil) {
    self.inbox = inbox
    self.outbox = outbox
    self.failure = failure
  }

  /// Two connected ends.
  ///
  /// - Remark: The first is the phone's, the second the host's.
  /// - SideEffects: none
  /// - Returns: The ends.
  public static func pair() -> (phone: MemoryTransport, host: MemoryTransport) {
    let toPhone = Mailbox()
    let toHost = Mailbox()
    return (MemoryTransport(inbox: toPhone, outbox: toHost), MemoryTransport(inbox: toHost, outbox: toPhone))
  }

  /// An end that fails every call with `error`, as a connection that never opens.
  ///
  /// - Remark: For "no network", "relay unreachable" and `4404 offline`.
  /// - SideEffects: none
  /// - Parameter error: The failure.
  /// - Returns: The end.
  public static func failing(_ error: TransportError) -> MemoryTransport {
    let inbox = Mailbox()
    let outbox = Mailbox()
    inbox.close(error)
    outbox.close(error)
    return MemoryTransport(inbox: inbox, outbox: outbox, failure: error)
  }

  /// Every frame this end sent, in order.
  public var sent: [Data] { sentFrames.withLock { $0 } }

  /// Sends one frame to the other end.
  ///
  /// - Remark: Fails once either side closed.
  /// - SideEffects: Delivers the frame.
  /// - Parameter frame: The frame.
  /// - Throws: ``TransportError``.
  public func send(_ frame: Data) async throws(TransportError) {
    if let failure { throw failure }
    if inbox.isClosed, !outbox.isClosed { throw .failed }
    guard outbox.put(frame) else {
      throw inbox.isClosed ? .failed : .closed(code: 1000, reason: "")
    }
    sentFrames.withLock { $0.append(frame) }
  }

  /// Takes the next frame from the other end.
  ///
  /// - Remark: See ``Mailbox/take()``.
  /// - SideEffects: Suspends until a frame or the close.
  /// - Returns: The frame.
  /// - Throws: ``TransportError``.
  public func receive() async throws(TransportError) -> Data {
    try await inbox.take()
  }

  /// Closes this end; the other end sees a normal close.
  ///
  /// - Remark: Idempotent.
  /// - SideEffects: Closes both directions.
  public func close() {
    inbox.close(.failed)
    outbox.close(.closed(code: 1000, reason: ""))
  }

  /// Closes the connection as the relay would, with a code and reason for the other end.
  ///
  /// - Remark: Used on the host's end to send `4404 offline:<s>` and friends to the phone.
  /// - SideEffects: Closes both directions.
  /// - Parameters:
  ///   - code: The WebSocket close code.
  ///   - reason: The reason.
  public func close(code: Int, reason: String) {
    inbox.close(.failed)
    outbox.close(.closed(code: code, reason: reason))
  }

  /// Whether this end can no longer receive.
  public var isClosed: Bool { inbox.isClosed }
}

/// An in-memory relay: hands each connection's host end to the test.
///
/// - Remark: Plans let a test make the next connections fail instead, in order.
public final class MemoryRelay: Sendable {
  /// One connection the phone opened.
  ///
  /// - Remark: `url` is the endpoint the phone asked for.
  public struct Connection: Sendable {
    /// The endpoint.
    public let url: URL
    /// The host's end.
    public let host: MemoryTransport
  }

  /// The relay's state.
  ///
  /// - Remark: Connections wait in `queue` until a test takes them.
  private struct State {
    var plans: [TransportError] = []
    var urls: [URL] = []
    var queue: [Connection] = []
    var waiters: [CheckedContinuation<Connection, Never>] = []
  }

  private let state = Mutex(State())

  /// Makes a relay with no connections.
  ///
  /// - Remark: One per test.
  /// - SideEffects: none
  public init() {}

  /// Makes the next connection fail with `error` instead of reaching a host.
  ///
  /// - Remark: Plans are used up in order.
  /// - SideEffects: Queues the plan.
  /// - Parameter error: The failure.
  public func failNext(with error: TransportError) {
    state.withLock { $0.plans.append(error) }
  }

  /// Host connections still queued for a test consumer.
  public var queued: Int { state.withLock { $0.queue.count } }

  /// Every endpoint asked for, failed ones included.
  public var requested: [URL] { state.withLock { $0.urls } }

  /// Opens a connection: `RemoteEnvironment.connect`.
  ///
  /// - Remark: A failing connection is not handed to the test.
  /// - SideEffects: Queues the host's end or resumes a waiting test.
  /// - Parameter url: The endpoint.
  /// - Returns: The phone's end.
  public func connect(_ url: URL) -> any RemoteTransport {
    let (phone, host) = MemoryTransport.pair()
    let connection = Connection(url: url, host: host)
    let (plan, waiter): (TransportError?, CheckedContinuation<Connection, Never>?) = state.withLock { state in
      state.urls.append(url)
      if !state.plans.isEmpty { return (state.plans.removeFirst(), nil) }
      if state.waiters.isEmpty {
        state.queue.append(connection)
        return (nil, nil)
      }
      return (nil, state.waiters.removeFirst())
    }
    if let plan { return MemoryTransport.failing(plan) }
    waiter?.resume(returning: connection)
    return phone
  }

  /// Waits for the next connection that reaches a host.
  ///
  /// - Remark: Tests take connections one by one, in order.
  /// - SideEffects: Suspends until the phone connects.
  /// - Returns: The connection.
  public func next() async -> Connection {
    await withCheckedContinuation { (continuation: CheckedContinuation<Connection, Never>) in
      let ready: Connection? = state.withLock { state in
        if !state.queue.isEmpty { return state.queue.removeFirst() }
        state.waiters.append(continuation)
        return nil
      }
      if let ready { continuation.resume(returning: ready) }
    }
  }
}
