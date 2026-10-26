import Foundation
import Synchronization

/// The connection's byte- and count-bounded, single-consumer stream of unread host messages.
///
/// - Remark: Unlike an AsyncStream continuation, this owns the retained messages until `next`
///   consumes them. The fixed 1024-item cap also bounds empty-message metadata. Clearing an old
///   connection releases its data even if an iterator survives.
final class RemoteMessageBuffer: AsyncSequence, Sendable {
  /// The complete, generation-tagged host message yielded by this sequence.
  typealias Element = RemoteMessage

  /// Mutable storage shared by the connection actor and the consuming task.
  ///
  /// - Remark: A wake-up carries no message, so waking a suspended reader cannot bypass accounting.
  private struct State {
    var messages: [RemoteMessage?] = []
    var head = 0
    var bytes = 0
    var finished = false
    var waiter: CheckedContinuation<Void, Never>?
  }

  private let state = Mutex(State())
  private let byteLimit: Int
  private static let messageLimit = 1024
  var bufferedByteCount: Int { state.withLock { $0.bytes } }
  var bufferedMessageCount: Int { state.withLock { $0.messages.count - $0.head } }
  var hasWaitingReader: Bool { state.withLock { $0.waiter != nil } }

  /// Creates the connection's unread-message budget.
  ///
  /// - Remark: The default is a local memory budget, not the Noise per-message limit. Tests can
  ///   shrink it to exercise boundaries without manufacturing large protocol messages.
  /// - SideEffects: none
  /// - Parameter byteLimit: Maximum unread encoded bytes, inclusive.
  init(byteLimit: Int = 16 * 1024 * 1024) {
    precondition(byteLimit >= 0)
    self.byteLimit = byteLimit
  }

  /// Offers a complete host message without dropping any queued message to make room.
  ///
  /// - Remark: The connection must close its current generation with backpressure on rejection.
  /// - SideEffects: Retains the message and wakes a waiting reader on acceptance.
  /// - Parameter message: Encoded message tagged with its connection generation.
  /// - Returns: Whether the message fits and the stream is still open.
  func yield(_ message: RemoteMessage) -> Bool {
    let result = state.withLock { state -> (Bool, CheckedContinuation<Void, Never>?) in
      guard !state.finished, message.data.count <= byteLimit - state.bytes,
        state.messages.count - state.head < Self.messageLimit
      else { return (false, nil) }
      state.messages.append(message)
      state.bytes += message.data.count
      let waiter = state.waiter
      state.waiter = nil
      return (true, waiter)
    }
    result.1?.resume()
    return result.0
  }

  /// Releases unread data for one disconnected generation without ending the stream.
  ///
  /// - Remark: A delayed old-generation cleanup must not decrement the new generation's budget.
  /// - SideEffects: Releases retained messages belonging to the generation.
  /// - Parameter generation: The disconnected connection's generation.
  func clear(generation: Int) {
    state.withLock { state in
      state.messages = state.messages[state.head...].compactMap { message in
        guard let message, message.generation != generation else { return nil }
        return message
      }
      state.head = 0
      state.bytes = state.messages.reduce(0) { $0 + ($1?.data.count ?? 0) }
    }
  }

  /// Ends consumption and immediately releases every unread message.
  ///
  /// - Remark: Stop and reader cancellation must not leave queued data alive through an iterator.
  /// - SideEffects: Releases retained data and resumes the suspended reader, if any.
  func finish() {
    let waiter = state.withLock { state in
      state.finished = true
      state.messages.removeAll()
      state.head = 0
      state.bytes = 0
      let waiter = state.waiter
      state.waiter = nil
      return waiter
    }
    waiter?.resume()
  }

  /// Creates the stream's reader.
  ///
  /// - Remark: One task consumes a connection's messages, matching the sync layer's ownership.
  /// - SideEffects: none
  /// - Returns: An iterator sharing this buffer, not a snapshot of its queued data.
  func makeAsyncIterator() -> Iterator { Iterator(buffer: self) }

  /// An iterator that releases budget only when its next call takes a message.
  ///
  /// - Remark: It retains the buffer rather than an independent queue or a prefetched message.
  struct Iterator: AsyncIteratorProtocol {
    private let buffer: RemoteMessageBuffer

    /// Attaches a reader to its connection's buffer.
    ///
    /// - Remark: Only the sequence creates iterators.
    /// - SideEffects: none
    /// - Parameter buffer: Shared unread-message storage.
    fileprivate init(buffer: RemoteMessageBuffer) { self.buffer = buffer }

    /// Consumes one message, or waits until data or termination is available.
    ///
    /// - Remark: Cancelling the sole consumer ends this stream rather than leaving an orphan waiter.
    /// - SideEffects: Releases the consumed message's budget; may suspend or finish the stream.
    /// - Returns: The next message, or nil after termination or cancellation.
    mutating func next() async -> RemoteMessage? { await buffer.next() }
  }

  /// Takes the oldest message, keeping wake-ups separate from ownership transfer.
  ///
  /// - Remark: Rechecking under the mutex closes the race between an empty read and waiter setup.
  /// - SideEffects: Consumes queued data or registers a cancellable waiter.
  /// - Returns: A message, or nil when finished.
  private func next() async -> RemoteMessage? {
    await withTaskCancellationHandler {
      while !Task.isCancelled {
        let result = state.withLock { state -> (RemoteMessage?, Bool) in
          guard state.head < state.messages.count else { return (nil, state.finished) }
          let message = state.messages[state.head]
          state.messages[state.head] = nil
          state.head += 1
          state.bytes -= message?.data.count ?? 0
          if state.head >= 64 && state.head * 2 >= state.messages.count {
            state.messages.removeFirst(state.head)
            state.head = 0
          }
          return (message, false)
        }
        if let message = result.0 { return message }
        if result.1 { return nil }
        await withCheckedContinuation { continuation in
          let resume = state.withLock { state in
            if state.finished || state.head < state.messages.count { return true }
            precondition(state.waiter == nil, "RemoteMessageBuffer has one consumer")
            state.waiter = continuation
            return false
          }
          if resume { continuation.resume() }
        }
      }
      return nil
    } onCancel: {
      self.finish()
    }
  }
}
