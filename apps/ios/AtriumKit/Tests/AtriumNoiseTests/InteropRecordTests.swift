import CryptoKit
import Foundation
import Testing

@testable import AtriumNoise

/// Any JSON value, compared by meaning (key order and number spelling do not matter).
///
/// - Remark: `decoded[i].value` is compared this way; FORMAT.md only fixes key order for the TS replay.
enum JSONValue: Decodable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  /// Decodes whichever kind of value is there.
  ///
  /// - Remark: `Bool` is tried before `Double`, since Foundation would read `true` as 1.
  /// - SideEffects: none
  /// - Parameter decoder: The decoder.
  /// - Throws: When the value is none of the above.
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
}

/// One deterministic session in the format of `spikes/mobile-mp0/interop/FORMAT.md`, bytes as hex.
///
/// - Remark: Read independently of the code that wrote it; the field names are FORMAT.md's, converted
///   from snake case by the decoder.
struct InteropRecord: Decodable {
  /// One handshake message.
  ///
  /// - Remark: `payload_text` is for people only and not compared.
  struct HandshakeEntry: Decodable {
    var from: String
    var payload: String
    var noiseMessage: String
    var wire: String
  }

  /// One transport message.
  ///
  /// - Remark: `nonce` is the sender's counter for this message.
  struct TransportEntry: Decodable {
    var from: String
    var nonce: UInt64
    var plaintext: String
    var ciphertext: String
  }

  /// What the receiver's framing layer handed over.
  ///
  /// - Remark: `text` for messages, `value` for control messages, neither for heartbeats.
  struct Decoded: Decodable, Equatable {
    var from: String
    var kind: String
    var text: String?
    var value: JSONValue?
  }

  var format: Int
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

  /// Reads a record fixture.
  ///
  /// - Remark: The records are copies of `spikes/mobile-mp0/interop/*.json`.
  /// - SideEffects: Reads the fixture.
  /// - Parameter name: The file name.
  /// - Returns: The record.
  /// - Throws: When the file is missing or malformed.
  static func load(_ name: String) throws -> InteropRecord {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(InteropRecord.self, from: fixture(name))
  }
}

/// Replays records: regenerates every byte from the inputs, and reads the other side's bytes.
///
/// - Remark: FORMAT.md "怎么回放", steps 1 and 2, in one pass.
enum InteropReplay {
  /// Turns one framing event into FORMAT.md's `decoded` item.
  ///
  /// - Remark: Control messages are parsed so their keys compare by meaning.
  /// - SideEffects: none
  /// - Parameters:
  ///   - event: The event.
  ///   - from: The sender.
  /// - Returns: The item.
  /// - Throws: When a control body is not JSON.
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

