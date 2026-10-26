import CryptoKit
import Foundation
import Testing

@testable import AtriumNoiseSpike
@testable import AtriumRemoteSpike

/// Any JSON value, to compare `decoded[i].value` regardless of key order.
enum JSONValue: Codable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// One deterministic session in the format of `spikes/mobile-mp0/interop/FORMAT.md`. Bytes are hex.
struct InteropRecord: Codable, Equatable {
    struct HandshakeEntry: Codable, Equatable {
        var from: String
        var payload: String
        var payloadText: String
        var noiseMessage: String
        var wire: String

        enum CodingKeys: String, CodingKey {
            case from, payload, wire
            case payloadText = "payload_text"
            case noiseMessage = "noise_message"
        }
    }

    struct TransportEntry: Codable, Equatable {
        var from: String
        var nonce: UInt64
        var plaintext: String
        var ciphertext: String
    }

    struct Decoded: Codable, Equatable {
        var from: String
        var kind: String
        var text: String?
        var value: JSONValue?
    }

    var format = 1
    var generator: String
    var protocolName: String
    var mode: Int
    var hostId: String
    var prologue: String
    var psk: String?
    var phoneStatic: String
    var phoneEphemeral: String
    var hostStatic: String
    var hostEphemeral: String
    var phoneStaticPublic: String
    var hostStaticPublic: String
    var handshake: [HandshakeEntry]
    var handshakeHash: String
    var sas: String
    var transport: [TransportEntry]
    var decoded: [Decoded]

    enum CodingKeys: String, CodingKey {
        case format, generator, mode, prologue, psk, handshake, sas, transport, decoded
        case protocolName = "protocol_name"
        case hostId = "host_id"
        case phoneStatic = "phone_static"
        case phoneEphemeral = "phone_ephemeral"
        case hostStatic = "host_static"
        case hostEphemeral = "host_ephemeral"
        case phoneStaticPublic = "phone_static_public"
        case hostStaticPublic = "host_static_public"
        case handshakeHash = "handshake_hash"
    }

    /// Encodes with `psk: null` for IK, as FORMAT.md asks.
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(format, forKey: .format)
        try c.encode(generator, forKey: .generator)
        try c.encode(protocolName, forKey: .protocolName)
        try c.encode(mode, forKey: .mode)
        try c.encode(hostId, forKey: .hostId)
        try c.encode(prologue, forKey: .prologue)
        try c.encode(psk, forKey: .psk)
        try c.encode(phoneStatic, forKey: .phoneStatic)
        try c.encode(phoneEphemeral, forKey: .phoneEphemeral)
        try c.encode(hostStatic, forKey: .hostStatic)
        try c.encode(hostEphemeral, forKey: .hostEphemeral)
        try c.encode(phoneStaticPublic, forKey: .phoneStaticPublic)
        try c.encode(hostStaticPublic, forKey: .hostStaticPublic)
        try c.encode(handshake, forKey: .handshake)
        try c.encode(handshakeHash, forKey: .handshakeHash)
        try c.encode(sas, forKey: .sas)
        try c.encode(transport, forKey: .transport)
        try c.encode(decoded, forKey: .decoded)
    }

    /// The record without the fields replay ignores (`generator`, `payload_text`).
    var comparable: InteropRecord {
        var copy = self
        copy.generator = ""
        for index in copy.handshake.indices { copy.handshake[index].payloadText = "" }
        return copy
    }
}

/// The inputs a record is generated from (FORMAT.md "重新生成").
struct RecordInputs {
    var pattern: NoisePattern
    var hostId: String
    var psk: Data?
    var phoneStatic: Data
    var phoneEphemeral: Data
    var hostStatic: Data
    var hostEphemeral: Data
    var phonePayload: Data
    var hostPayload: Data
    /// `(from, plaintext)` in order.
    var transport: [(String, Data)]
}

/// A record field that does not match, with enough context to find it.
struct ReplayMismatch: Error, CustomStringConvertible {
    var description: String
}

/// `spikes/mobile-mp0/interop`.
let interopDirectory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // AtriumRemoteSpikeTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // swift
    .deletingLastPathComponent()  // mobile-mp0
    .appendingPathComponent("interop")

