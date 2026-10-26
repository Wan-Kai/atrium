import AtriumNoise
import AtriumTestSupport
import Foundation
import Synchronization
import Testing

@testable import AtriumRemote

@Suite("Client buffer budgets")
struct BufferBudgetTests {
  @Test("a blocked writer counts in-flight ciphertext and closes on cumulative overflow")
  func blockedWriterOverflow() async throws {
    let clock = ManualClock()
    let transport = BlockedWriter()
    let (initial, noise, peer) = try openChannel(stopwatch: Stopwatch(clock))
    await initial.close()
    peer.close()
    let channel = SecureChannel(
      transport: transport, noise: noise, handshakeHash: Data(), stopwatch: Stopwatch(clock))
    defer { channel.abort() }
    let message = Data(repeating: 0x61, count: 1 << 20)
    try await channel.sendMessage(message)
    try await eventually { transport.started }
    #expect(channel.bufferedByteCount == message.count + 17 * 17)
    await #expect(throws: RemoteError.backpressure) { try await channel.sendMessage(message) }
    #expect(transport.isClosed)
    #expect(channel.bufferedByteCount == 0)
    #expect(channel.bufferedFrameCount == 0)
    await #expect(throws: RemoteError.closed) { try await channel.sendHeartbeat() }
  }

  @Test("ciphertext accepts exactly 2 MiB and rejects one additional byte", arguments: [0, 1])
  func ciphertextBoundary(extra: Int) async throws {
    let (channel, transport) = try await blockedChannel()
    defer { channel.abort() }
    for _ in 0..<32 {
      try await channel.sendMessage(Data(repeating: 0x61, count: ChannelFrame.maxBody))
    }
    try await eventually { transport.started }
    #expect(channel.bufferedByteCount == 32 * 65_535)
    let final = Data(repeating: 0x62, count: 15 + extra)
    if extra == 0 {
      try await channel.sendMessage(final)
      #expect(channel.bufferedByteCount == 2 * 1024 * 1024)
      #expect(!transport.isClosed)
      channel.abort()
    } else {
      await #expect(throws: RemoteError.backpressure) { try await channel.sendMessage(final) }
    }
    #expect(channel.bufferedByteCount == 0)
    #expect(channel.bufferedFrameCount == 0)
    #expect(transport.isClosed)
  }

  @Test("many small sends share one cumulative ciphertext budget")
  func smallCiphertexts() async throws {
    let (channel, transport) = try await blockedChannel()
    defer { channel.abort() }
    let small = Data(repeating: 0x61, count: 1007)
    for _ in 0..<2048 { try await channel.sendMessage(small) }
    #expect(channel.bufferedByteCount == 2 * 1024 * 1024)
    await #expect(throws: RemoteError.backpressure) { try await channel.sendHeartbeat() }
    #expect(channel.bufferedByteCount == 0)
    #expect(transport.isClosed)
  }

  @Test("dropping the channel owner closes its blocked writer")
  func ownerCleanup() async throws {
    let stopwatch = Stopwatch(ManualClock())
    let (initial, noise, peer) = try openChannel(stopwatch: stopwatch)
    await initial.close()
    peer.close()
    let transport = BlockedWriter()
    defer { transport.close() }
    var channel: SecureChannel? = SecureChannel(
      transport: transport, noise: noise, handshakeHash: Data(), stopwatch: stopwatch)
    weak let owner = channel
    try await channel?.sendHeartbeat()
    try await eventually { transport.started }
    channel = nil
    #expect(owner == nil)
    #expect(transport.isClosed)
  }

  @Test("transport failure releases both queued and in-flight ciphertext")
  func writerFailure() async throws {
    let (channel, transport) = try await blockedChannel()
    defer { channel.abort() }
    try await channel.sendHeartbeat()
    try await eventually { transport.started }
    try await channel.sendHeartbeat()
    #expect(channel.bufferedByteCount == 34)
    transport.close()
    try await eventually { channel.bufferedByteCount == 0 }
    await #expect(throws: RemoteError.closed) { try await channel.sendHeartbeat() }
  }

  @Test("a late successful send after abort cannot make counts negative or alter a new channel")
  func lateCompletion() async throws {
    let stopwatch = Stopwatch(ManualClock())
    let (initial, noise, peer) = try openChannel(stopwatch: stopwatch)
    await initial.close()
    peer.close()
    let transport = CompletingOnCloseWriter()
    let old = SecureChannel(transport: transport, noise: noise, handshakeHash: Data(), stopwatch: stopwatch)
    let (current, currentTransport) = try await blockedChannel()
    defer {
      old.abort()
      current.abort()
    }
    try await old.sendHeartbeat()
    try await eventually { transport.started }
    try await old.sendHeartbeat()
    try await current.sendHeartbeat()
    try await eventually { currentTransport.started }
    #expect(old.bufferedByteCount == 34)
    #expect(current.bufferedByteCount == 17)
    old.abort()
    await old.waitForWriter()
    #expect(old.bufferedByteCount == 0)
    #expect(old.bufferedFrameCount == 0)
    #expect(transport.sendCount == 1)
    #expect(current.bufferedByteCount == 17)
    #expect(!currentTransport.isClosed)
    current.abort()
    await current.waitForWriter()
    #expect(current.bufferedByteCount == 0)
    #expect(current.bufferedFrameCount == 0)
  }

