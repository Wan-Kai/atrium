import AtriumRemote
import Foundation
import Synchronization

/// Pauses one real transport writer while independently delaying its terminal receive result.
///
/// - Remark: The connection's explicit send-failure path must schedule recovery before the old
///   receive loop can report closure. Releasing that old result after reconnect tests generation isolation.
final class PausedConnectionTransport: RemoteTransport {
  /// Continuations and observable checkpoints for this one transport.
  ///
  /// - Remark: Resumed outside the lock; close is idempotent and always releases the writer.
  private struct State {
    var pauseWrites = false
    var closed = false
    var releasedReads = false
    var writeWaiter: CheckedContinuation<Void, Never>?
    var readWaiter: CheckedContinuation<Void, Never>?
    var terminalReadReturned = false
  }

  private let base: any RemoteTransport
  private let state = Mutex(State())
  var hasBlockedWriter: Bool { state.withLock { $0.writeWaiter != nil } }
  var hasHeldRead: Bool { state.withLock { $0.readWaiter != nil } }
  var isClosed: Bool { state.withLock { $0.closed } }
  var terminalReadReturned: Bool { state.withLock { $0.terminalReadReturned } }

  /// Wraps an in-memory transport without replacing its real handshake or framing behavior.
  ///
  /// - Remark: Initially passes all IO through so pairing and hello finish normally.
  /// - SideEffects: none
  /// - Parameter base: The actual phone endpoint.
  init(_ base: any RemoteTransport) { self.base = base }

  /// Blocks subsequent writes until close.
  ///
  /// - Remark: Called only after handshake and initial heartbeat writes have drained.
  /// - SideEffects: Changes the transport's write behavior.
  func pauseWriter() { state.withLock { $0.pauseWrites = true } }

  /// Writes normally, or suspends the sole writer until close makes it fail.
  ///
  /// - Remark: A blocked ciphertext never reaches the host and has no delivery acknowledgement.
  /// - SideEffects: Writes to the base transport or stores its writer continuation.
  /// - Parameter frame: The ciphertext.
  /// - Throws: TransportError when closed or the underlying write fails.
  func send(_ frame: Data) async throws(TransportError) {
    guard state.withLock({ $0.pauseWrites }) else {
      try await base.send(frame)
      return
    }
    await withCheckedContinuation { continuation in
      let resume = state.withLock { state in
        guard !state.closed else { return true }
        precondition(state.writeWaiter == nil)
        state.writeWaiter = continuation
        return false
      }
      if resume { continuation.resume() }
    }
    throw .failed
  }

  /// Reads real frames, delaying only the terminal error after the endpoint closes.
  ///
  /// - Remark: Deliberately ignores task cancellation at this finite test gate; defer releases it
  ///   on every test exit. This models an old transport completion delivered after a new generation.
  /// - SideEffects: Reads the underlying endpoint and may hold one terminal continuation.
  /// - Returns: An unchanged ciphertext.
  /// - Throws: The underlying terminal error after release.
  func receive() async throws(TransportError) -> Data {
    do throws(TransportError) { return try await base.receive() } catch {
      await withCheckedContinuation { continuation in
        let resume = state.withLock { state in
          guard !state.releasedReads else { return true }
          precondition(state.readWaiter == nil)
          state.readWaiter = continuation
          return false
        }
        if resume { continuation.resume() }
      }
      state.withLock { $0.terminalReadReturned = true }
      throw error
    }
  }

  /// Closes the real endpoint and releases the paused writer, but holds the terminal read until asked.
  ///
  /// - Remark: Keeps the old read callback out of the public send-failure assertion.
  /// - SideEffects: Closes both transport directions and resumes its writer.
  func close() {
    let writer = state.withLock { state in
      state.closed = true
      defer { state.writeWaiter = nil }
      return state.writeWaiter
    }
    base.close()
    writer?.resume()
  }

  /// Releases any delayed old-generation read result.
  ///
  /// - Remark: Also called in defer so an early assertion cannot strand the old receive task.
  /// - SideEffects: Resumes the terminal read and allows later reads to fail immediately.
  func releaseClosedRead() {
    let reader = state.withLock { state in
      state.releasedReads = true
      defer { state.readWaiter = nil }
      return state.readWaiter
    }
    reader?.resume()
  }
}
