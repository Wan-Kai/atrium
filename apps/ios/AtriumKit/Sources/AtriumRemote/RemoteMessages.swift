import Foundation

/// Handshake message 1 payload when pairing (SPEC-0005 "配对流程" step 2).
///
/// - Remark: Channel-level, not part of the Atrium protocol, so not generated.
public struct PairRequest: Codable, Equatable, Sendable {
  /// Always `pair`.
  public var kind = "pair"
  /// The pairing id from the QR code.
  public var pairingId: String
  /// The phone's name, `UIDevice.current.name` by default.
  public var deviceName: String
  /// The hardware model, such as `iPhone17,1`.
  public var model: String
  /// The app's version.
  public var appVersion: String
  /// The Atrium protocol version the app speaks.
  public var protocolVersion: Int

  /// Builds the payload.
  ///
  /// - Remark: Memberwise.
  /// - SideEffects: none
  /// - Parameters:
  ///   - pairingId: From the QR code.
  ///   - deviceName: The phone's name.
  ///   - model: The hardware model.
  ///   - appVersion: The app's version.
  ///   - protocolVersion: The protocol version.
  public init(pairingId: String, deviceName: String, model: String, appVersion: String, protocolVersion: Int) {
    self.pairingId = pairingId
    self.deviceName = deviceName
    self.model = model
    self.appVersion = appVersion
    self.protocolVersion = protocolVersion
  }
}

/// Handshake message 1 payload for a daily connection (SPEC-0005 "日常连接" step 1).
///
/// - Remark: Channel-level, like ``PairRequest``.
public struct ConnectRequest: Codable, Equatable, Sendable {
  /// Always `connect`.
  public var kind = "connect"
  /// The app's version.
  public var appVersion: String
  /// The Atrium protocol version the app speaks.
  public var protocolVersion: Int

  /// Builds the payload.
  ///
  /// - Remark: Memberwise.
  /// - SideEffects: none
  /// - Parameters:
  ///   - appVersion: The app's version.
  ///   - protocolVersion: The protocol version.
  public init(appVersion: String, protocolVersion: Int) {
    self.appVersion = appVersion
    self.protocolVersion = protocolVersion
  }
}

/// Handshake message 2 payload, for both pairing and daily connections.
///
/// - Remark: Authenticated by the host's static key (and the PSK when pairing), so a refusal in it
///   can be trusted (SPEC-0005 "配对流程" step 2).
public struct HandshakeReply: Codable, Equatable, Sendable {
  /// Whether the host accepts.
  public var ok: Bool
  /// Why not: `device_unknown`, `version_mismatch`, `pairing_expired`, `pairing_busy`.
  public var reason: String?
  /// The phone's id on a daily connection.
  public var deviceId: String?
  /// The host's protocol version with `version_mismatch`.
  public var hostProtocol: Int?

  /// Builds the payload.
  ///
  /// - Remark: Tests play the host with it.
  /// - SideEffects: none
  /// - Parameters:
  ///   - ok: Whether the host accepts.
  ///   - reason: Why not.
  ///   - deviceId: The phone's id.
  ///   - hostProtocol: The host's protocol version.
  public init(ok: Bool, reason: String? = nil, deviceId: String? = nil, hostProtocol: Int? = nil) {
    self.ok = ok
    self.reason = reason
    self.deviceId = deviceId
    self.hostProtocol = hostProtocol
  }
}

/// A channel control message, frame type 0x04 (SPEC-0005 "分帧").
///
/// - Remark: Written by hand: the four kinds live below the Atrium protocol.
public enum ControlMessage: Codable, Equatable, Sendable {
  /// Phone → host: key confirmation, the first transport message when pairing.
  case pairConfirm
  /// Host → phone: the user confirmed on the Mac.
  case paired(deviceId: String, hostName: String)
  /// Host → phone: pairing refused, with a code such as `pairing_busy` or `host_error`.
  case pairRejected(reason: String)
  /// Host → phone: this device was revoked.
  case revoked

  /// The JSON keys.
  ///
  /// - Remark: The channel control schema is separate from generated Atrium messages.
  private enum CodingKeys: String, CodingKey {
    case kind
    case deviceId
    case hostName
    case reason
  }

  /// Decodes by `kind`.
  ///
  /// - Remark: An unknown kind is an error; the channel closes on it.
  /// - SideEffects: none
  /// - Parameter decoder: The decoder.
  /// - Throws: `DecodingError`.
  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(String.self, forKey: .kind) {
    case "pair_confirm": self = .pairConfirm
    case "paired":
      self = .paired(
        deviceId: try container.decode(String.self, forKey: .deviceId),
        hostName: try container.decode(String.self, forKey: .hostName))
    case "pair_rejected": self = .pairRejected(reason: try container.decode(String.self, forKey: .reason))
    case "revoked": self = .revoked
    case let kind:
      throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "unknown \(kind)")
    }
  }

  /// Encodes with a `kind` field.
  ///
  /// - Remark: Mirrors ``init(from:)``.
  /// - SideEffects: none
  /// - Parameter encoder: The encoder.
  /// - Throws: `EncodingError`.
  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .pairConfirm: try container.encode("pair_confirm", forKey: .kind)
    case .paired(let deviceId, let hostName):
      try container.encode("paired", forKey: .kind)
      try container.encode(deviceId, forKey: .deviceId)
      try container.encode(hostName, forKey: .hostName)
    case .pairRejected(let reason):
      try container.encode("pair_rejected", forKey: .kind)
      try container.encode(reason, forKey: .reason)
    case .revoked: try container.encode("revoked", forKey: .kind)
    }
  }
}

/// JSON coding of the channel-level messages.
///
/// - Remark: Sorted keys and unescaped slashes so the bytes are deterministic, which the interop
///   records rely on.
public enum RemoteJSON {
  /// Encodes `value` deterministically.
  ///
  /// - Remark: Only our own `Codable` types come here, which cannot fail to encode; a failure still
  ///   surfaces as ``RemoteError/badPayload`` rather than a crash.
  /// - SideEffects: none
  /// - Parameter value: The value.
  /// - Returns: UTF-8 JSON.
  /// - Throws: ``RemoteError/badPayload``.
  public static func encode<T: Encodable>(_ value: T) throws(RemoteError) -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    do {
      return try encoder.encode(value)
    } catch {
      throw .badPayload
    }
  }

  /// Decodes `type` from `data`.
  ///
  /// - Remark: Any decoding error is ``RemoteError/badPayload``; the details are not useful to the user.
  /// - SideEffects: none
  /// - Parameters:
  ///   - type: The type.
  ///   - data: UTF-8 JSON.
  /// - Returns: The value.
  /// - Throws: ``RemoteError/badPayload``.
  public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws(RemoteError) -> T {
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch {
      throw .badPayload
    }
  }
}
