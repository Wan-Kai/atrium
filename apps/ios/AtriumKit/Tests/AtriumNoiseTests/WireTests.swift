import Foundation
import Testing

@testable import AtriumNoise

/// A clock reading for the pure reassembler: any instant works, since time is passed in.
///
/// - Remark: The reassembler never reads a clock itself; tests hand it instants.
/// - SideEffects: none
/// - Parameter seconds: Seconds after an arbitrary start.
/// - Returns: The instant.
func instant(_ seconds: Double) -> ContinuousClock.Instant {
  start.advanced(by: .milliseconds(Int64(seconds * 1000)))
}

/// The arbitrary start of ``instant(_:)``.
// Real time: only an origin for computed instants; nothing waits on it.
private let start = ContinuousClock().now

@Suite("Atrium wire layer")
struct WireTests {
  @Test("the first frame has the 41 01 <mode> header and the prologue binds the host id")
  func firstFrameHeaderAndPrologueBytes() throws {
    #expect(AtriumWire.firstFrame(mode: .ik, noiseMessage: Data([0xaa])).hex == "410101aa")
    #expect(AtriumWire.firstFrame(mode: .ikpsk2, noiseMessage: Data([0xaa])).hex == "410102aa")
    #expect(AtriumWire.prologue(hostId: "hst_1") == Data("atrium-remote/1\u{0}hst_1\u{0}".utf8))
    let (mode, rest) = try AtriumWire.parseFirstFrame(Data([0x41, 0x01, 0x02, 0x09]))
    #expect(mode == .ikpsk2)
    #expect(mode.pattern == .ikpsk2)
    #expect(HandshakeMode.ik.pattern == .ik)
    #expect(rest == Data([0x09]))
    #expect(rest.startIndex == 0)
  }

  @Test(
    "unknown or short first frames are refused",
    arguments: ["", "41", "4101", "420101", "410201", "410100", "410103", "4101ff"])
  func unknownFirstFramesAreRefused(hex: String) throws {
    let frame = try bytes(hex)
    #expect(throws: WireError.badFirstFrame) { try AtriumWire.parseFirstFrame(frame) }
  }

