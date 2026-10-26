import AtriumNoise
import AtriumTestSupport
import CryptoKit
import Foundation
import Synchronization
import Testing

@testable import AtriumRemote

/// A socket whose send only returns when close releases it.
///
/// - Remark: Models a network writer blocked by backpressure, unlike MemoryTransport.
final class BlockedWriter: RemoteTransport {
  /// State shared by the sending task and synchronous close.
  ///
  /// - Remark: The continuation is taken once under the mutex.
  private struct State {
    var closed = false
    var started = false
    var continuation: CheckedContinuation<Result<Void, TransportError>, Never>?
  }
  private let state = Mutex(State())
  var isClosed: Bool { state.withLock { $0.closed } }
  var started: Bool { state.withLock { $0.started } }

  /// Suspends until the transport closes.
  ///
  /// - Remark: Cancellation alone deliberately does not unblock the fake socket.
  /// - SideEffects: Stores a continuation.
  /// - Parameter frame: Ignored bytes.
  /// - Throws: A closed-connection error.
  func send(_ frame: Data) async throws(TransportError) {
    let result: Result<Void, TransportError> = await withCheckedContinuation { continuation in
      let closed = state.withLock {
        $0.started = true
        if $0.closed { return true }
        $0.continuation = continuation
        return false
      }
      if closed { continuation.resume(returning: .failure(.failed)) }
    }
    try result.get()
  }

  /// Refuses reads; these tests only exercise the writer.
  ///
  /// - Remark: Required by RemoteTransport.
  /// - SideEffects: none
  /// - Returns: Never returns bytes.
  /// - Throws: Always failed.
  func receive() async throws(TransportError) -> Data { throw .failed }

  /// Unblocks the pending writer.
  ///
  /// - Remark: Safe before, during or after send.
  /// - SideEffects: Resumes the stored continuation.
  func close() {
    let pending = state.withLock {
      $0.closed = true
      let continuation = $0.continuation
      $0.continuation = nil
      return continuation
    }
    pending?.resume(returning: .failure(.failed))
  }
}

/// Shutdown with a real suspended writer rather than instant in-memory sends.
///
/// - Remark: Explicitly verifies the resource-release path.
@Suite("Channel shutdown")
struct ChannelCloseTests {
  @Test("graceful close has a two-second bound even if sending is blocked")
  func boundedClose() async throws {
    let clock = ManualClock()
    let transport = BlockedWriter()
    let (initial, noise, peer) = try openChannel(stopwatch: Stopwatch(clock))
    await initial.close()
    peer.close()
    let channel = SecureChannel(transport: transport, noise: noise, handshakeHash: Data(), stopwatch: Stopwatch(clock))
    defer { transport.close() }
    try await channel.sendHeartbeat()
    try await eventually { transport.started }
    let closing = Task { await channel.close() }
    defer { closing.cancel() }
    try await eventually { clock.remaining == [.seconds(2)] }
    #expect(!transport.isClosed)
    clock.advance(by: .seconds(2))
    await closing.value
    #expect(transport.isClosed)
    try await eventually { clock.sleeperCount == 0 }
  }
}
