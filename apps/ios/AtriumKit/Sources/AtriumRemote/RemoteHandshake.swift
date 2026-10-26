import AtriumNoise
import AtriumProtocol
import CryptoKit
import Foundation

/// What the phone reports about itself in the pairing request.
///
/// - Remark: The host shows the name and model in its confirmation sheet.
public struct DeviceInfo: Sendable, Equatable {
  /// The phone's name, `UIDevice.current.name` by default.
  public var deviceName: String
  /// The hardware model, such as `iPhone17,1`.
  public var model: String
  /// The app's version.
  public var appVersion: String

  /// Builds the description.
  ///
  /// - Remark: Memberwise.
  /// - SideEffects: none
  /// - Parameters:
  ///   - deviceName: The phone's name.
  ///   - model: The hardware model.
  ///   - appVersion: The app's version.
  public init(deviceName: String, model: String, appVersion: String) {
    self.deviceName = deviceName
    self.model = model
    self.appVersion = appVersion
  }
}

/// A pairing channel after the key confirmation, waiting for the Mac.
///
/// - Remark: The code is computed from the final handshake hash (SPEC-0005 "配对流程" step 4).
public struct PairingChannel: Sendable {
  /// The channel.
  public let channel: SecureChannel
  /// The six digits both screens show.
  public let code: String
}

/// The phone's side of the handshakes and the Atrium `hello` (SPEC-0005 "配对流程", "日常连接").
///
/// - Remark: Stateless steps; ``PairingFlow`` and ``RemoteConnection`` decide timing, retries and
///   what to delete.
public enum RemoteHandshake {
  /// Pairs with IKpsk2 up to the key confirmation.
  ///
  /// - Remark: The PSK only enters at the end of message 2, so the host learns that the phone knows
  ///   it only from the first transport message, `pair_confirm` (SPEC-0005 "配对流程" step 3).
  /// - SideEffects: Sends and receives on `transport`; closes it on failure.
  /// - Parameters:
  ///   - link: The scanned pairing link.
  ///   - deviceKey: This phone's static key.
  ///   - info: What to tell the Mac about this phone.
  ///   - transport: Connected to `<relay>/v1/client?host=<hostId>`.
  ///   - stopwatch: The injected clock.
  ///   - protocolVersion: The protocol version the app speaks.
  /// - Returns: The channel and the code.
  /// - Throws: ``RemoteError``; ``RemoteError/rejected(reason:hostProtocol:)`` when message 2 refuses.
  public static func pair(
    link: PairingLink,
    deviceKey: Curve25519.KeyAgreement.PrivateKey,
    info: DeviceInfo,
    transport: any RemoteTransport,
    stopwatch: Stopwatch,
    protocolVersion: Int = AtriumProtocol.protocolVersion
  ) async throws(RemoteError) -> PairingChannel {
    let request = PairRequest(
      pairingId: link.pairingId, deviceName: info.deviceName, model: info.model, appVersion: info.appVersion,
      protocolVersion: protocolVersion)
    let (reply, channel) = try await handshake(
      mode: .ikpsk2, hostId: link.hostId, hostKey: link.hostKey, psk: link.psk, deviceKey: deviceKey,
      payload: RemoteJSON.encode(request), transport: transport, stopwatch: stopwatch)
    guard reply.ok else {
      await channel.close()
      throw .rejected(reason: reply.reason ?? "unknown", hostProtocol: reply.hostProtocol)
    }
    try await channel.sendControl(.pairConfirm)
    return PairingChannel(channel: channel, code: PairingCode.digits(handshakeHash: channel.handshakeHash))
  }