  @Test("frames encode to the agreed bytes and decode back")
  func framesRoundTrip() throws {
    let frames: [ChannelFrame] = [
      .chunk(Data("a".utf8), isLast: true), .chunk(Data("b".utf8), isLast: false), .chunk(Data(), isLast: true),
      .heartbeat, .heartbeatAck, .control(Data(#"{"kind":"x"}"#.utf8)),
    ]
    #expect(frames.map { $0.encoded().hex } == ["0061", "0162", "00", "02", "03", "047b226b696e64223a2278227d"])
    for frame in frames { #expect(try ChannelFrame.decode(frame.encoded()) == frame) }
    // Heartbeats are exactly one byte (interop FORMAT.md).
    #expect(throws: WireError.badFrame) { try ChannelFrame.decode(Data([0x02, 0x01])) }
    #expect(throws: WireError.badFrame) { try ChannelFrame.decode(Data([0x03, 0x00])) }
  }

  @Test(
    "a control message must be a JSON object with a string kind",
    arguments: ["", "{}", "[]", "\"pair\"", #"{"kind":1}"#, #"{"kind":"x""#, "nul\u{0}"])
  func controlMustBeAnObjectWithAStringKind(body: String) {
    #expect(throws: WireError.badControl) { try ChannelFrame.decode(Data([0x04]) + Data(body.utf8)) }
  }

  @Test("a complete message must be UTF-8")
  func messagesMustBeUTF8() throws {
    var reassembler = FrameReassembler<ContinuousClock.Instant>(limit: 100)
    #expect(throws: WireError.badUTF8) {
      try reassembler.receive(.chunk(Data([0xc3, 0x28]), isLast: true), at: instant(0))
    }
  }

  @Test("unknown frame types are refused", arguments: [0x07, 0x10, 0x41, 0xff] as [UInt8])
  func unknownFrameTypesAreRefused(type: UInt8) {
    #expect(throws: WireError.unknownFrameType(type)) { try ChannelFrame.decode(Data([type, 0x00])) }
  }

  @Test("an empty plaintext is refused")
  func emptyPlaintextIsRefused() {
    #expect(throws: WireError.emptyFrame) { try ChannelFrame.decode(Data()) }
  }

  @Test(
    "messages split into full chunks and reassemble",
    arguments: [0, 1, ChannelFrame.maxBody, ChannelFrame.maxBody + 1, 3 * ChannelFrame.maxBody + 5])
  func messagesChunkAndReassemble(size: Int) throws {
    let message = Data((0..<size).map { UInt8(0x61 + $0 % 26) })
    let frames = try ChannelFrame.chunks(of: message, limit: ChannelLimits.phoneToHost)
    #expect(frames.count == max(1, (size + ChannelFrame.maxBody - 1) / ChannelFrame.maxBody))
    #expect(ChannelFrame.maxBody == 65518)
    for frame in frames {
      #expect(frame.encoded().count <= NoiseTransport.maxPlaintextLength)
    }
    var reassembler = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.phoneToHost)
    var events: [ChannelEvent] = []
    for frame in frames {
      if let event = try reassembler.receive(frame, at: instant(0)) { events.append(event) }
    }
    #expect(events == [.message(message)])
    #expect(reassembler.deadline == nil)
  }

  @Test("a sliced message chunks from its own start")
  func slicedMessagesChunk() throws {
    let message = Data("xabcdef".utf8).dropFirst()
    let frames = try ChannelFrame.chunks(of: message, limit: 100, maxBody: 4)
    #expect(frames == [.chunk(Data("abcd".utf8), isLast: false), .chunk(Data("ef".utf8), isLast: true)])
  }

  @Test("heartbeats and control frames may come between chunks")
  func heartbeatsAndControlsMayInterleaveChunks() throws {
    var reassembler = FrameReassembler<ContinuousClock.Instant>(limit: 100)
    let now = instant(0)
    #expect(try reassembler.receive(.chunk(Data("ab".utf8), isLast: false), at: now) == nil)
    #expect(try reassembler.receive(.heartbeat, at: now) == .heartbeat)
    let control = Data(#"{"kind":"x"}"#.utf8)
    #expect(try reassembler.receive(.control(control), at: now) == .control(control))
    #expect(try reassembler.receive(.heartbeatAck, at: now) == .heartbeatAck)
    #expect(try reassembler.receive(.chunk(Data("c".utf8), isLast: true), at: now) == .message(Data("abc".utf8)))
  }

  @Test("size limits hold when sending and when reassembling")
  func sizeLimitsAreEnforcedBothWays() throws {
    #expect(throws: WireError.messageTooLarge(limit: ChannelLimits.phoneToHost)) {
      try ChannelFrame.chunks(of: Data(count: ChannelLimits.phoneToHost + 1), limit: ChannelLimits.phoneToHost)
    }
    #expect(
      try ChannelFrame.chunks(of: Data(count: ChannelLimits.phoneToHost), limit: ChannelLimits.phoneToHost).count == 17)
    var reassembler = FrameReassembler<ContinuousClock.Instant>(limit: 10)
    _ = try reassembler.receive(.chunk(Data(count: 6), isLast: false), at: instant(0))
    #expect(throws: WireError.messageTooLarge(limit: 10)) {
      try reassembler.receive(.chunk(Data(count: 5), isLast: true), at: instant(0))
    }
    var exact = FrameReassembler<ContinuousClock.Instant>(limit: 10)
    _ = try exact.receive(.chunk(Data(count: 6), isLast: false), at: instant(0))
    #expect(try exact.receive(.chunk(Data(count: 4), isLast: true), at: instant(0)) == .message(Data(count: 10)))
    #expect(ChannelLimits.phoneToHost == 1024 * 1024)
    #expect(ChannelLimits.hostToPhone == 8 * 1024 * 1024)
    #expect(ChannelLimits.chunkTimeout == .seconds(30))
  }

  @Test("an open chunked message times out 30 seconds after its first chunk")
  func openChunkTimesOutAfterThirtySeconds() throws {
    var reassembler = FrameReassembler<ContinuousClock.Instant>(limit: 100)
    _ = try reassembler.receive(.chunk(Data("a".utf8), isLast: false), at: instant(0))
    // Later chunks do not extend the deadline.
    _ = try reassembler.receive(.chunk(Data("b".utf8), isLast: false), at: instant(20))
    #expect(reassembler.deadline == instant(30))
    try reassembler.checkTimeout(at: instant(29.999))
    #expect(throws: WireError.chunkTimeout) { try reassembler.checkTimeout(at: instant(30)) }
    #expect(throws: WireError.chunkTimeout) { try reassembler.receive(.heartbeat, at: instant(31)) }

    var completed = FrameReassembler<ContinuousClock.Instant>(limit: 100)
    _ = try completed.receive(.chunk(Data("a".utf8), isLast: false), at: instant(0))
    _ = try completed.receive(.chunk(Data("b".utf8), isLast: true), at: instant(29))
    try completed.checkTimeout(at: instant(300))
    #expect(completed.deadline == nil)
  }

  @Test("the pairing code follows the SPEC's formula, zero-padded")
  func pairingCodeMatchesTheSpecFormula() throws {
    // Expected values computed independently with Python's hashlib (MP0).
    let ikpsk2Hash = try bytes("8310f86394dc0dabb40beb8210031556db4403ab1202db7034c526232147a700")
    #expect(PairingCode.digits(handshakeHash: ikpsk2Hash) == "120668")
    let leadingZeros = try bytes("3ac9a7c437566960f6f0aaf1464100660c1ed8279c1fbcd65b402fd59c0b8273")
    #expect(PairingCode.digits(handshakeHash: leadingZeros) == "000531")
    #expect(PairingCode.display("000531") == "000 531")
  }
}
