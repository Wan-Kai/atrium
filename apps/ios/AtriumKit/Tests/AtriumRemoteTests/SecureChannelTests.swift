import AtriumNoise
import AtriumTestSupport
import CryptoKit
import Foundation
import Testing

@testable import AtriumRemote

/// A phone channel over a memory transport, with the host's raw Noise transport to play the other side.
///
/// - Remark: Runs the handshake by hand so a test can send any bytes.
/// - SideEffects: none
/// - Parameters:
///   - stopwatch: The clock.
///   - chunkTimeout: The phone's chunk timeout.
/// - Returns: The phone's channel, the host's transport and the host's end.
/// - Throws: ``NoiseError``.
func openChannel(stopwatch: Stopwatch, chunkTimeout: Duration = .seconds(30)) throws -> (
  SecureChannel, NoiseTransport, MemoryTransport
) {
  let hostKey = Curve25519.KeyAgreement.PrivateKey()
  let phone = try NoiseHandshake(
    pattern: .ik, role: .initiator, prologue: Data(), localStatic: .init(),
    remoteStatic: hostKey.publicKey.rawRepresentation)
  let host = try NoiseHandshake(pattern: .ik, role: .responder, prologue: Data(), localStatic: hostKey)
  _ = try host.readMessage(try phone.writeMessage(payload: Data()))
  _ = try phone.readMessage(try host.writeMessage(payload: Data()))
  let phoneResult = try phone.split()
  let hostResult = try host.split()
  let (phoneEnd, hostEnd) = MemoryTransport.pair()
  let channel = SecureChannel(
    transport: phoneEnd, noise: phoneResult.transport, handshakeHash: phoneResult.handshakeHash, stopwatch: stopwatch,
    chunkTimeout: chunkTimeout)
  return (channel, hostResult.transport, hostEnd)
}

@Suite("Secure channel")
struct SecureChannelTests {
  @Test("large messages arrive whole both ways and heartbeats are answered by themselves")
  func largeMessagesAndHeartbeats() async throws {
    let (channel, host, hostEnd) = try openChannel(stopwatch: Stopwatch(ManualClock()))
    let big = Data((0..<200_000).map { UInt8(0x61 + ($0 * 7) % 26) })
    try await hostEnd.send(try host.encrypt(ChannelFrame.heartbeat.encoded()))
    for frame in try ChannelFrame.chunks(of: big, limit: ChannelLimits.hostToPhone) {
      try await hostEnd.send(try host.encrypt(frame.encoded()))
    }
    #expect(try await channel.nextEvent() == .heartbeat)
    #expect(try await channel.nextEvent() == .message(big))
    #expect(try ChannelFrame.decode(host.decrypt(try await hostEnd.receive())) == .heartbeatAck)

    try await channel.sendMessage(big)
    var received = Data()
    var chunks = 0
    while true {
      guard case .chunk(let body, let isLast) = try ChannelFrame.decode(host.decrypt(try await hostEnd.receive()))
      else {
        Issue.record("expected a chunk")
        return
      }
      received += body
      chunks += 1
      if isLast { break }
    }
    #expect(received == big)
    #expect(chunks == 4)
  }

  @Test("a chunk that does not finish a message still records when the host was last heard")
  func chunkIsHeard() async throws {
    let clock = ManualClock()
    let (channel, host, hostEnd) = try openChannel(stopwatch: Stopwatch(clock))
    #expect(await channel.lastHeard == nil)
    clock.advance(by: .seconds(3))
    try await hostEnd.send(try host.encrypt(ChannelFrame.chunk(Data("part".utf8), isLast: false).encoded()))
    let event = Task { try await channel.nextEvent() }
    defer { event.cancel() }
    await clock.waitForSleepers(1)
    #expect(await channel.lastHeard == Elapsed(offset: .seconds(3)))
  }

  @Test("control messages and heartbeats go out as their own frame types")
  func controlAndHeartbeat() async throws {
    let (channel, host, hostEnd) = try openChannel(stopwatch: Stopwatch(ManualClock()))
    try await channel.sendControl(.pairConfirm)
    try await channel.sendHeartbeat()
    #expect(try host.decrypt(try await hostEnd.receive()) == Data([0x04]) + Data(#"{"kind":"pair_confirm"}"#.utf8))
    #expect(try host.decrypt(try await hostEnd.receive()) == Data([0x02]))
  }

  @Test("an incomplete chunked message closes the channel after 30 seconds on the injected clock")
  func chunkTimeout() async throws {
    let clock = ManualClock()
    let (channel, host, hostEnd) = try openChannel(stopwatch: Stopwatch(clock))
    try await hostEnd.send(try host.encrypt(ChannelFrame.chunk(Data("part".utf8), isLast: false).encoded()))
    let event = Task { try await channel.nextEvent() }
    defer { event.cancel() }
    await clock.waitForSleepers(1)
    #expect(clock.remaining == [.seconds(30)])
    clock.advance(by: .seconds(30))
    await #expect(throws: RemoteError.wire(.chunkTimeout)) { _ = try await event.value }
    #expect(hostEnd.isClosed)
  }