  /// Checks every field of `record` against our implementation.
  ///
  /// - Remark: Our phone writes message 1 and our host message 2 from the recorded keys; both must
  ///   equal the record. Our receivers also read the recorded wire bytes, so a record from the other
  ///   implementation is decrypted by ours without help.
  /// - SideEffects: Records test expectations.
  /// - Parameter record: The record.
  /// - Throws: When an input is malformed or a step fails.
  static func check(_ record: InteropRecord) throws {
    let pattern = try #require(NoisePattern.allCases.first { $0.protocolName == record.protocolName })
    let mode: HandshakeMode = pattern == .ik ? .ik : .ikpsk2
    #expect(record.format == 1)
    #expect(record.mode == Int(mode.rawValue))
    #expect(record.handshake.map(\.from) == ["phone", "host"])
    #expect(record.prologue == AtriumWire.prologue(hostId: record.hostId).hex)
    #expect((record.psk == nil) == (pattern == .ik))
    let hostKey = try privateKey(bytes(record.hostStatic))
    let phoneKey = try privateKey(bytes(record.phoneStatic))
    #expect(hostKey.publicKey.rawRepresentation.hex == record.hostStaticPublic)
    #expect(phoneKey.publicKey.rawRepresentation.hex == record.phoneStaticPublic)
    let psk = try record.psk.map { try bytes($0) }
    let prologue = AtriumWire.prologue(hostId: record.hostId)
    let phone = try NoiseHandshake(
      pattern: pattern, role: .initiator, prologue: prologue, localStatic: phoneKey,
      remoteStatic: hostKey.publicKey.rawRepresentation, psk: psk,
      fixedEphemeral: privateKey(bytes(record.phoneEphemeral)))
    let host = try NoiseHandshake(
      pattern: pattern, role: .responder, prologue: prologue, localStatic: hostKey, remoteStatic: nil, psk: psk,
      fixedEphemeral: privateKey(bytes(record.hostEphemeral)))

    let phonePayload = try bytes(record.handshake[0].payload)
    let hostPayload = try bytes(record.handshake[1].payload)
    let first = try phone.writeMessage(payload: phonePayload)
    #expect(first.hex == record.handshake[0].noiseMessage)
    #expect(AtriumWire.firstFrame(mode: mode, noiseMessage: first).hex == record.handshake[0].wire)
    let (wireMode, wireFirst) = try AtriumWire.parseFirstFrame(bytes(record.handshake[0].wire))
    #expect(wireMode == mode)
    #expect(try host.readMessage(wireFirst) == phonePayload)
    #expect(host.remoteStaticPublicKey?.hex == record.phoneStaticPublic)
    let second = try host.writeMessage(payload: hostPayload)
    #expect(second.hex == record.handshake[1].noiseMessage)
    #expect(record.handshake[1].wire == record.handshake[1].noiseMessage)
    #expect(try phone.readMessage(bytes(record.handshake[1].wire)) == hostPayload)
    let phoneEnd = try phone.split()
    let hostEnd = try host.split()
    #expect(phoneEnd.handshakeHash.hex == record.handshakeHash)
    #expect(hostEnd.handshakeHash.hex == record.handshakeHash)
    #expect(PairingCode.digits(handshakeHash: phoneEnd.handshakeHash) == record.sas)

    var decoded: [InteropRecord.Decoded] = []
    var toHost = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.phoneToHost)
    var toPhone = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.hostToPhone)
    for (index, entry) in record.transport.enumerated() {
      let fromPhone = entry.from == "phone"
      let (sender, receiver) =
        fromPhone ? (phoneEnd.transport, hostEnd.transport) : (hostEnd.transport, phoneEnd.transport)
      #expect(sender.sendCipher.nonce == entry.nonce, "transport[\(index)].nonce")
      let ciphertext = try sender.encrypt(bytes(entry.plaintext))
      #expect(ciphertext.hex == entry.ciphertext, "transport[\(index)].ciphertext")
      let plaintext = try receiver.decrypt(bytes(entry.ciphertext))
      #expect(plaintext.hex == entry.plaintext, "transport[\(index)].plaintext")
      let frame = try ChannelFrame.decode(plaintext)
      let event =
        fromPhone ? try toHost.receive(frame, at: instant(0)) : try toPhone.receive(frame, at: instant(0))
      if let event { decoded.append(try decodedItem(event, from: entry.from)) }
    }
    #expect(decoded == record.decoded)
  }
}

@Suite("interop records")
struct InteropRecordTests {
  @Test(
    "TS and Swift records replay byte for byte",
    arguments: ["ts-ik.json", "ts-ikpsk2.json", "swift-ik.json", "swift-ikpsk2.json"])
  func recordsReplay(name: String) throws {
    let record = try InteropRecord.load(name)
    #expect(record.generator == (name.hasPrefix("ts-") ? "ts" : "swift"))
    #expect(!record.transport.isEmpty)
    try InteropReplay.check(record)
  }

  @Test("a single changed ciphertext byte is caught")
  func replayCatchesASingleChangedByte() throws {
    let record = try InteropRecord.load("ts-ikpsk2.json")
    let host = try NoiseHandshake(
      pattern: .ikpsk2, role: .responder, prologue: bytes(record.prologue),
      localStatic: privateKey(bytes(record.hostStatic)), remoteStatic: nil, psk: record.psk.map { try bytes($0) },
      fixedEphemeral: privateKey(bytes(record.hostEphemeral)))
    _ = try host.readMessage(bytes(record.handshake[0].noiseMessage))
    _ = try host.writeMessage(payload: bytes(record.handshake[1].payload))
    let receiver = try host.split().transport
    let first = try #require(record.transport.first)
    #expect(first.from == "phone")
    var changed = try bytes(first.ciphertext)
    changed[changed.count - 1] ^= 1
    #expect(throws: NoiseError.decryptFailed) { try receiver.decrypt(changed) }
  }
}
