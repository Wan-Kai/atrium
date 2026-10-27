import Foundation

/// Formats the relay's last-seen value without consulting the current time.
///
/// - Remark: Both connection and pairing screens preserve an unknown value instead of inventing one.
enum PairingLastSeen {
  /// Describes the supplied absolute timestamp in the viewer's locale and time zone.
  ///
  /// - Remark: Explicit locale and zone make formatting deterministic in tests.
  /// - SideEffects: none
  /// - Parameters:
  ///   - date: The relay-provided timestamp, if known.
  ///   - locale: The display locale.
  ///   - timeZone: The display time zone.
  /// - Returns: A last-seen label, never a relative estimate.
  static func message(_ date: Date?, locale: Locale, timeZone: TimeZone) -> String {
    guard let date else { return "上次在线时间未知" }
    let style = Date.FormatStyle(date: .abbreviated, time: .standard, locale: locale, timeZone: timeZone)
    return "上次在线：\(date.formatted(style))"
  }
}
