import Foundation

/// Delivers at most one pairing candidate during a scanner presentation.
///
/// - Remark: Full credential validation remains in PairingLink; payloads are never logged.
struct PairingCodeCapture {
  private var delivered = false

  /// Consumes a candidate without interpreting its credentials.
  ///
  /// - Remark: Irrelevant QR codes must leave capture running.
  /// - SideEffects: Marks the first candidate as delivered.
  /// - Parameter text: The scanned text.
  /// - Returns: The first pairing candidate, or nil.
  mutating func accept(_ text: String) -> String? {
    guard !delivered, let url = URLComponents(string: text),
      url.scheme?.lowercased() == "atrium", url.host?.lowercased() == "pair"
    else { return nil }
    delivered = true
    return text
  }
}