/// The TS side's records, if present.
let tsRecordFiles: [URL] =
    ((try? FileManager.default.contentsOfDirectory(at: interopDirectory, includingPropertiesForKeys: nil)) ?? [])
    .filter { $0.lastPathComponent.hasPrefix("ts-") && $0.pathExtension == "json" }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }

enum InteropRecords {
    static let hostId = "hst_0123456789abcdef"
    static let deviceId = "dev_0123456789abcdef"

    /// `SHA-256("atrium-mp0 swift <label>")`, so the Swift records differ from the TS ones and never change.
    static func fixed(_ label: String) -> Data {
        Data(SHA256.hash(data: Data("atrium-mp0 swift \(label)".utf8)))
    }

    /// Hex to bytes, failing with the field name.
    static func bytes(_ hex: String, _ field: String) throws -> Data {
        guard let data = Data(hexString: hex) else { throw ReplayMismatch(description: "\(field) is not hex") }
        return data
    }

    /// One frame-layer event as FORMAT.md's `decoded` item.
    static func decodedItem(_ event: ChannelEvent, from: String) throws -> InteropRecord.Decoded {
        switch event {
        case .message(let body):
            return .init(from: from, kind: "message", text: String(decoding: body, as: UTF8.self))
        case .control(let body):
            return .init(from: from, kind: "control", value: try JSONDecoder().decode(JSONValue.self, from: body))
        case .heartbeat: return .init(from: from, kind: "ping")
        case .heartbeatAck: return .init(from: from, kind: "pong")
        }
    }

