import CryptoKit
import Foundation
import Testing

@testable import AtriumNoiseSpike
@testable import Torann

/// Torann 0.3.1 (MIT, unaudited) as a second opinion. Test target only; never in the app.
struct Reference {
    let initiator: Torann.HandshakeState
    let responder: Torann.HandshakeState

    /// Torann's two parties with the same keys as `keys`.
    init(_ keys: SessionKeys) throws {
        let proto = try NoiseProtocol.parse(keys.pattern.protocolName)
        let psks = keys.psk.map { [$0] } ?? []
        initiator = try proto.createHandshake(
            initiator: true, prologue: keys.prologue, localStatic: try proto.createKeyPair(privateKey: keys.initStatic),
            remoteStatic: keys.respStaticPublic, psks: psks)
        responder = try proto.createHandshake(
            initiator: false, prologue: keys.prologue,
            localStatic: try proto.createKeyPair(privateKey: keys.respStatic), psks: psks)
        try initiator.setFixedEphemeral(keys.initEphemeral)
        try responder.setFixedEphemeral(keys.respEphemeral)
    }
}

@Suite("differential against Torann")
struct TorannDifferentialTests {
    /// Random payload sizes that include the edges: empty, the 1 KiB handshake limit, one Noise message.
    func handshakePayload() -> Data {
        randomBytes([0, 1, NoiseHandshake.maxPayloadLength, Int.random(in: 0...NoiseHandshake.maxPayloadLength)].randomElement()!)
    }

    func transportPayload() -> Data {
        randomBytes([0, 1, NoiseTransport.maxPlaintextLength, Int.random(in: 0...2048)].randomElement()!)
    }

    @Test(arguments: NoisePattern.allCases)
    func sameKeysGiveTheSameBytes(pattern: NoisePattern) throws {
        for _ in 0..<100 {
            let keys = SessionKeys.random(pattern)
            let ours = (try keys.initiator(), try keys.responder())
            let theirs = try Reference(keys)

            let p0 = handshakePayload()
            let m0 = try ours.0.writeMessage(payload: p0)
            let r0 = try theirs.initiator.writeMessage(payload: p0)
            #expect(m0 == r0.message)
            // Cross-read: each implementation reads the other's message.
            #expect(try ours.1.readMessage(r0.message) == p0)
            #expect(try theirs.responder.readMessage(m0).payload == p0)

            let p1 = handshakePayload()
            let m1 = try ours.1.writeMessage(payload: p1)
            let r1 = try theirs.responder.writeMessage(payload: p1)
            #expect(m1 == r1.message)
            #expect(try ours.0.readMessage(r1.message) == p1)
            let theirInitiatorEnd = try theirs.initiator.readMessage(m1)
            #expect(theirInitiatorEnd.payload == p1)

            let ourInitiator = try ours.0.split()
            let ourResponder = try ours.1.split()
            #expect(ourInitiator.handshakeHash == r1.handshakeHash)
            #expect(ourResponder.handshakeHash == theirInitiatorEnd.handshakeHash)
            let theirInitiator = try #require(theirInitiatorEnd.transport)
            let theirResponder = try #require(r1.transport)

            for step in 0..<6 {
                let payload = transportPayload()
                if step % 2 == 0 {
                    let mine = try ourInitiator.transport.encrypt(payload)
                    #expect(mine == (try theirInitiator.writeMessage(payload: payload)))
                    #expect(try theirResponder.readMessage(mine) == payload)
                    #expect(try ourResponder.transport.decrypt(mine) == payload)
                } else {
                    let mine = try ourResponder.transport.encrypt(payload)
                    #expect(mine == (try theirResponder.writeMessage(payload: payload)))
                    #expect(try theirInitiator.readMessage(mine) == payload)
                    #expect(try ourInitiator.transport.decrypt(mine) == payload)
                }
            }
        }
    }

    @Test(arguments: NoisePattern.allCases)
    func oversizedPayloadFromThePeerIsRefused(pattern: NoisePattern) throws {
        // Torann has no 1 KiB limit, so it can build the message our writer refuses to.
        let keys = SessionKeys.random(pattern)
        let message = try Reference(keys).initiator.writeMessage(payload: Data(count: NoiseHandshake.maxPayloadLength + 1))
        #expect(throws: NoiseError.payloadTooLong) { try keys.responder().readMessage(message.message) }

        let responder = try Reference(keys).responder
        _ = try responder.readMessage(try keys.initiator().writeMessage(payload: Data()))
        let second = try responder.writeMessage(payload: Data(count: NoiseHandshake.maxPayloadLength + 1))
        let initiator = try keys.initiator()
        _ = try initiator.writeMessage(payload: Data())
        #expect(throws: NoiseError.payloadTooLong) { try initiator.readMessage(second.message) }
    }

    /// Mutates `data` in one of a few ways: bit flips, truncation, extension, or random bytes.
    func mutate(_ data: Data) -> Data {
        var copy = data
        switch Int.random(in: 0..<4) {
        case 0:
            for _ in 0..<Int.random(in: 1...4) {
                copy[Int.random(in: 0..<copy.count)] ^= UInt8(1 << Int.random(in: 0..<8))
            }
        case 1: copy = copy.prefix(Int.random(in: 0..<copy.count))
        case 2: copy += randomBytes(Int.random(in: 1...32))
        default: copy = randomBytes(Int.random(in: 0...(copy.count + 64)))
        }
        return copy == data ? copy + [0] : copy
    }

