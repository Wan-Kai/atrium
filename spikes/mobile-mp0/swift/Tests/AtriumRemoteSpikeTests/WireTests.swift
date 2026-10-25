import AtriumNoiseSpike
import Foundation
import Testing

@testable import AtriumRemoteSpike

@Suite("Atrium wire layer")
struct WireTests {
    @Test func firstFrameHeaderAndPrologueBytes() throws {
        #expect(AtriumWire.firstFrame(mode: .ik, noiseMessage: Data([0xaa])).hex == "410101aa")
        #expect(AtriumWire.firstFrame(mode: .ikpsk2, noiseMessage: Data([0xaa])).hex == "410102aa")
        #expect(AtriumWire.prologue(hostId: "hst_1") == Data("atrium-remote/1\u{0}hst_1\u{0}".utf8))
        let (mode, rest) = try AtriumWire.parseFirstFrame(Data([0x41, 0x01, 0x02, 0x09]))
        #expect(mode == .ikpsk2)
        #expect(rest == Data([0x09]))
        #expect(rest.startIndex == 0)
    }

    @Test(arguments: ["", "41", "4101", "420101", "410201", "410100", "410103", "4101ff"])
    func unknownFirstFramesAreRefused(hex: String) {
        #expect(throws: RemoteError.badFirstFrame) { try AtriumWire.parseFirstFrame(Data(hexString: hex)!) }
    }

