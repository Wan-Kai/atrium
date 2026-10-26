import Foundation

/// The Atrium protocol version this spike announces.
///
/// - Remarks: `PROTOCOL_VERSION` in `packages/protocol/src/version.ts` on 2026-10-25. SPEC-0005
///   bumps it by one when the remote changes land; the spike stays on today's value so the TS
///   fake host can import it unchanged.
public let atriumProtocolVersion = 25

/// Handshake message 1 payload when pairing (SPEC-0005 "配对流程" step 2).
public struct PairRequest: Codable, Equatable, Sendable {
    public var kind = "pair"
    public var pairingId: String
    public var deviceName: String
    public var model: String
    public var appVersion: String
    public var protocolVersion: Int

    /// Builds the payload.
    ///
    /// - Side effects: none.
    public init(pairingId: String, deviceName: String, model: String, appVersion: String, protocolVersion: Int) {
        self.pairingId = pairingId
        self.deviceName = deviceName
        self.model = model
        self.appVersion = appVersion
        self.protocolVersion = protocolVersion
    }
}

/// Handshake message 1 payload for a daily connection (SPEC-0005 "日常连接" step 1).
public struct ConnectRequest: Codable, Equatable, Sendable {
    public var kind = "connect"
    public var appVersion: String
    public var protocolVersion: Int

    /// Builds the payload.
    ///
    /// - Side effects: none.
    public init(appVersion: String, protocolVersion: Int) {
        self.appVersion = appVersion
        self.protocolVersion = protocolVersion
    }
}

/// Handshake message 2 payload, for both pairing and daily connections.
public struct HandshakeReply: Codable, Equatable, Sendable {
    public var ok: Bool
    public var reason: String?
    public var deviceId: String?
    public var hostProtocol: Int?

    /// Builds the payload.
    ///
    /// - Side effects: none.
    public init(ok: Bool, reason: String? = nil, deviceId: String? = nil, hostProtocol: Int? = nil) {
        self.ok = ok
        self.reason = reason
        self.deviceId = deviceId
        self.hostProtocol = hostProtocol
    }
}

/// A channel control message, frame type 0x04 (SPEC-0005 "分帧").
public enum ControlMessage: Codable, Equatable, Sendable {
    /// Phone → host: key confirmation, the first transport message when pairing.
    case pairConfirm
    /// Host → phone: the user confirmed on the Mac.
    case paired(deviceId: String, hostName: String)
    /// Host → phone: pairing refused, with a code such as `pairing_busy` or `host_error`.
    case pairRejected(reason: String)
    /// Host → phone: this device was revoked.
    case revoked

    private enum CodingKeys: String, CodingKey {
        case kind, deviceId, hostName, reason
    }

    /// Decodes by `kind`.
    ///
    /// - Side effects: none.
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
    /// - Side effects: none.
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

/// Atrium's `hello` over a remote channel: no `token`, `clientId` = `deviceId` (SPEC-0005 "协议改动" 1).
public struct HelloMessage: Codable, Equatable, Sendable {
    public var type = "hello"
    public var protocolVersion: Int
    public var clientId: String
    public var traceparent: String

    /// Builds the message.
    ///
    /// - Side effects: none.
    public init(protocolVersion: Int, clientId: String, traceparent: String) {
        self.protocolVersion = protocolVersion
        self.clientId = clientId
        self.traceparent = traceparent
    }
}

/// The fields of Atrium's `welcome` the spike shows.
public struct WelcomeMessage: Codable, Equatable, Sendable {
    public var type: String
    public var protocolVersion: Int
    public var hostVersion: String?
    public var hostInstanceId: String?
    public var heartbeatMs: Int?
}

/// JSON coding shared by both sides of the spike.
///
/// - Remarks: Sorted keys and unescaped slashes so the bytes are deterministic, which the
///   interop records rely on.
public enum RemoteJSON {
    /// Encodes `value` deterministically.
    ///
    /// - Side effects: none.
    public static func encode<T: Encodable>(_ value: T) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Only our own Codable types, which cannot fail to encode.
        return try! encoder.encode(value)
    }

    /// Decodes `type` from `data`.
    ///
    /// - Side effects: none.
    /// - Throws: ``RemoteError/badPayload``.
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws(RemoteError) -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw .badPayload
        }
    }
}

/// A fresh W3C `traceparent` for `hello` (observability.md: the host continues the trace from it).
///
/// - Side effects: none (reads the system random source).
public func makeTraceparent() -> String {
    let hex = { (count: Int) in (0..<count).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() }
    return "00-\(hex(16))-\(hex(8))-01"
}