  @Test("successful sends release bytes and preserve multi-frame nonce order")
  func completedWrites() async throws {
    let (channel, host, peer) = try openChannel(stopwatch: Stopwatch(ManualClock()))
    defer { channel.abort() }
    let payload = Data(repeating: 0x61, count: 200_000)
    try await channel.sendMessage(payload)
    try await channel.sendControl(.pairConfirm)
    try await channel.sendHeartbeat()
    let expected = try ChannelFrame.chunks(of: payload, limit: ChannelLimits.phoneToHost)
    for frame in expected {
      #expect(try ChannelFrame.decode(host.decrypt(try await peer.receive())) == frame)
    }
    #expect(
      try ChannelFrame.decode(host.decrypt(try await peer.receive()))
        == .control(RemoteJSON.encode(ControlMessage.pairConfirm)))
    #expect(try ChannelFrame.decode(host.decrypt(try await peer.receive())) == .heartbeat)
    try await eventually { channel.bufferedByteCount == 0 }
    try await channel.sendHeartbeat()
    #expect(try ChannelFrame.decode(host.decrypt(try await peer.receive())) == .heartbeat)
    try await eventually { channel.bufferedByteCount == 0 }
  }

  @Test("1024 empty messages fit, but another exceeds the unread item budget")
  func emptyMessagesAreBounded() async {
    let buffer = RemoteMessageBuffer()
    let empty = RemoteMessage(generation: 1, data: Data())
    for _ in 0..<1024 { #expect(buffer.yield(empty)) }
    #expect(buffer.bufferedByteCount == 0)
    #expect(buffer.bufferedMessageCount == 1024)
    #expect(!buffer.yield(empty))
    var iterator = buffer.makeAsyncIterator()
    #expect(await iterator.next() == empty)
    #expect(buffer.bufferedMessageCount == 1023)
    let newer = RemoteMessage(generation: 2, data: Data())
    #expect(buffer.yield(newer))
    buffer.clear(generation: 1)
    buffer.clear(generation: 1)
    #expect(buffer.bufferedMessageCount == 1)
    for _ in 0..<1023 { #expect(buffer.yield(newer)) }
    #expect(!buffer.yield(newer))
    buffer.finish()
    #expect(buffer.bufferedByteCount == 0)
    #expect(buffer.bufferedMessageCount == 0)
  }

  @Test("a stopped reader retains exactly 16 MiB and rejects the next byte")
  func unreadBoundary() async {
    let buffer = RemoteMessageBuffer()
    var reader = buffer.makeAsyncIterator()
    let half = RemoteMessage(generation: 1, data: Data(repeating: 0x61, count: 8 * 1024 * 1024))
    #expect(buffer.yield(half))
    #expect(buffer.yield(half))
    #expect(buffer.bufferedByteCount == 16 * 1024 * 1024)
    #expect(buffer.bufferedMessageCount == 2)
    #expect(!buffer.yield(RemoteMessage(generation: 1, data: Data([0x62]))))
    #expect(buffer.bufferedByteCount == 16 * 1024 * 1024)
    #expect(await reader.next() == half)
    #expect(buffer.bufferedByteCount == 8 * 1024 * 1024)
    #expect(buffer.yield(half))
    buffer.finish()
    #expect(buffer.bufferedByteCount == 0)
    #expect(buffer.bufferedMessageCount == 0)
    #expect(await reader.next() == nil)
    #expect(!buffer.yield(half))
  }

  @Test("many small unread messages retain budget until next consumes them")
  func smallUnreadMessages() async {
    let buffer = RemoteMessageBuffer(byteLimit: 1024)
    var reader = buffer.makeAsyncIterator()
    for index in 0..<1024 {
      #expect(buffer.yield(RemoteMessage(generation: index, data: Data([UInt8(index % 256)]))))
    }
    #expect(buffer.bufferedByteCount == 1024)
    #expect(!buffer.yield(RemoteMessage(generation: 1024, data: Data([0x61]))))
    for index in 0..<1024 {
      #expect(await reader.next() == RemoteMessage(generation: index, data: Data([UInt8(index % 256)])))
      #expect(buffer.bufferedByteCount == 1023 - index)
    }
    #expect(buffer.bufferedMessageCount == 0)
    buffer.finish()
  }

  @Test("old-generation cleanup cannot release or discard newer unread messages")
  func generationCleanup() async {
    let buffer = RemoteMessageBuffer(byteLimit: 4)
    var reader = buffer.makeAsyncIterator()
    let old = RemoteMessage(generation: 1, data: Data([1, 2]))
    let current = RemoteMessage(generation: 2, data: Data([3, 4]))
    #expect(buffer.yield(old))
    #expect(buffer.yield(current))
    buffer.clear(generation: 1)
    buffer.clear(generation: 1)
    #expect(buffer.bufferedByteCount == 2)
    #expect(buffer.bufferedMessageCount == 1)
    #expect(await reader.next() == current)
    #expect(buffer.bufferedByteCount == 0)
    #expect(buffer.yield(current))
    buffer.finish()
    #expect(buffer.bufferedByteCount == 0)
    #expect(buffer.bufferedMessageCount == 0)
    #expect(await reader.next() == nil)
  }

  @Test("finish wakes a suspended reader; clearing a generation keeps the stream usable")
  func waitingReader() async throws {
    let buffer = RemoteMessageBuffer(byteLimit: 2)
    let reading = Task {
      var reader = buffer.makeAsyncIterator()
      return await reader.next()
    }
    defer {
      reading.cancel()
      buffer.finish()
    }
    try await eventually { buffer.hasWaitingReader }
    buffer.clear(generation: 1)
    let message = RemoteMessage(generation: 2, data: Data([1, 2]))
    #expect(buffer.yield(message))
    #expect(await reading.value == message)
    #expect(buffer.bufferedByteCount == 0)
    let finishing = Task {
      var reader = buffer.makeAsyncIterator()
      return await reader.next()
    }
    defer { finishing.cancel() }
    try await eventually { buffer.hasWaitingReader }
    buffer.finish()
    #expect(await finishing.value == nil)
    #expect(!buffer.hasWaitingReader)
    #expect(buffer.bufferedByteCount == 0)
  }

  @Test("cancelling a waiting reader releases its waiter and ends consumption")
  func cancelReader() async throws {
    let buffer = RemoteMessageBuffer()
    let reading = Task {
      var reader = buffer.makeAsyncIterator()
      return await reader.next()
    }
    defer {
      reading.cancel()
      buffer.finish()
    }
    try await eventually { buffer.hasWaitingReader }
    reading.cancel()
    #expect(await reading.value == nil)
    #expect(!buffer.hasWaitingReader)
    #expect(buffer.bufferedByteCount == 0)
    #expect(!buffer.yield(RemoteMessage(generation: 1, data: Data([1]))))
  }
}

/// Opens a real Noise channel over a transport that cannot finish a send before close.
///
/// - Remark: Budget tests use real encryption and the production 2 MiB limit.
/// - SideEffects: Starts a channel writer; closes the temporary handshake channel.
/// - Returns: The channel and its blocked transport.
/// - Throws: A handshake failure.
private func blockedChannel() async throws -> (SecureChannel, BlockedWriter) {
  let stopwatch = Stopwatch(ManualClock())
  let (initial, noise, peer) = try openChannel(stopwatch: stopwatch)
  await initial.close()
  peer.close()
  let transport = BlockedWriter()
  return (SecureChannel(transport: transport, noise: noise, handshakeHash: Data(), stopwatch: stopwatch), transport)
}

/// A blocked socket whose in-flight write succeeds concurrently with closing it.
///
/// - Remark: Exercises the late-success path rather than assuming cancellation always throws.
private final class CompletingOnCloseWriter: RemoteTransport {
  /// The sole pending write and transport state.
  ///
  /// - Remark: Close and send can race on different tasks.
  private struct State {
    var closed = false
    var sendCount = 0
    var pending: CheckedContinuation<Void, Never>?
  }
  private let state = Mutex(State())
  var started: Bool { state.withLock { $0.pending != nil } }
  var sendCount: Int { state.withLock { $0.sendCount } }

  /// Completes a write successfully only when close resolves it.
  ///
  /// - Remark: Models a socket already committed to delivering its successful completion callback.
  /// - SideEffects: Retains the write continuation until close.
  /// - Parameter frame: The ciphertext, unused by this transport.
  /// - Throws: Does not throw in this test transport.
  func send(_ frame: Data) async throws(TransportError) {
    await withCheckedContinuation { continuation in
      let closed = state.withLock { state in
        state.sendCount += 1
        if state.closed { return true }
        state.pending = continuation
        return false
      }
      if closed { continuation.resume() }
    }
  }

  /// Refuses reads because this fixture exercises only writes.
  ///
  /// - Remark: Required by RemoteTransport.
  /// - SideEffects: none
  /// - Returns: Never returns bytes.
  /// - Throws: Always failed.
  func receive() async throws(TransportError) -> Data { throw .failed }

  /// Resolves the pending send successfully despite transport closure.
  ///
  /// - Remark: The channel must ignore that completion after releasing its reservations.
  /// - SideEffects: Resumes the pending writer.
  func close() {
    let pending = state.withLock { state in
      state.closed = true
      let pending = state.pending
      state.pending = nil
      return pending
    }
    pending?.resume()
  }
}