    @Test func framesRoundTrip() throws {
        let frames: [ChannelFrame] = [
            .chunk(Data("a".utf8), isLast: true), .chunk(Data("b".utf8), isLast: false), .chunk(Data(), isLast: true),
            .heartbeat, .heartbeatAck, .control(Data(#"{"kind":"x"}"#.utf8)),
        ]
        #expect(frames.map { $0.encoded().hex } == ["0061", "0162", "00", "02", "03", "047b226b696e64223a2278227d"])
        for frame in frames { #expect(try ChannelFrame.decode(frame.encoded()) == frame) }
        // Heartbeats are exactly one byte (interop/FORMAT.md).
        #expect(throws: RemoteError.badFrame) { try ChannelFrame.decode(Data([0x02, 0x01])) }
        #expect(throws: RemoteError.badFrame) { try ChannelFrame.decode(Data([0x03, 0x00])) }
    }

    @Test(arguments: ["", "{}", "[]", "\"pair\"", #"{"kind":1}"#, #"{"kind":"x""#, "nul\u{0}"])
    func controlMustBeAnObjectWithAStringKind(body: String) {
        #expect(throws: RemoteError.badControl) { try ChannelFrame.decode(Data([0x04]) + Data(body.utf8)) }
    }

    @Test func messagesMustBeUTF8() throws {
        var reassembler = FrameReassembler<ContinuousClock.Instant>(limit: 100)
        #expect(throws: RemoteError.badUTF8) {
            try reassembler.receive(.chunk(Data([0xc3, 0x28]), isLast: true), at: .now)
        }
    }

    @Test(arguments: [0x05, 0x10, 0x41, 0xff] as [UInt8])
    func unknownFrameTypesAreRefused(type: UInt8) {
        #expect(throws: RemoteError.unknownFrameType(type)) { try ChannelFrame.decode(Data([type, 0x00])) }
    }

    @Test func emptyPlaintextIsRefused() {
        #expect(throws: RemoteError.emptyFrame) { try ChannelFrame.decode(Data()) }
    }

    @Test(arguments: [0, 1, ChannelFrame.maxBody, ChannelFrame.maxBody + 1, 3 * ChannelFrame.maxBody + 5])
    func messagesChunkAndReassemble(size: Int) throws {
        let message = Data((0..<size).map { UInt8(0x61 + $0 % 26) })
        let frames = try ChannelFrame.chunks(of: message, limit: ChannelLimits.phoneToHost)
        #expect(frames.count == max(1, (size + ChannelFrame.maxBody - 1) / ChannelFrame.maxBody))
        for frame in frames {
            #expect(frame.encoded().count <= NoiseTransport.maxPlaintextLength)
        }
        var reassembler = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.phoneToHost)
        let now = ContinuousClock.now
        var events: [ChannelEvent] = []
        for frame in frames {
            if let event = try reassembler.receive(frame, at: now) { events.append(event) }
        }
        #expect(events == [.message(message)])
        #expect(reassembler.deadline == nil)
    }

    @Test func heartbeatsAndControlsMayInterleaveChunks() throws {
        var reassembler = FrameReassembler<ContinuousClock.Instant>(limit: 100)
        let now = ContinuousClock.now
        #expect(try reassembler.receive(.chunk(Data("ab".utf8), isLast: false), at: now) == nil)
        #expect(try reassembler.receive(.heartbeat, at: now) == .heartbeat)
        let control = Data(#"{"kind":"x"}"#.utf8)
        #expect(try reassembler.receive(.control(control), at: now) == .control(control))
        #expect(try reassembler.receive(.heartbeatAck, at: now) == .heartbeatAck)
        #expect(try reassembler.receive(.chunk(Data("c".utf8), isLast: true), at: now) == .message(Data("abc".utf8)))
    }

    @Test func sizeLimitsAreEnforcedBothWays() throws {
        #expect(throws: RemoteError.messageTooLarge(limit: ChannelLimits.phoneToHost)) {
            try ChannelFrame.chunks(of: Data(count: ChannelLimits.phoneToHost + 1), limit: ChannelLimits.phoneToHost)
        }
        #expect(try ChannelFrame.chunks(of: Data(count: ChannelLimits.phoneToHost), limit: ChannelLimits.phoneToHost).count == 17)
        var reassembler = FrameReassembler<ContinuousClock.Instant>(limit: 10)
        let now = ContinuousClock.now
        _ = try reassembler.receive(.chunk(Data(count: 6), isLast: false), at: now)
        #expect(throws: RemoteError.messageTooLarge(limit: 10)) {
            try reassembler.receive(.chunk(Data(count: 5), isLast: true), at: now)
        }
        var exact = FrameReassembler<ContinuousClock.Instant>(limit: 10)
        _ = try exact.receive(.chunk(Data(count: 6), isLast: false), at: now)
        #expect(try exact.receive(.chunk(Data(count: 4), isLast: true), at: now) == .message(Data(count: 10)))
        #expect(ChannelLimits.hostToPhone == 8 * 1024 * 1024)
    }

    @Test func openChunkTimesOutAfterThirtySeconds() throws {
        var reassembler = FrameReassembler<ContinuousClock.Instant>(limit: 100)
        let start = ContinuousClock.now
        _ = try reassembler.receive(.chunk(Data("a".utf8), isLast: false), at: start)
        // Later chunks do not extend the deadline.
        _ = try reassembler.receive(.chunk(Data("b".utf8), isLast: false), at: start + .seconds(20))
        #expect(reassembler.deadline == start + .seconds(30))
        try reassembler.checkTimeout(at: start + .milliseconds(29_999))
        #expect(throws: RemoteError.chunkTimeout) { try reassembler.checkTimeout(at: start + .seconds(30)) }
        #expect(throws: RemoteError.chunkTimeout) { try reassembler.receive(.heartbeat, at: start + .seconds(31)) }

        var completed = FrameReassembler<ContinuousClock.Instant>(limit: 100)
        _ = try completed.receive(.chunk(Data("a".utf8), isLast: false), at: start)
        _ = try completed.receive(.chunk(Data("b".utf8), isLast: true), at: start + .seconds(29))
        try completed.checkTimeout(at: start + .seconds(300))
    }

    @Test func pairingCodeMatchesTheSpecFormula() {
        // Expected values computed independently with Python's hashlib.
        let ikpsk2Hash = Data(hexString: "8310f86394dc0dabb40beb8210031556db4403ab1202db7034c526232147a700")!
        #expect(PairingCode.digits(handshakeHash: ikpsk2Hash) == "120668")
        let leadingZeros = Data(hexString: "3ac9a7c437566960f6f0aaf1464100660c1ed8279c1fbcd65b402fd59c0b8273")!
        #expect(PairingCode.digits(handshakeHash: leadingZeros) == "000531")
        #expect(PairingCode.display("000531") == "000 531")
    }

    @Test func pairingLinkParses() throws {
        let key = Data((0..<32).map { UInt8($0) })
        let psk = Data((0..<32).map { UInt8(255 - $0) })
        let link = try PairingLink(
            "atrium://pair?v=1&relay=ws://127.0.0.1:8787&host=hst_0123456789abcdef&key=\(key.base64URL)"
                + "&pairing=pair_00000000000000a1&psk=\(psk.base64URL)&name=Ktoon%E7%9A%84MacBook")
        #expect(link.relay.absoluteString == "ws://127.0.0.1:8787")
        #expect(link.hostId == "hst_0123456789abcdef")
        #expect(link.hostKey == key)
        #expect(link.psk == psk)
        #expect(link.pairingId == "pair_00000000000000a1")
        #expect(link.hostName == "Ktoon的MacBook")
        #expect(
            clientEndpoint(relay: link.relay, hostId: link.hostId).absoluteString
                == "ws://127.0.0.1:8787/v1/client?host=hst_0123456789abcdef")
        #expect(
            clientEndpoint(relay: URL(string: "wss://relay.example/base/")!, hostId: "h").absoluteString
                == "wss://relay.example/base/v1/client?host=h")
    }

