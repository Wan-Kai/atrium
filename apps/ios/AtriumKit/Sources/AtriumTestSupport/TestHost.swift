import AtriumNoise
import AtriumRemote
import CryptoKit
import Foundation
import Synchronization

/// A minimal Swift stand-in for the host, playing the responder over a ``MemoryTransport``.
///
/// - Remark: Tests drive it step by step, so each can stop at the point it checks. The real host is
///   TypeScript (MP3a); the integration test runs against the MP0 fake host instead.
public struct TestHost: Sendable {
  /// The host id.
  public let hostId = "hst_0123456789abcdef"
  /// The host's static key.
  public let key: Curve25519.KeyAgreement.PrivateKey
  /// The current pairing's id.
  public let pairingId = "pair_0123456789abcdef"
  /// The current pairing's PSK.
  public let psk: Data
  /// The id it gives the phone.
  public let deviceId = "dev_0123456789abcdef"
  /// The Mac's name.
  public let hostName = "Test Mac"
  /// The relay in the link.
  public let relay: URL

  /// Makes a host with fixed keys from `seed`.
  ///
  /// - Remark: Fixed so failures replay; different seeds make different hosts.
  /// - SideEffects: none
  /// - Parameter seed: Any byte.
  public init(seed: UInt8 = 1) {
    let raw = Data(SHA256.hash(data: Data([seed, 0x6b])))
    key = (try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)) ?? Curve25519.KeyAgreement.PrivateKey()
    psk = Data(SHA256.hash(data: Data([seed, 0x70])))
    relay = URL(string: "wss://relay.test/atrium") ?? URL(fileURLWithPath: "/")
  }

  /// The pairing link the Mac would show.
  public var linkText: String {
    "atrium://pair?v=1&relay=\(relay.absoluteString)&host=\(hostId)"
      + "&key=\(key.publicKey.rawRepresentation.base64URL)&pairing=\(pairingId)&psk=\(psk.base64URL)&name=Test%20Mac"
  }

  /// The record a paired phone keeps.
  public var record: HostRecord {
    HostRecord(
      hostId: hostId, relay: relay, hostKey: key.publicKey.rawRepresentation, hostName: hostName, deviceId: deviceId)
  }

  /// Reads handshake message 1 and answers it.
  ///
  /// - Remark: ``HostAnswer/hangUp`` closes without answering, as the host does for a pairing id that
  ///   is not the current one. A refusal still gets an open channel back so the test can close it.
  /// - SideEffects: Reads and writes on `transport`.
  /// - Parameters:
  ///   - transport: The host's end.
  ///   - stopwatch: The clock for the channel.
  ///   - answer: What to answer; by default `{ ok: true }` for pairing and `{ ok: true, deviceId }` for IK.
  /// - Returns: What the host saw, and the channel.
  /// - Throws: Any failure.
  public func accept(
    _ transport: MemoryTransport, stopwatch: Stopwatch, answer: HostAnswer = .accept
  ) async throws -> HostSide {
    let (mode, first) = try AtriumWire.parseFirstFrame(try await transport.receive())
    let handshake = try NoiseHandshake(
      pattern: mode.pattern, role: .responder, prologue: AtriumWire.prologue(hostId: hostId), localStatic: key,
      psk: mode == .ikpsk2 ? psk : nil)
    let request = try handshake.readMessage(first)
    let deviceKey = handshake.remoteStaticPublicKey ?? Data()
    let reply: HandshakeReply
    switch answer {
    case .accept: reply = mode == .ik ? HandshakeReply(ok: true, deviceId: deviceId) : HandshakeReply(ok: true)
    case .hangUp:
      transport.close()
      return HostSide(mode: mode, request: request, deviceKey: deviceKey, channel: nil, code: "")
    case .reply(let given): reply = given
    }
    try await transport.send(try handshake.writeMessage(payload: RemoteJSON.encode(reply)))
    let result = try handshake.split()
    let code = PairingCode.digits(handshakeHash: result.handshakeHash)
    let channel = SecureChannel(
      transport: transport, noise: result.transport, handshakeHash: result.handshakeHash, stopwatch: stopwatch,
      receiveLimit: ChannelLimits.phoneToHost, sendLimit: ChannelLimits.hostToPhone)
    return HostSide(mode: mode, request: request, deviceKey: deviceKey, channel: channel, code: code)
  }
}

/// How the test host answers handshake message 1.
///
/// - Remark: See ``TestHost/accept(_:stopwatch:answer:)``.
public enum HostAnswer: Sendable {
  /// `{ ok: true }`, with the device id for IK.
  case accept
  /// This payload.
  case reply(HandshakeReply)
  /// Close without answering.
  case hangUp
}

