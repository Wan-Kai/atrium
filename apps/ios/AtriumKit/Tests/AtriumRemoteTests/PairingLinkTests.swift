import AtriumRemote
import Foundation
import Testing

/// A link with every parameter valid, with `override` replacing or dropping one.
///
/// - Remark: Each bad-link case changes one thing from a good link.
/// - SideEffects: none
/// - Parameter override: `name=value` to replace, or `name=` with `drop` to remove.
/// - Returns: The link.
func link(_ override: (String, String?)? = nil) -> String {
  let key = Data((0..<32).map { UInt8($0) }).base64URL
  let psk = Data((0..<32).map { UInt8(255 - $0) }).base64URL
  var items: [(String, String)] = [
    ("v", "1"), ("relay", "wss://ktoon.site/atrium"), ("host", "hst_0123456789abcdef"), ("key", key),
    ("pairing", "pair_00000000000000a1"), ("psk", psk), ("name", "Ktoon%E7%9A%84MacBook"),
  ]
  if let (name, value) = override {
    items = items.compactMap { $0.0 == name ? value.map { (name, $0) } : $0 }
    if !items.contains(where: { $0.0 == name }), let value { items.append((name, value)) }
  }
  return "atrium://pair?" + items.map { "\($0.0)=\($0.1)" }.joined(separator: "&")
}

@Suite("Pairing link")
struct PairingLinkTests {
  @Test(
    "matches atrium://pair, with or without a query, in any case",
    arguments: [
      "atrium://pair", "atrium://pair?h=abc&k=def", "ATRIUM://Pair",
    ])
  func accepts(_ text: String) throws {
    #expect(PairingLink.matches(try #require(URL(string: text))))
  }

  @Test(
    "does not match anything else",
    arguments: [
      "https://pair", "atrium://pairing", "atrium://pair/x", "atrium:pair", "atrium://other?pair",
    ])
  func refuses(_ text: String) throws {
    #expect(!PairingLink.matches(try #require(URL(string: text))))
  }

  @Test("reads every parameter of a valid link, trimming whitespace")
  func parses() throws {
    let parsed = try PairingLink("  \(link())\n")
    #expect(parsed.relay.absoluteString == "wss://ktoon.site/atrium")
    #expect(parsed.hostId == "hst_0123456789abcdef")
    #expect(parsed.hostKey == Data((0..<32).map { UInt8($0) }))
    #expect(parsed.psk == Data((0..<32).map { UInt8(255 - $0) }))
    #expect(parsed.pairingId == "pair_00000000000000a1")
    #expect(parsed.hostName == "Ktoon的MacBook")
    #expect(try PairingLink(link(("name", nil))).hostName == "")
    #expect(try PairingLink(link(("relay", "ws://127.0.0.1:8787"))).relay.port == 8787)
  }

  @Test(
    "refuses a link with any parameter wrong, missing or repeated",
    arguments: [
      ("v", "2"), ("v", nil), ("relay", "http://a"), ("relay", "wss://"), ("relay", "wss://a/b?x=1"), ("relay", nil),
      ("host", "hst_0123"), ("host", "hst_0123456789ABCDEF"), ("host", "h%00x"), ("host", nil),
      ("key", "AAAA"), ("key", "!!!!AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), ("key", nil),
      ("pairing", ""), ("pairing", "pair_0123456789ABCDEF"), ("pairing", "pairing_0123456789abcdef"),
      ("pairing", nil), ("psk", "AAAA"), ("psk", nil), ("extra", "1&v=1"),
    ] as [(String, String?)])
  func refusesBadLinks(name: String, value: String?) {
    #expect(throws: PairingLinkError.invalid) { try PairingLink(link((name, value))) }
  }

  @Test("refuses other schemes and hosts")
  func refusesOtherLinks() {
    #expect(throws: PairingLinkError.invalid) {
      try PairingLink(link().replacingOccurrences(of: "atrium:", with: "https:"))
    }
    #expect(throws: PairingLinkError.invalid) { try PairingLink("atrium://pairing?v=1") }
    #expect(throws: PairingLinkError.invalid) { try PairingLink("not a link") }
  }

  @Test("builds the client endpoint under the relay's path prefix")
  func endpoint() throws {
    let base = try #require(URL(string: "wss://ktoon.site/atrium"))
    #expect(
      clientEndpoint(relay: base, hostId: "hst_1")?.absoluteString == "wss://ktoon.site/atrium/v1/client?host=hst_1")
    let slash = try #require(URL(string: "ws://127.0.0.1:8787/"))
    #expect(clientEndpoint(relay: slash, hostId: "hst_1")?.absoluteString == "ws://127.0.0.1:8787/v1/client?host=hst_1")
  }

  @Test("base64url round-trips, with or without padding")
  func base64URL() {
    let bytes = Data([0xfb, 0xff, 0xfe, 0x00])
    #expect(bytes.base64URL == "-__-AA")
    #expect(Data(base64URL: "-__-AA") == bytes)
    #expect(Data(base64URL: "-__-AA==") == bytes)
    #expect(Data(base64URL: "+//+AA") == nil)
  }
}
