import CryptoKit
import Foundation

/// The 6-digit code both screens show during pairing (SPEC-0005 "配对流程" step 4).
///
/// - Remark: About 20 bits, for a person to compare; it never replaces the PSK and the key
///   confirmation.
public enum PairingCode {
  /// `SHA-256("atrium-sas-v1" ‖ h)`, first 4 bytes big-endian, mod 10⁶, zero-padded to 6 digits.
  ///
  /// - Remark: `h` is the hash at the end of the handshake, which both sides share.
  /// - SideEffects: none
  /// - Parameter handshakeHash: The final `h`.
  /// - Returns: Six digits.
  public static func digits(handshakeHash: Data) -> String {
    let digest = Array(SHA256.hash(data: Data("atrium-sas-v1".utf8) + handshakeHash))
    let value = digest[0..<4].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
    let code = String(value % 1_000_000)
    return String(repeating: "0", count: 6 - code.count) + code
  }

  /// The code as shown on screen: two groups of three, `123 456`.
  ///
  /// - Remark: The desktop groups it the same way (SPEC-0005 "配对流程" step 4).
  /// - SideEffects: none
  /// - Parameter digits: Six digits.
  /// - Returns: The grouped code.
  public static func display(_ digits: String) -> String {
    "\(digits.prefix(3)) \(digits.suffix(3))"
  }
}
