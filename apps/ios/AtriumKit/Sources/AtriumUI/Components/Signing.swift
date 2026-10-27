import Foundation

/// When the App's free-account signature runs out, and how the drawer says so.
///
/// - Remark: SPEC-0005 "MP6 定的细节 · MP6b": a Personal Team signs for 7 days; the date is the
///   `ExpirationDate` of the profile the App carries (`embedded.mobileprovision`, a signed wrapper
///   around a plist). Without one (the simulator, an App Store build) nothing is shown. Time comes
///   from the caller, so the words can be tested.
nonisolated enum Signing {
  /// The App's own profile's expiry, if it carries one.
  ///
  /// - Remark: Read once per call; cheap enough for the drawer.
  /// - SideEffects: Reads a file of the App's bundle.
  /// - Returns: The date.
  static func appExpiry() -> Date? {
    guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
      let data = try? Data(contentsOf: url)
    else { return nil }
    return expiry(fromProfile: data)
  }

  /// A profile's expiry.
  ///
  /// - Remark: The plist is found between `<?xml` (or `<plist`) and `</plist>` inside the
  ///   signature's wrapper, whose bytes are not checked.
  /// - SideEffects: none
  /// - Parameter data: The profile's bytes.
  /// - Returns: The date, or `nil` when there is no readable plist with one.
  static func expiry(fromProfile data: Data) -> Date? {
    let start = data.range(of: Data("<?xml".utf8)) ?? data.range(of: Data("<plist".utf8))
    guard let start, let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex) else {
      return nil
    }
    let plist = data.subdata(in: start.lowerBound..<end.upperBound)
    guard let object = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any] else {
      return nil
    }
    return object["ExpirationDate"] as? Date
  }

  /// Whole days left until the expiry.
  ///
  /// - Remark: Negative once it passed.
  /// - SideEffects: none
  /// - Parameters:
  ///   - expiry: When it runs out.
  ///   - now: The time now.
  /// - Returns: The days.
  static func daysLeft(expiry: Date, now: Date) -> Int {
    let seconds = expiry.timeIntervalSince(now)
    return seconds < 0 ? -1 : Int(seconds / 86_400)
  }

  /// The drawer's words: "签名还剩 N 天", "签名今天到期" or "签名已过期".
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - expiry: When it runs out.
  ///   - now: The time now.
  /// - Returns: The words.
  static func text(expiry: Date, now: Date) -> String {
    switch daysLeft(expiry: expiry, now: now) {
    case ..<0: "签名已过期"
    case 0: "签名今天到期"
    case let days: "签名还剩 \(days) 天"
    }
  }

  /// Whether to warn: a day or less left.
  ///
  /// - Remark: The menu key gets an orange dot and the tag turns orange.
  /// - SideEffects: none
  /// - Parameters:
  ///   - expiry: When it runs out.
  ///   - now: The time now.
  /// - Returns: Whether to warn.
  static func soon(expiry: Date, now: Date) -> Bool {
    daysLeft(expiry: expiry, now: now) <= 1
  }
}
