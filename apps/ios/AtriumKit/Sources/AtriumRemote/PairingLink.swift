import Foundation

/// Recognises the links the pairing QR code holds.
///
/// - Remark: The scanner only accepts `atrium://pair` (SPEC-0005 "扫码"), so a QR code for
///   anything else never reaches the pairing flow. Reading the link's parameters comes with
///   pairing in MP4.
public enum PairingLink {
  /// Tells whether a scanned URL is a pairing link.
  ///
  /// - Remark: Scheme and host are compared without regard to case, as URLs define them.
  /// - SideEffects: none
  /// - Parameter url: The scanned URL.
  /// - Returns: Whether it is `atrium://pair`, with or without a query.
  public static func matches(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "atrium" && url.host()?.lowercased() == "pair" && url.path().isEmpty
  }
}