    @Test(arguments: NoisePattern.allCases)
    func fuzzedMessagesAreRefusedByBoth(pattern: NoisePattern) throws {
        for _ in 0..<300 {
            let keys = SessionKeys.random(pattern)
            let first = try keys.initiator().writeMessage(payload: handshakePayload())
            let bad = mutate(first)
            let ours = Result { try keys.responder().readMessage(bad) }
            let theirs = Result { try Reference(keys).responder.readMessage(bad) }
            // Every byte of message 1 is authenticated, so any change must fail in both.
            #expect(throws: (any Error).self) { try ours.get() }
            #expect(throws: (any Error).self) { try theirs.get() }

            let responder = try keys.responder()
            _ = try responder.readMessage(first)
            let second = try responder.writeMessage(payload: handshakePayload())
            let badSecond = mutate(second)
            let ourInitiator = try keys.initiator()
            _ = try ourInitiator.writeMessage(payload: Data())
            let reference = try Reference(keys)
            _ = try reference.initiator.writeMessage(payload: Data())
            #expect(throws: (any Error).self) { try ourInitiator.readMessage(badSecond) }
            #expect(throws: (any Error).self) { try reference.initiator.readMessage(badSecond) }

            let (a, b) = try completeHandshake(try keys.initiator(), try keys.responder())
            let transport = try a.transport.encrypt(transportPayload())
            #expect(throws: (any Error).self) { try b.transport.decrypt(mutate(transport)) }
        }
    }
}

/// An interop record (interop/FORMAT.md), read independently of the code that wrote it.
struct RecordFile: Decodable {
    struct Handshake: Decodable {
        let payload: String
        let noise_message: String
        let wire: String
    }

    struct Transport: Decodable {
        let from: String
        let plaintext: String
        let ciphertext: String
    }

    let protocol_name: String
    let mode: Int
    let prologue: String
    let psk: String?
    let phone_static: String
    let phone_ephemeral: String
    let host_static: String
    let host_ephemeral: String
    let handshake: [Handshake]
    let handshake_hash: String
    let transport: [Transport]
}

/// Every `*.json` record in `spikes/mobile-mp0/interop`, Swift's and the TS side's.
let recordFiles: [String] = {
    let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("interop")
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    return names.filter { $0.hasSuffix(".json") }.sorted().map { directory.appendingPathComponent($0).path }
}()

@Suite("interop records against Torann")
struct InteropRecordsAgainstTorannTests {
    @Test func swiftRecordsArePresent() {
        #expect(recordFiles.map { URL(fileURLWithPath: $0).lastPathComponent }.contains("swift-ik.json"))
        #expect(recordFiles.map { URL(fileURLWithPath: $0).lastPathComponent }.contains("swift-ikpsk2.json"))
    }

    @Test(arguments: recordFiles)
    func torannProducesTheSameBytes(path: String) throws {
        let record = try JSONDecoder().decode(RecordFile.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let proto = try NoiseProtocol.parse(record.protocol_name)
        let psks = record.psk.map { [Data(hex: $0)] } ?? []
        let hostKey = try proto.createKeyPair(privateKey: Data(hex: record.host_static))
        let phone = try proto.createHandshake(
            initiator: true, prologue: Data(hex: record.prologue),
            localStatic: try proto.createKeyPair(privateKey: Data(hex: record.phone_static)),
            remoteStatic: try hostKey.publicKey, psks: psks)
        let host = try proto.createHandshake(
            initiator: false, prologue: Data(hex: record.prologue), localStatic: hostKey, psks: psks)
        try phone.setFixedEphemeral(Data(hex: record.phone_ephemeral))
        try host.setFixedEphemeral(Data(hex: record.host_ephemeral))

        let first = try phone.writeMessage(payload: Data(hex: record.handshake[0].payload))
        #expect(first.message.hex == record.handshake[0].noise_message)
        // The wire adds Atrium's 3-byte header to message 1 only.
        #expect(record.handshake[0].wire == String(format: "4101%02x", record.mode) + record.handshake[0].noise_message)
        #expect(try host.readMessage(first.message).payload.hex == record.handshake[0].payload)
        let second = try host.writeMessage(payload: Data(hex: record.handshake[1].payload))
        #expect(second.message.hex == record.handshake[1].noise_message)
        #expect(record.handshake[1].wire == record.handshake[1].noise_message)
        let end = try phone.readMessage(second.message)
        #expect(end.handshakeHash?.hex == record.handshake_hash)
        let phoneTransport = try #require(end.transport)
        let hostTransport = try #require(second.transport)
        for entry in record.transport {
            let sender = entry.from == "phone" ? phoneTransport : hostTransport
            #expect(try sender.writeMessage(payload: Data(hex: entry.plaintext)).hex == entry.ciphertext)
        }
    }
}
