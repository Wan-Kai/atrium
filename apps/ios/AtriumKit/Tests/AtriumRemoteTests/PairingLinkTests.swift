import AtriumRemote
import Foundation
import Testing

@Suite("Pairing link")
struct PairingLinkTests {
  @Test("takes atrium://pair, with or without a query, in any case", arguments: [
    "atrium://pair", "atrium://pair?h=abc&k=def", "ATRIUM://Pair",
  ])
  func accepts(_ text: String) throws {
    #expect(PairingLink.matches(try #require(URL(string: text))))
  }

  @Test("refuses anything else", arguments: [
    "https://pair", "atrium://pairing", "atrium://pair/x", "atrium:pair", "atrium://other?pair",
  ])
  func refuses(_ text: String) throws {
    #expect(!PairingLink.matches(try #require(URL(string: text))))
  }
}
