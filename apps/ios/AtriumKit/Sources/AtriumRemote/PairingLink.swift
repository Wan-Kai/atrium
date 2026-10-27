import Foundation

/// The contents of the pairing QR code (SPEC-0005 "配对流程" step 1).
///
/// - Remark: `atrium://pair?v=1&relay=<ws(s) URL>&host=<hostId>&key=<b64url>&pairing=<id>&psk=<b64url>&name=<Mac name>`.
///   The scanner only accepts `atrium://pair` (SPEC-0005 "扫码"), so a QR code for anything else
///   never reaches the pairing flow.
public struct PairingLink: Equatable, Sendable {
  /// The relay's base URL, `ws://` or `wss://`, with its path prefix.
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

  /// Tells whether a scanned URL is a pairing link, before reading its parameters.
  ///
  /// - Remark: Scheme and host are compared without regard to case, as URLs define them.
  /// - SideEffects: none
  /// - Parameter url: The scanned URL.
  /// - Returns: Whether it is `atrium://pair`, with or without a query.
  public static func matches(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "atrium" && url.host()?.lowercased() == "pair" && url.path().isEmpty
  }

  /// Parses a pasted or scanned link.
  ///
  /// - Remark: Strict: every parameter once, `v=1`, 32-byte keys, `hst_<16hex>` and `pair_<16hex>`
  ///   ids (the relay's and host's formats), so a mangled paste fails here and not mid-handshake.
  /// - SideEffects: none
  /// - Parameter text: The link.
  /// - Throws: ``PairingLinkError/invalid``.
  public init(_ text: String) throws(PairingLinkError) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), Self.matches(url),
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { throw .invalid }
    var query: [String: String] = [:]
    for item in components.queryItems ?? [] {
      guard query[item.name] == nil, let value = item.value else { throw .invalid }
      query[item.name] = value
    }
    guard query["v"] == "1",
      let relayText = query["relay"], let relay = URL(string: relayText),
      relay.scheme == "ws" || relay.scheme == "wss", relay.host() != nil, relay.query() == nil,
      let hostId = query["host"], Self.isHexId(hostId, prefix: "hst_"),
      let key = query["key"].flatMap(Data.init(base64URL:)), key.count == 32,
      let pairingId = query["pairing"], Self.isHexId(pairingId, prefix: "pair_"),
      let psk = query["psk"].flatMap(Data.init(base64URL:)), psk.count == 32
    else { throw .invalid }
    self.relay = relay
    self.hostId = hostId
    self.hostKey = key
    self.pairingId = pairingId
    self.psk = psk
    self.hostName = query["name"] ?? ""
  }

  /// Whether `id` is `prefix` and 16 lower-case hex digits.
  ///
  /// - Remark: `hostId` must also be plain ASCII because the prologue uses NUL as a separator and
  ///   both sides must hash the same bytes; this format guarantees it.
  /// - SideEffects: none
  /// - Parameters:
  ///   - id: The id.
  ///   - prefix: `hst_` or `pair_`.
  /// - Returns: Whether it matches.
  static func isHexId(_ id: String, prefix: String) -> Bool {
    let digits = id.utf8.dropFirst(prefix.utf8.count)
    return id.hasPrefix(prefix) && digits.count == 16
      && digits.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
  }
}

/// Why a pairing link was refused.
///
/// - Remark: One case: the screen only says "这不是 Atrium 的配对链接".
public enum PairingLinkError: Error, Equatable, Sendable {
  /// Not an `atrium://pair` link with every parameter valid.
  case invalid
}

/// Builds the phone's relay endpoint, `<relay>/v1/client?host=<hostId>` (SPEC-0005 "relay 的线路协议").
///
/// - Remark: Keeps the relay's path prefix (`/atrium` on the user's VPS).
/// - SideEffects: none
/// - Parameters:
///   - relay: The relay's base URL from the QR code.
///   - hostId: The host id.
/// - Returns: The endpoint, or `nil` when `relay` cannot carry a path and query.
public func clientEndpoint(relay: URL, hostId: String) -> URL? {
  guard var components = URLComponents(url: relay, resolvingAgainstBaseURL: false) else { return nil }
  let base = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
  components.path = base + "/v1/client"
  components.queryItems = [URLQueryItem(name: "host", value: hostId)]
  return components.url
}

extension Data {
  /// Decodes base64url with or without padding; `nil` when malformed.
  ///
  /// - Remark: The QR code writes keys without padding.
  /// - SideEffects: none
  /// - Parameter text: The text.
  public init?(base64URL text: String) {
    guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "-_=".contains($0)) }) else { return nil }
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while base64.hasSuffix("=") { base64.removeLast() }
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    self.init(base64Encoded: base64)
  }

  /// Encodes as base64url without padding.
  public var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