/// The host's side of one connection, after message 2.
///
/// - Remark: `channel` is `nil` when the host closed without answering.
public struct HostSide: Sendable {
  /// Which handshake the phone asked for.
  public let mode: HandshakeMode
  /// Message 1's payload.
  public let request: Data
  /// The phone's static key.
  public let deviceKey: Data
  /// The channel.
  public let channel: SecureChannel?
  /// The pairing code the host computed.
  public let code: String

  /// The next event on the channel.
  ///
  /// - Remark: Answers the phone's heartbeats by itself, like the real host.
  /// - SideEffects: Reads from the channel.
  /// - Returns: The event.
  /// - Throws: When there is no channel or it fails.
  public func next() async throws -> ChannelEvent {
    guard let channel else { throw RemoteError.closed }
    return try await channel.nextEvent()
  }

  /// Waits for the next control message and decodes it.
  ///
  /// - Remark: Skips heartbeats.
  /// - SideEffects: Reads from the channel.
  /// - Returns: The control message.
  /// - Throws: When something else comes or the channel fails.
  public func nextControl() async throws -> ControlMessage {
    while true {
      switch try await next() {
      case .heartbeat, .heartbeatAck: continue
      case .control(let body): return try RemoteJSON.decode(ControlMessage.self, from: body)
      case .message: throw RemoteError.unexpected
      }
    }
  }

  /// Waits for the next Atrium message.
  ///
  /// - Remark: Skips heartbeats and control messages.
  /// - SideEffects: Reads from the channel.
  /// - Returns: The message's bytes.
  /// - Throws: When the channel fails.
  public func nextMessage() async throws -> Data {
    while true {
      if case .message(let body) = try await next() { return body }
    }
  }

  /// Reads `hello` and answers with `welcome` at `protocolVersion`.
  ///
  /// - Remark: The welcome has every field the generated `WelcomeMessage` requires.
  /// - SideEffects: Reads and writes on the channel.
  /// - Parameter protocolVersion: The version the host claims.
  /// - Returns: The `hello` as JSON.
  /// - Throws: When the channel fails or `hello` is not JSON.
  @discardableResult
  public func answerHello(protocolVersion: Int) async throws -> [String: Any] {
    let hello = try await nextMessage()
    let welcome =
      #"{"type":"welcome","protocolVersion":\#(protocolVersion),"hostVersion":"0.0.0-test","#
      + #""hostInstanceId":"h1","heartbeatMs":10000,"installSeed":1,"logDir":"/tmp/atrium-test"}"#
    try await send(Data(welcome.utf8))
    return (try JSONSerialization.jsonObject(with: hello) as? [String: Any]) ?? [:]
  }

  /// Sends an Atrium message.
  ///
  /// - Remark: Host → phone limits apply.
  /// - SideEffects: Writes on the channel.
  /// - Parameter message: The bytes.
  /// - Throws: When there is no channel or it fails.
  public func send(_ message: Data) async throws {
    guard let channel else { throw RemoteError.closed }
    try await channel.sendMessage(message)
  }

  /// Sends a control message.
  ///
  /// - Remark: `paired`, `pair_rejected`, `revoked`.
  /// - SideEffects: Writes on the channel.
  /// - Parameter message: The control message.
  /// - Throws: When there is no channel or it fails.
  public func send(_ message: ControlMessage) async throws {
    guard let channel else { throw RemoteError.closed }
    try await channel.sendControl(message)
  }

  /// Flushes and closes the channel.
  ///
  /// - Remark: The phone sees a normal close.
  /// - SideEffects: Closes the connection.
  public func close() async {
    await channel?.close()
  }

  /// Keeps reading so the phone's heartbeats are answered, until the channel ends.
  ///
  /// - Remark: Run it in a task; the count of heartbeats seen is kept in `heartbeats`.
  /// - SideEffects: Reads from the channel.
  /// - Parameter heartbeats: Counts the phone's heartbeats.
  public func serve(heartbeats: Counter) async {
    while let event = try? await next() {
      if event == .heartbeat { heartbeats.increment() }
    }
  }
}

/// A count shared between a task and the test.
///
/// - Remark: Behind a mutex.
public final class Counter: Sendable {
  private let value = Mutex(0)

  /// Starts at zero.
  ///
  /// - Remark: One per thing counted.
  /// - SideEffects: none
  public init() {}

  /// Adds one.
  ///
  /// - Remark: From any task.
  /// - SideEffects: Changes the count.
  public func increment() {
    value.withLock { $0 += 1 }
  }

  /// The count.
  public var count: Int { value.withLock { $0 } }
}
