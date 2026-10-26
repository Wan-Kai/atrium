import Foundation
import Synchronization

/// ``RemoteTransport`` over `URLSessionWebSocketTask`, for the relay's `/v1/client` endpoint.
///
/// - Remark: Each transport has its own `URLSession` with a delegate, because the close code and the
///   reason (`4404 offline:<s>`) only arrive through the delegate, and a failed `receive()` may come
///   before them. A failure therefore waits for the task to finish before it is sorted.
public final class WebSocketTransport: RemoteTransport {
  /// The relay allows 70 KiB per frame (SPEC-0005 "上限"); the task's own limit is the same.
  public static let maximumMessageSize = 70 * 1024

  private let task: URLSessionWebSocketTask
  private let session: URLSession
  private let events: WebSocketEvents

  /// Opens a WebSocket to `url`.
  ///
  /// - Remark: `waitsForConnectivity` is off so a phone without network fails at once and can say
  ///   "连不出去" instead of hanging (SPEC-0005 "风险" 2).
  /// - SideEffects: Starts a network connection.
  /// - Parameter url: `wss://<relay>/v1/client?host=<hostId>`.
  public init(url: URL) {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.waitsForConnectivity = false
    let events = WebSocketEvents()
    let session = URLSession(configuration: configuration, delegate: events, delegateQueue: nil)
    task = session.webSocketTask(with: url)
    task.maximumMessageSize = Self.maximumMessageSize
    self.session = session
    self.events = events
    task.resume()
  }

  /// Sends one binary frame.
  ///
  /// - Remark: See ``RemoteTransport/send(_:)``.
  /// - SideEffects: Writes to the network.
  /// - Parameter frame: The bytes.
  /// - Throws: ``TransportError``.
  public func send(_ frame: Data) async throws(TransportError) {
    do {
      try await task.send(.data(frame))
    } catch {
      throw await failure(error)
    }
  }

  /// Waits for the next binary frame; a text frame closes the connection.
  ///
  /// - Remark: See ``RemoteTransport/receive()``.
  /// - SideEffects: Reads from the network.
  /// - Returns: The frame.
  /// - Throws: ``TransportError``.
  public func receive() async throws(TransportError) -> Data {
    let message: URLSessionWebSocketTask.Message
    do {
      message = try await task.receive()
    } catch {
      throw await failure(error)
    }
    switch message {
    case .data(let data): return data
    case .string: break
    @unknown default: break
    }
    close()
    throw .failed
  }

  /// Closes with 1000 and lets the session go.
  ///
  /// - Remark: `finishTasksAndInvalidate` breaks the session's strong reference to its delegate.
  /// - SideEffects: Closes the network connection.
  public func close() {
    task.cancel(with: .normalClosure, reason: nil)
    session.finishTasksAndInvalidate()
  }

  /// Sorts a failed call, once the task has finished and the delegate knows why.
  ///
  /// - Remark: Cancelling first makes sure the task finishes, so the wait cannot hang.
  /// - SideEffects: Cancels the task.
  /// - Parameter error: What the call threw.
  /// - Returns: The sorted failure.
  private func failure(_ error: any Error) async -> TransportError {
    task.cancel()
    let ending = await events.ended()
    if let close = ending.close { return .closed(code: close.code, reason: close.reason) }
    if let status = (task.response as? HTTPURLResponse)?.statusCode, status != 101 { return .unreachable }
    return Self.sort(ending.error ?? error)
  }

  /// Sorts a URL loading error into the three kinds the status line tells apart.
  ///
  /// - Remark: `notConnectedToInternet` is also what an iPhone in mainland China reports before the
  ///   user allows "无线数据" for the app (MP0 on a real device).
  /// - SideEffects: none
  /// - Parameter error: The error.
  /// - Returns: The kind.
  static func sort(_ error: any Error) -> TransportError {
    guard let error = error as? URLError else { return .failed }
    switch error.code {
    case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff, .callIsActive:
      return .noNetwork
    case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .timedOut, .secureConnectionFailed,
      .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
      .serverCertificateHasUnknownRoot, .clientCertificateRejected, .clientCertificateRequired, .badServerResponse,
      .badURL, .unsupportedURL, .appTransportSecurityRequiresSecureConnection:
      return .unreachable
    default:
      return .failed
    }
  }
}

/// Remembers how the WebSocket session ended.
///
/// - Remark: Delegate callbacks come on URLSession's own queue; the state is behind a mutex.
final class WebSocketEvents: NSObject, URLSessionWebSocketDelegate, Sendable {
  /// How the connection ended.
  ///
  /// - Remark: `close` is set when the peer sent a close frame; `error` when the task failed.
  struct Ending: Sendable {
    var close: (code: Int, reason: String)?
    var error: (any Error)?
  }

  /// What the delegate has seen so far.
  ///
  /// - Remark: `waiters` are resumed once the task completes.
  private struct State {
    var close: (code: Int, reason: String)?
    var error: (any Error)?
    var completed = false
    var waiters: [CheckedContinuation<Ending, Never>] = []
  }

  private let state = Mutex(State())

  /// Waits until the task has completed, then says how.
  ///
  /// - Remark: Returns at once when it already has.
  /// - SideEffects: Suspends until the task completes.
  /// - Returns: The close code or the error.
  func ended() async -> Ending {
    await withCheckedContinuation { continuation in
      let ending: Ending? = state.withLock { state in
        guard state.completed else {
          state.waiters.append(continuation)
          return nil
        }
        return Ending(close: state.close, error: state.error)
      }
      if let ending { continuation.resume(returning: ending) }
    }
  }

  /// Records the peer's close frame.
  ///
  /// - Remark: `URLSessionWebSocketDelegate`.
  /// - SideEffects: Updates the state.
  /// - Parameters:
  ///   - session: The session.
  ///   - webSocketTask: The task.
  ///   - closeCode: The code, such as 4404.
  ///   - reason: The reason bytes, UTF-8.
  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    let text = reason.map { String(decoding: $0, as: UTF8.self) } ?? ""
    state.withLock { $0.close = (closeCode.rawValue, text) }
  }

  /// Records that the task finished and wakes the waiters.
  ///
  /// - Remark: `URLSessionTaskDelegate`; always the last callback of a task.
  /// - SideEffects: Updates the state; resumes waiters.
  /// - Parameters:
  ///   - session: The session.
  ///   - task: The task.
  ///   - error: Why it failed, if it did.
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    let (waiters, ending) = state.withLock { state in
      state.completed = true
      if state.error == nil { state.error = error }
      defer { state.waiters = [] }
      return (state.waiters, Ending(close: state.close, error: state.error))
    }
    for waiter in waiters { waiter.resume(returning: ending) }
  }
}
