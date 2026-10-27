import Foundation
import Testing

@testable import AtriumUI

/// A provisioning profile as the App's bundle carries it: a signed wrapper around a plist.
///
/// - Remark: The wrapper's bytes stand in for the signature, which is not checked.
/// - SideEffects: none
/// - Parameter expiry: The plist's `ExpirationDate`, as ISO 8601.
/// - Returns: The bytes.
func provisioningProfile(expiry: String) -> Data {
  let plist = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict><key>Name</key><string>iOS Team Provisioning Profile</string>\
    <key>ExpirationDate</key><date>\(expiry)</date></dict></plist>
    """
  return Data([0x30, 0x82, 0x01, 0xFF]) + Data(plist.utf8) + Data([0x00, 0xA0, 0x82])
}

@Suite("Signing")
struct SigningTests {
  @Test("reads the expiry from the profile inside its signed wrapper, and nothing from anything else")
  func expiry() throws {
    let expiry = try #require(Signing.expiry(fromProfile: provisioningProfile(expiry: "2026-11-03T08:00:00Z")))
    #expect(expiry == ISO8601DateFormatter().date(from: "2026-11-03T08:00:00Z"))
    #expect(Signing.expiry(fromProfile: Data("no plist here".utf8)) == nil)
  }

  @Test("counts whole days left, and words today and past expiry")
  func words() throws {
    let expiry = try #require(ISO8601DateFormatter().date(from: "2026-11-03T08:00:00Z"))
    let at = { (iso: String) in try #require(ISO8601DateFormatter().date(from: iso)) }
    #expect(Signing.text(expiry: expiry, now: try at("2026-10-28T08:00:00Z")) == "签名还剩 6 天")
    #expect(Signing.text(expiry: expiry, now: try at("2026-11-02T09:00:00Z")) == "签名今天到期")
    #expect(Signing.text(expiry: expiry, now: try at("2026-11-03T09:00:00Z")) == "签名已过期")
    #expect(!Signing.soon(expiry: expiry, now: try at("2026-11-01T07:00:00Z")))
    #expect(Signing.soon(expiry: expiry, now: try at("2026-11-02T09:00:00Z")))
    #expect(Signing.soon(expiry: expiry, now: try at("2026-11-02T07:00:00Z")))
  }
}