  /// Waits on a confirmed pairing channel for the Mac's answer.
  ///
  /// - Remark: Only control messages may come before `paired`; a `revoked` here means the host is
  ///   confused and is treated as a refusal.
  /// - SideEffects: Reads from the channel; closes it on refusal or failure.
  /// - Parameter channel: From ``pair(link:deviceKey:info:transport:stopwatch:protocolVersion:)``.
  /// - Returns: The device id and the Mac's name.
  /// - Throws: ``RemoteError``; ``RemoteError/rejected(reason:hostProtocol:)`` with `pair_rejected`.
  public static func awaitPaired(_ channel: SecureChannel) async throws(RemoteError) -> (
    deviceId: String, hostName: String
  ) {
    while true {
      switch try await channel.nextEvent() {
      case .heartbeat, .heartbeatAck: continue
      case .message:
        await channel.close()
        throw .unexpected
      case .control(let body):
        let control: ControlMessage
        do {
          control = try RemoteJSON.decode(ControlMessage.self, from: body)
        } catch {
          await channel.close()
          throw error
        }
        switch control {
        case .paired(let deviceId, let hostName): return (deviceId, hostName)
        case .pairRejected(let reason):
          await channel.close()
          throw .rejected(reason: reason, hostProtocol: nil)
        case .revoked:
          await channel.close()
          throw .rejected(reason: "revoked", hostProtocol: nil)
        case .pairConfirm:
          await channel.close()
          throw .unexpected
        }
      }
    }
  }

  /// Connects an already paired phone with IK.
  ///
  /// - Remark: The host finds the phone by the static key it learns from message 1 (SPEC-0005
  ///   "日常连接" step 2).
  /// - SideEffects: Sends and receives on `transport`; closes it on failure.
  /// - Parameters:
  ///   - hostId: The host id.
  ///   - hostKey: The host's static public key.
  ///   - deviceKey: This phone's static key.
  ///   - appVersion: The app's version.
  ///   - transport: Connected to the relay.
  ///   - stopwatch: The injected clock.
  ///   - protocolVersion: The protocol version the app speaks.
  /// - Returns: The device id and the channel.
  /// - Throws: ``RemoteError``; ``RemoteError/rejected(reason:hostProtocol:)`` with `device_unknown`
  ///   or `version_mismatch`.
  public static func connect(
    hostId: String,
    hostKey: Data,
    deviceKey: Curve25519.KeyAgreement.PrivateKey,
    appVersion: String,
    transport: any RemoteTransport,
    stopwatch: Stopwatch,
    protocolVersion: Int = AtriumProtocol.protocolVersion
  ) async throws(RemoteError) -> (deviceId: String, channel: SecureChannel) {
    let request = ConnectRequest(appVersion: appVersion, protocolVersion: protocolVersion)
    let (reply, channel) = try await handshake(
      mode: .ik, hostId: hostId, hostKey: hostKey, psk: nil, deviceKey: deviceKey,
      payload: RemoteJSON.encode(request), transport: transport, stopwatch: stopwatch)
    guard reply.ok, let deviceId = reply.deviceId else {
      await channel.close()
      throw .rejected(reason: reply.reason ?? "unknown", hostProtocol: reply.hostProtocol)
    }
    return (deviceId, channel)
  }

  /// The `hello` a phone sends over a remote channel: no `token`, `clientId` = `deviceId`.
  ///
  /// - Remark: SPEC-0005 "协议改动" 1. Written by hand until the generated `HelloMessage` has an
  ///   optional `token` (the host side's protocol bump); then this becomes
  ///   `HelloMessage(…, token: nil, …)` and nothing else changes.
  /// - SideEffects: none
  /// - Parameters:
  ///   - deviceId: The id the host gave this phone.
  ///   - traceparent: A W3C `traceparent` for the host's trace.
  ///   - protocolVersion: The protocol version the app speaks.
  /// - Returns: The encoded message.
  /// - Throws: ``RemoteError/badPayload``.
  public static func helloMessage(
    deviceId: String, traceparent: String, protocolVersion: Int = AtriumProtocol.protocolVersion
  ) throws(RemoteError) -> Data {
    try RemoteJSON.encode(RemoteHello(protocolVersion: protocolVersion, clientId: deviceId, traceparent: traceparent))
  }