    /// Both of our roles, keyed by the record's keys.
    static func handshakes(
        pattern: NoisePattern, hostId: String, psk: Data?, phoneStatic: Data, phoneEphemeral: Data,
        hostStatic: Data, hostEphemeral: Data
    ) throws -> (phone: NoiseHandshake, host: NoiseHandshake) {
        let hostKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hostStatic)
        let prologue = AtriumWire.prologue(hostId: hostId)
        let phone = try NoiseHandshake(
            pattern: pattern, role: .initiator, prologue: prologue,
            localStatic: .init(rawRepresentation: phoneStatic), remoteStatic: hostKey.publicKey.rawRepresentation,
            psk: psk, fixedEphemeral: .init(rawRepresentation: phoneEphemeral))
        let host = try NoiseHandshake(
            pattern: pattern, role: .responder, prologue: prologue, localStatic: hostKey, remoteStatic: nil,
            psk: psk, fixedEphemeral: .init(rawRepresentation: hostEphemeral))
        return (phone, host)
    }

    /// Runs the session described by `inputs` and writes every field (FORMAT.md step 1).
    static func generate(_ inputs: RecordInputs, generator: String) throws -> InteropRecord {
        let mode: HandshakeMode = inputs.pattern == .ik ? .ik : .ikpsk2
        let (phone, host) = try handshakes(
            pattern: inputs.pattern, hostId: inputs.hostId, psk: inputs.psk, phoneStatic: inputs.phoneStatic,
            phoneEphemeral: inputs.phoneEphemeral, hostStatic: inputs.hostStatic, hostEphemeral: inputs.hostEphemeral)
        let first = try phone.writeMessage(payload: inputs.phonePayload)
        _ = try host.readMessage(first)
        let second = try host.writeMessage(payload: inputs.hostPayload)
        _ = try phone.readMessage(second)
        let phoneEnd = try phone.split()
        let hostEnd = try host.split()

        var transport: [InteropRecord.TransportEntry] = []
        var decoded: [InteropRecord.Decoded] = []
        var toHost = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.phoneToHost)
        var toPhone = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.hostToPhone)
        let now = ContinuousClock.now
        for (from, plaintext) in inputs.transport {
            let (sender, receiver) = from == "phone" ? (phoneEnd.transport, hostEnd.transport) : (hostEnd.transport, phoneEnd.transport)
            let nonce = sender.sendCipher.nonce
            let ciphertext = try sender.encrypt(plaintext)
            transport.append(.init(from: from, nonce: nonce, plaintext: plaintext.hex, ciphertext: ciphertext.hex))
            let frame = try ChannelFrame.decode(try receiver.decrypt(ciphertext))
            let event = from == "phone" ? try toHost.receive(frame, at: now) : try toPhone.receive(frame, at: now)
            if let event { decoded.append(try decodedItem(event, from: from)) }
        }
        let hostPublic = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: inputs.hostStatic).publicKey
        let phonePublic = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: inputs.phoneStatic).publicKey
        return InteropRecord(
            generator: generator,
            protocolName: inputs.pattern.protocolName,
            mode: Int(mode.rawValue),
            hostId: inputs.hostId,
            prologue: AtriumWire.prologue(hostId: inputs.hostId).hex,
            psk: inputs.psk?.hex,
            phoneStatic: inputs.phoneStatic.hex,
            phoneEphemeral: inputs.phoneEphemeral.hex,
            hostStatic: inputs.hostStatic.hex,
            hostEphemeral: inputs.hostEphemeral.hex,
            phoneStaticPublic: phonePublic.rawRepresentation.hex,
            hostStaticPublic: hostPublic.rawRepresentation.hex,
            handshake: [
                .init(
                    from: "phone", payload: inputs.phonePayload.hex,
                    payloadText: String(decoding: inputs.phonePayload, as: UTF8.self), noiseMessage: first.hex,
                    wire: AtriumWire.firstFrame(mode: mode, noiseMessage: first).hex),
                .init(
                    from: "host", payload: inputs.hostPayload.hex,
                    payloadText: String(decoding: inputs.hostPayload, as: UTF8.self), noiseMessage: second.hex,
                    wire: second.hex),
            ],
            handshakeHash: phoneEnd.handshakeHash.hex,
            sas: PairingCode.digits(handshakeHash: phoneEnd.handshakeHash),
            transport: transport,
            decoded: decoded
        )
    }

    /// The inputs written in `record`.
    static func inputs(of record: InteropRecord) throws -> RecordInputs {
        guard let pattern = NoisePattern.allCases.first(where: { $0.protocolName == record.protocolName }) else {
            throw ReplayMismatch(description: "unknown protocol_name \(record.protocolName)")
        }
        guard record.handshake.map(\.from) == ["phone", "host"] else {
            throw ReplayMismatch(description: "handshake must be phone then host")
        }
        return RecordInputs(
            pattern: pattern, hostId: record.hostId, psk: try record.psk.map { try bytes($0, "psk") },
            phoneStatic: try bytes(record.phoneStatic, "phone_static"),
            phoneEphemeral: try bytes(record.phoneEphemeral, "phone_ephemeral"),
            hostStatic: try bytes(record.hostStatic, "host_static"),
            hostEphemeral: try bytes(record.hostEphemeral, "host_ephemeral"),
            phonePayload: try bytes(record.handshake[0].payload, "handshake[0].payload"),
            hostPayload: try bytes(record.handshake[1].payload, "handshake[1].payload"),
            transport: try record.transport.enumerated().map { index, entry in
                (entry.from, try bytes(entry.plaintext, "transport[\(index)].plaintext"))
            })
    }

    /// FORMAT.md step 1: regenerate from the record's inputs and compare every field.
    static func regenerateAndCompare(_ record: InteropRecord) throws {
        let regenerated = try generate(inputs(of: record), generator: record.generator).comparable
        let expected = record.comparable
        guard regenerated != expected else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        // Name the first differing top-level field.
        let mine = try JSONSerialization.jsonObject(with: encoder.encode(regenerated)) as! [String: Any]
        let theirs = try JSONSerialization.jsonObject(with: encoder.encode(expected)) as! [String: Any]
        let field = mine.keys.sorted().first { !(mine[$0] as AnyObject).isEqual(theirs[$0]) } ?? "?"
        throw ReplayMismatch(description: "regenerated \(field) differs")
    }

    /// FORMAT.md step 2: read the other side's bytes with our receivers only.
    static func readIndependently(_ record: InteropRecord) throws {
        let inputs = try inputs(of: record)
        guard record.prologue == AtriumWire.prologue(hostId: record.hostId).hex else {
            throw ReplayMismatch(description: "prologue does not match host_id")
        }
        let (phone, host) = try handshakes(
            pattern: inputs.pattern, hostId: inputs.hostId, psk: inputs.psk, phoneStatic: inputs.phoneStatic,
            phoneEphemeral: inputs.phoneEphemeral, hostStatic: inputs.hostStatic, hostEphemeral: inputs.hostEphemeral)

        let (mode, first) = try AtriumWire.parseFirstFrame(bytes(record.handshake[0].wire, "handshake[0].wire"))
        guard Int(mode.rawValue) == record.mode, mode.pattern == inputs.pattern else {
            throw ReplayMismatch(description: "first-frame mode \(mode) does not match")
        }
        guard try host.readMessage(first) == inputs.phonePayload else {
            throw ReplayMismatch(description: "host read a different handshake[0] payload")
        }
        guard host.remoteStaticPublicKey?.hex == record.phoneStaticPublic else {
            throw ReplayMismatch(description: "host learned a different phone static key")
        }
        _ = try phone.writeMessage(payload: inputs.phonePayload)
        guard try phone.readMessage(bytes(record.handshake[1].wire, "handshake[1].wire")) == inputs.hostPayload else {
            throw ReplayMismatch(description: "phone read a different handshake[1] payload")
        }
        // Our host must also be able to answer; its message is compared in step 1.
        _ = try host.writeMessage(payload: inputs.hostPayload)
        let phoneEnd = try phone.split()
        let hostEnd = try host.split()
        guard phoneEnd.handshakeHash.hex == record.handshakeHash else {
            throw ReplayMismatch(description: "handshake_hash differs")
        }

        var decoded: [InteropRecord.Decoded] = []
        var toHost = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.phoneToHost)
        var toPhone = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.hostToPhone)
        let now = ContinuousClock.now
        for (index, entry) in record.transport.enumerated() {
            let receiver = entry.from == "phone" ? hostEnd.transport : phoneEnd.transport
            let plaintext = try receiver.decrypt(bytes(entry.ciphertext, "transport[\(index)].ciphertext"))
            guard plaintext.hex == entry.plaintext else {
                throw ReplayMismatch(description: "transport[\(index)] decrypts to different bytes")
            }
            let frame = try ChannelFrame.decode(plaintext)
            let event = entry.from == "phone" ? try toHost.receive(frame, at: now) : try toPhone.receive(frame, at: now)
            if let event { decoded.append(try decodedItem(event, from: entry.from)) }
        }
        guard decoded == record.decoded else {
            throw ReplayMismatch(description: "decoded differs: got \(decoded.map(\.kind)), recorded \(record.decoded.map(\.kind))")
        }
    }

    /// The Swift side's inputs, with FORMAT.md's suggested contents.
    static func swiftInputs(_ pattern: NoisePattern) -> RecordInputs {
        let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        let hello = RemoteJSON.encode(
            HelloMessage(protocolVersion: atriumProtocolVersion, clientId: deviceId, traceparent: traceparent))
        let welcome = RemoteJSON.encode(
            WelcomeMessage(
                type: "welcome", protocolVersion: atriumProtocolVersion, hostVersion: "0.0.0-swift",
                hostInstanceId: "h1", heartbeatMs: 10_000))
        let control = { (message: ControlMessage) in ChannelFrame.control(RemoteJSON.encode(message)).encoded() }
        let message = { (body: Data) in ChannelFrame.chunk(body, isLast: true).encoded() }

        var inputs = RecordInputs(
            pattern: pattern, hostId: hostId, psk: nil,
            phoneStatic: fixed("phone static"), phoneEphemeral: fixed("phone ephemeral"),
            hostStatic: fixed("host static"), hostEphemeral: fixed("host ephemeral"),
            phonePayload: Data(), hostPayload: Data(), transport: [])
        switch pattern {
        case .ikpsk2:
            inputs.psk = fixed("psk")
            inputs.phonePayload = RemoteJSON.encode(
                PairRequest(
                    pairingId: "pair_0123456789abcdef", deviceName: "Swift iPhone", model: "iPhone18,1",
                    appVersion: "0.0.1", protocolVersion: atriumProtocolVersion))
            inputs.hostPayload = RemoteJSON.encode(HandshakeReply(ok: true))
            inputs.transport = [
                ("phone", control(.pairConfirm)),
                ("host", control(.paired(deviceId: deviceId, hostName: "Swift Mac"))),
                ("phone", message(hello)),
                ("host", message(welcome)),
                ("phone", ChannelFrame.heartbeat.encoded()),
                ("host", ChannelFrame.heartbeatAck.encoded()),
            ]
        case .ik:
            inputs.phonePayload = RemoteJSON.encode(
                ConnectRequest(appVersion: "0.0.1", protocolVersion: atriumProtocolVersion))
            inputs.hostPayload = RemoteJSON.encode(HandshakeReply(ok: true, deviceId: deviceId))
            let ping = Data(#"{"requestId":"r1","traceparent":"\#(traceparent)","type":"ping"}"#.utf8)
            let response = Data(#"{"ok":true,"requestId":"r1","type":"response"}"#.utf8)
            // Just over one chunk, so it splits into 65518 bytes and a short tail.
            let pad = Data(#"{"data":""#.utf8) + Data(repeating: 0x62, count: 65_530) + Data(#"","type":"pad"}"#.utf8)
            let chunks = try! ChannelFrame.chunks(of: pad, limit: ChannelLimits.hostToPhone)
            precondition(chunks.count == 2)
            inputs.transport = [
                ("phone", message(hello)),
                ("host", message(welcome)),
                ("phone", message(ping)),
                ("host", message(response)),
                ("phone", ChannelFrame.heartbeat.encoded()),
                ("host", chunks[0].encoded()),
                ("host", ChannelFrame.heartbeatAck.encoded()),
                ("host", chunks[1].encoded()),
                ("host", control(.revoked)),
            ]
        }
        return inputs
    }

    /// Encodes a record for the repository; run `pnpm exec oxfmt` on it afterwards.
    ///
    /// Sorted keys: the TS replay compares `decoded` with `JSON.stringify`, so `value`'s keys must be
    /// in the order of the control message's own text, which `RemoteJSON` sorts.
    static func encode(_ record: InteropRecord) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(record) + Data("\n".utf8)
    }

    /// Reads a record file.
    static func load(_ url: URL) throws -> InteropRecord {
        try JSONDecoder().decode(InteropRecord.self, from: Data(contentsOf: url))
    }
}

@Suite("interop records")
struct InteropRecordTests {
    @Test(arguments: NoisePattern.allCases)
    func swiftRecordsAreCommittedAndReplay(pattern: NoisePattern) throws {
        let generated = try InteropRecords.generate(InteropRecords.swiftInputs(pattern), generator: "swift")
        let url = interopDirectory.appendingPathComponent(pattern == .ik ? "swift-ik.json" : "swift-ikpsk2.json")
        if ProcessInfo.processInfo.environment["ATRIUM_WRITE_INTEROP"] == "1" {
            try InteropRecords.encode(generated).write(to: url)
        }
        let committed = try InteropRecords.load(url)
        #expect(committed == generated, "regenerate: ATRIUM_WRITE_INTEROP=1 swift test --filter InteropRecord")
        try InteropRecords.regenerateAndCompare(committed)
        try InteropRecords.readIndependently(committed)
    }

    @Test(.enabled(if: !tsRecordFiles.isEmpty, "no ts-*.json in spikes/mobile-mp0/interop; copy the TS records there"))
    func tsRecordsReplayByteForByte() throws {
        #expect(tsRecordFiles.map(\.lastPathComponent) == ["ts-ik.json", "ts-ikpsk2.json"])
        for url in tsRecordFiles {
            let record = try InteropRecords.load(url)
            #expect(record.generator == "ts")
            #expect(throws: Never.self, "\(url.lastPathComponent) step 1") { try InteropRecords.regenerateAndCompare(record) }
            #expect(throws: Never.self, "\(url.lastPathComponent) step 2") { try InteropRecords.readIndependently(record) }
        }
    }

    @Test func replayCatchesASingleChangedByte() throws {
        let record = try InteropRecords.generate(InteropRecords.swiftInputs(.ikpsk2), generator: "swift")
        var changedWire = record
        changedWire.transport[0].ciphertext = flipLastHexDigit(record.transport[0].ciphertext)
        #expect(throws: ReplayMismatch.self) { try InteropRecords.regenerateAndCompare(changedWire) }
        #expect(throws: NoiseError.decryptFailed) { try InteropRecords.readIndependently(changedWire) }
        var changedCode = record
        changedCode.sas = "000000"
        #expect(throws: ReplayMismatch.self) { try InteropRecords.regenerateAndCompare(changedCode) }
        var changedDecoded = record
        changedDecoded.decoded[1].value = .object(["kind": .string("revoked")])
        #expect(throws: ReplayMismatch.self) { try InteropRecords.readIndependently(changedDecoded) }
    }

    func flipLastHexDigit(_ hex: String) -> String {
        var characters = Array(hex)
        characters[characters.count - 1] = characters[characters.count - 1] == "0" ? "1" : "0"
        return String(characters)
    }
}