    @Test(arguments: [
        "https://pair?v=1",
        "atrium://pair?v=2&relay=ws://a&host=h&key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&pairing=pair_0123456789abcdef&psk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "atrium://pair?v=1&relay=http://a&host=h&key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&pairing=pair_0123456789abcdef&psk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "atrium://pair?v=1&relay=ws://a&host=h&key=AAAA&pairing=pair_0123456789abcdef&psk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "atrium://pair?v=1&relay=ws://a&host=h%00x&key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&pairing=pair_0123456789abcdef&psk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "atrium://pair?v=1&relay=ws://a&host=h&key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&pairing=&psk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "atrium://pair?v=1&relay=ws://a&host=h&key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&pairing=pair_0123456789ABCDEF&psk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "atrium://pair?v=1&v=1&relay=ws://a&host=h&key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&pairing=pair_0123456789abcdef&psk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ])
    func badPairingLinksAreRefused(text: String) {
        #expect(throws: RemoteError.badPairingLink) { try PairingLink(text) }
    }

    @Test func heartbeatTrackerFollowsTheSpecTimings() {
        var tracker = HeartbeatTracker<ContinuousClock.Instant>()
        let t0 = ContinuousClock.now
        #expect(tracker.tick(at: t0) == .send)
        tracker.sent(at: t0)
        #expect(tracker.tick(at: t0 + .seconds(9)) == .wait)
        #expect(tracker.acknowledged(at: t0 + .milliseconds(120)) == .milliseconds(120))
        #expect(tracker.tick(at: t0 + .seconds(10)) == .send)
        tracker.sent(at: t0 + .seconds(10))
        #expect(tracker.tick(at: t0 + .seconds(19)) == .wait)
        // 15 s without an answer is one miss; the next heartbeat is due anyway.
        #expect(tracker.tick(at: t0 + .seconds(25)) == .send)
        #expect(tracker.misses == 1)
        tracker.sent(at: t0 + .seconds(25))
        #expect(tracker.tick(at: t0 + .seconds(34)) == .wait)
        #expect(tracker.tick(at: t0 + .seconds(40)) == .reconnect)

        var recovered = HeartbeatTracker<ContinuousClock.Instant>()
        recovered.sent(at: t0)
        _ = recovered.tick(at: t0 + .seconds(15))
        #expect(recovered.misses == 1)
        recovered.sent(at: t0 + .seconds(20))
        _ = recovered.acknowledged(at: t0 + .seconds(21))
        #expect(recovered.misses == 0)
    }
}