  @Test("a changed frame closes the channel and later sends fail")
  func tamperedFrame() async throws {
    let (channel, host, hostEnd) = try openChannel(stopwatch: Stopwatch(ManualClock()))
    var frame = try host.encrypt(ChannelFrame.heartbeat.encoded())
    frame[0] ^= 1
    try await hostEnd.send(frame)
    await #expect(throws: RemoteError.noise(.decryptFailed)) { _ = try await channel.nextEvent() }
    #expect(hostEnd.isClosed)
    await #expect(throws: RemoteError.closed) { try await channel.sendHeartbeat() }
    await #expect(throws: RemoteError.closed) { _ = try await channel.nextEvent() }
  }

  @Test("an unknown frame type closes the channel")
  func unknownFrameType() async throws {
    let (channel, host, hostEnd) = try openChannel(stopwatch: Stopwatch(ManualClock()))
    try await hostEnd.send(try host.encrypt(Data([0x05])))
    await #expect(throws: RemoteError.wire(.unknownFrameType(0x05))) { _ = try await channel.nextEvent() }
    #expect(hostEnd.isClosed)
  }

  @Test("a message over 1 MiB is refused before sending and ends the channel")
  func oversizedOutgoing() async throws {
    let (channel, _, hostEnd) = try openChannel(stopwatch: Stopwatch(ManualClock()))
    await #expect(throws: RemoteError.wire(.messageTooLarge(limit: ChannelLimits.phoneToHost))) {
      try await channel.sendMessage(Data(count: ChannelLimits.phoneToHost + 1))
    }
    #expect(hostEnd.isClosed)
  }

  @Test("the transport closing ends the wait with its close code")
  func transportClose() async throws {
    let (channel, _, hostEnd) = try openChannel(stopwatch: Stopwatch(ManualClock()))
    hostEnd.close(code: 4404, reason: "offline:5")
    await #expect(throws: RemoteError.transport(.closed(code: 4404, reason: "offline:5"))) {
      _ = try await channel.nextEvent()
    }
  }

  @Test("close sends what was queued first")
  func closeFlushes() async throws {
    let (channel, host, hostEnd) = try openChannel(stopwatch: Stopwatch(ManualClock()))
    try await channel.sendControl(.revoked)
    await channel.close()
    #expect(
      try ChannelFrame.decode(host.decrypt(try await hostEnd.receive())) == .control(Data(#"{"kind":"revoked"}"#.utf8)))
    await #expect(throws: TransportError.self) { _ = try await hostEnd.receive() }
  }
}

@Suite("Heartbeat tracker")
struct HeartbeatTrackerTests {
  @Test("one every 10 s, a miss after 15 s, reconnect after two misses in a row")
  func timings() {
    var tracker = HeartbeatTracker()
    let at = { (seconds: Int) in Elapsed(offset: .seconds(seconds)) }
    #expect(tracker.tick(at: at(0)) == .send)
    tracker.sent(at: at(0))
    #expect(tracker.nextCheck(at: at(0)) == .seconds(10))
    #expect(tracker.tick(at: at(9)) == .wait)
    #expect(tracker.acknowledged(at: at(0) + .milliseconds(120)) == .milliseconds(120))
    #expect(tracker.acknowledged(at: at(1)) == nil)
    #expect(tracker.tick(at: at(10)) == .send)
    tracker.sent(at: at(10))
    #expect(tracker.tick(at: at(19)) == .wait)
    #expect(tracker.nextCheck(at: at(19)) == .seconds(1))
    #expect(tracker.tick(at: at(20)) == .send)
    tracker.sent(at: at(20))
    #expect(tracker.nextCheck(at: at(20)) == .seconds(5))
    #expect(tracker.tick(at: at(25)) == .wait)
    #expect(tracker.misses == 1)
    #expect(tracker.tick(at: at(30)) == .send)
    tracker.sent(at: at(30))
    #expect(tracker.tick(at: at(40)) == .send)
    tracker.sent(at: at(40))
    #expect(tracker.tick(at: at(44)) == .wait)
    #expect(tracker.tick(at: at(45)) == .reconnect)

    var recovered = HeartbeatTracker()
    recovered.sent(at: at(0))
    _ = recovered.tick(at: at(15))
    #expect(recovered.misses == 1)
    recovered.sent(at: at(20))
    _ = recovered.acknowledged(at: at(21))
    #expect(recovered.misses == 0)
    #expect(recovered.nextCheck(at: at(40)) == .zero)
  }

  @Test("any frame from the host after the open heartbeat answers it; one from before or the same instant does not")
  func anyFrameAnswers() {
    let at = { (seconds: Int) in Elapsed(offset: .seconds(seconds)) }
    var tracker = HeartbeatTracker()
    tracker.sent(at: at(10))
    tracker.heard(at: at(9))
    #expect(tracker.nextCheck(at: at(10)) == .seconds(10))
    #expect(tracker.tick(at: at(25)) == .send)
    #expect(tracker.misses == 1)
    tracker.sent(at: at(25))
    tracker.heard(at: at(25))
    #expect(tracker.misses == 1)
    tracker.heard(at: at(26))
    #expect(tracker.misses == 0)
    #expect(tracker.nextCheck(at: at(26)) == .seconds(9))
    #expect(tracker.tick(at: at(40)) == .send)
    #expect(tracker.misses == 0)
  }
}

extension Elapsed {
  /// The instant `duration` later.
  ///
  /// - Remark: Shorthand for tests.
  /// - SideEffects: none
  /// - Parameters:
  ///   - lhs: The instant.
  ///   - rhs: How much later.
  /// - Returns: The later instant.
  static func + (lhs: Elapsed, rhs: Duration) -> Elapsed { lhs.advanced(by: rhs) }
}
