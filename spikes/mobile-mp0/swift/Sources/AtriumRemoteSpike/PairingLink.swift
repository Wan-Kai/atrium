import Foundation

/// The contents of the pairing QR code (SPEC-0005 "配对流程" step 1).
///
/// `atrium://pair?v=1&relay=<ws(s) URL>&host=<hostId>&key=<b64url>&pairing=<id>&psk=<b64url>&name=<Mac name>`
public struct PairingLink: Equatable, Sendable {
    /// The relay's base URL, `ws://` or `wss://`.
    public let relay: URL
    /// The host id, also part of the prologue.
    public let hostId: String
    /// The host's static X25519 public key.
    public let hostKey: Data
    /// This pairing attempt.
    public let pairingId: String
    /// The one-time pre-shared key.
    public let psk: Data
    /// The Mac's name, for display only.
    public let hostName: String

    /// Parses a pasted or scanned link.
    ///
    /// - Remarks: Rejects host ids containing NUL or non-ASCII, because the prologue uses NUL as
    ///   a separator and both sides must hash the same bytes.
    /// - Side effects: none.
    /// - Throws: ``RemoteError/badPairingLink``.
    public init(_ text: String) throws(RemoteError) {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
            components.scheme == "atrium", components.host == "pair"
        else { throw .badPairingLink }
        var query: [String: String] = [:]
        for item in components.queryItems ?? [] {
            guard query[item.name] == nil, let value = item.value else { throw .badPairingLink }
            query[item.name] = value
        }
        guard query["v"] == "1",
            let relayText = query["relay"], let relay = URL(string: relayText),
            relay.scheme == "ws" || relay.scheme == "wss", relay.host != nil,
            let hostId = query["host"], Self.isValidHostId(hostId),
            let key = query["key"].flatMap(Data.init(base64URL:)), key.count == 32,
            let pairingId = query["pairing"], Self.isValidPairingId(pairingId),
            let psk = query["psk"].flatMap(Data.init(base64URL:)), psk.count == 32
        else { throw .badPairingLink }
        self.relay = relay
        self.hostId = hostId
        self.hostKey = key
        self.pairingId = pairingId
        self.psk = psk
        self.hostName = query["name"] ?? ""
    }

    /// Whether `pairingId` is `pair_` and 16 lower-case hex digits (the TS fake host's format).
    ///
    /// - Side effects: none.
    static func isValidPairingId(_ pairingId: String) -> Bool {
        let digits = pairingId.utf8.dropFirst(5)
        return pairingId.hasPrefix("pair_") && digits.count == 16
            && digits.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }

    /// Whether `hostId` is printable ASCII, 1–128 bytes.
    ///
    /// - Side effects: none.
    static func isValidHostId(_ hostId: String) -> Bool {
        (1...128).contains(hostId.utf8.count) && hostId.utf8.allSatisfy { (0x21...0x7e).contains($0) }
    }
}

/// Builds the phone's relay endpoint, `<relay>/v1/client?host=<hostId>` (SPEC-0005 "relay 的线路协议").
///
/// - Side effects: none.
public func clientEndpoint(relay: URL, hostId: String) -> URL {
    var components = URLComponents(url: relay, resolvingAgainstBaseURL: false)!
    let base = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
    components.path = base + "/v1/client"
    components.queryItems = [URLQueryItem(name: "host", value: hostId)]
    return components.url!
}

extension Data {
    /// Decodes base64url with or without padding; `nil` when malformed.
    ///
    /// - Side effects: none.
    public init?(base64URL text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.hasSuffix("=") { base64.removeLast() }
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }

    /// Encodes as base64url without padding.
    ///
    /// - Side effects: none.
    public var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