  /// Sends `hello` and waits for `welcome`.
  ///
  /// - Remark: A `revoked` control message may arrive instead; it is passed up as a refusal so the
  ///   caller deletes the pairing (SPEC-0005 "撤销": authenticated inside Noise).
  /// - SideEffects: Sends and receives on the channel; closes it on failure.
  /// - Parameters:
  ///   - channel: An open channel.
  ///   - deviceId: The id the host gave this phone.
  ///   - traceparent: A W3C `traceparent`.
  ///   - protocolVersion: The protocol version the app speaks.
  /// - Returns: The host's `welcome`.
  /// - Throws: ``RemoteError``; ``RemoteError/versionMismatch(hostProtocol:)`` when the versions differ.
  public static func hello(
    channel: SecureChannel, deviceId: String, traceparent: String,
    protocolVersion: Int = AtriumProtocol.protocolVersion
  ) async throws(RemoteError) -> WelcomeMessage {
    try await channel.sendMessage(
      helloMessage(deviceId: deviceId, traceparent: traceparent, protocolVersion: protocolVersion))
    while true {
      switch try await channel.nextEvent() {
      case .heartbeat, .heartbeatAck: continue
      case .control(let body):
        await channel.close()
        let control = try? RemoteJSON.decode(ControlMessage.self, from: body)
        throw control == .revoked ? .rejected(reason: "revoked", hostProtocol: nil) : .unexpected
      case .message(let body):
        guard let welcome = try? JSONDecoder().decode(WelcomeMessage.self, from: body) else {
          await channel.close()
          throw .badPayload
        }
        guard welcome.protocolVersion == protocolVersion else {
          await channel.close()
          throw .versionMismatch(hostProtocol: welcome.protocolVersion)
        }
        return welcome
      }
    }
  }

  /// Runs the two handshake messages as initiator and wraps the result in a channel.
  ///
  /// - Remark: The reply's payload is authenticated by the host's static key, so a refusal in it can
  ///   be trusted (SPEC-0005 "配对流程" step 2); the channel is returned either way so the caller
  ///   closes it after a refusal.
  /// - SideEffects: Sends and receives on `transport`; closes it on failure.
  /// - Parameters:
  ///   - mode: IK or IKpsk2.
  ///   - hostId: The host id, for the prologue.
  ///   - hostKey: The host's static key.
  ///   - psk: The PSK for IKpsk2.
  ///   - deviceKey: This phone's static key.
  ///   - payload: Message 1's payload.
  ///   - transport: The connection.
  ///   - stopwatch: The injected clock.
  /// - Returns: Message 2's payload and the channel.
  /// - Throws: ``RemoteError``.
  private static func handshake(
    mode: HandshakeMode,
    hostId: String,
    hostKey: Data,
    psk: Data?,
    deviceKey: Curve25519.KeyAgreement.PrivateKey,
    payload: Data,
    transport: any RemoteTransport,
    stopwatch: Stopwatch
  ) async throws(RemoteError) -> (HandshakeReply, SecureChannel) {
    let handshake: NoiseHandshake
    let first: Data
    do {
      handshake = try NoiseHandshake(
        pattern: mode.pattern, role: .initiator, prologue: AtriumWire.prologue(hostId: hostId),
        localStatic: deviceKey, remoteStatic: hostKey, psk: psk)
      first = try handshake.writeMessage(payload: payload)
    } catch {
      transport.close()
      throw .noise(error)
    }
    let second: Data
    do {
      try await transport.send(AtriumWire.firstFrame(mode: mode, noiseMessage: first))
      second = try await transport.receive()
    } catch {
      transport.close()
      throw .transport(error)
    }
    let replyBytes: Data
    let result: NoiseHandshakeResult
    do {
      replyBytes = try handshake.readMessage(second)
      result = try handshake.split()
    } catch {
      transport.close()
      throw .noise(error)
    }
    let channel = SecureChannel(
      transport: transport, noise: result.transport, handshakeHash: result.handshakeHash, stopwatch: stopwatch)
    do {
      return (try RemoteJSON.decode(HandshakeReply.self, from: replyBytes), channel)
    } catch {
      await channel.close()
      throw error
    }
  }
}

/// The remote `hello`, until the generated type allows leaving out `token`.
///
/// - Remark: See ``RemoteHandshake/helloMessage(deviceId:traceparent:protocolVersion:)``.
struct RemoteHello: Encodable {
  var type = "hello"
  var protocolVersion: Int
  var clientId: String
  var traceparent: String
}

/// A fresh W3C `traceparent` for `hello` (observability.md: the host continues the trace from it).
///
/// - Remark: Random ids, sampled flag set, as the desktop sends.
/// - SideEffects: none (reads the system random source)
/// - Returns: `00-<32 hex>-<16 hex>-01`.
public func makeTraceparent() -> String {
  let hex = { (count: Int) in (0..<count).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() }
  return "00-\(hex(16))-\(hex(8))-01"
}
