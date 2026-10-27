import Foundation

/// Which Noise pattern a phone asks for in its first frame (SPEC-0005 "手机的第一帧").
///
/// - Remark: The raw values are the mode byte on the wire.
public enum HandshakeMode: UInt8, Sendable, CaseIterable {
  /// Daily connection.
  case ik = 0x01
  /// Pairing.
  case ikpsk2 = 0x02

  /// The Noise pattern this mode selects.
  public var pattern: NoisePattern {
    switch self {
    case .ik: .ik
    case .ikpsk2: .ikpsk2
    }
  }
}

/// Byte-level constants and helpers of the Atrium Noise channel (SPEC-0005 "Noise 通道").
///
/// - Remark: Kept next to the Noise code so the interop records can check both against the TS side
///   in one place.
public enum AtriumWire {
  /// First byte of the phone's first frame, ASCII `A`.
  public static let magic: UInt8 = 0x41
  /// Wire version; a host that does not know it closes instead of falling back.
  public static let version: UInt8 = 0x01

  /// The Noise prologue: `atrium-remote/1`, NUL, the host id, NUL.
  ///
  /// - Remark: Binds the handshake to this host id; a phone talking to the wrong host fails the
  ///   handshake. The mode is not repeated here because the protocol name is already hashed.
  /// - SideEffects: none
  /// - Parameter hostId: The host's id, ASCII.
  /// - Returns: The prologue bytes.
  public static func prologue(hostId: String) -> Data {
    Data("atrium-remote/1".utf8) + [0] + Data(hostId.utf8) + [0]
  }

  /// Prefixes handshake message 1 with the 3-byte header: magic, version, mode.
  ///
  /// - Remark: Only message 1 has a header; the host's first frame is message 2 as is.
  /// - SideEffects: none
  /// - Parameters:
  ///   - mode: IK or IKpsk2.
  ///   - noiseMessage: Handshake message 1.
  /// - Returns: The WebSocket frame.
  public static func firstFrame(mode: HandshakeMode, noiseMessage: Data) -> Data {
    Data([magic, version, mode.rawValue]) + noiseMessage
  }

  /// Splits the phone's first frame into its mode and handshake message 1 (the host's side).
  ///
  /// - Remark: The phone never calls this; tests and the interop replay play the host with it.
  /// - SideEffects: none
  /// - Parameter frame: The first WebSocket frame.
  /// - Returns: The mode and message 1, starting at index 0.
  /// - Throws: ``WireError/badFirstFrame`` when the frame is shorter than the header, or the magic,
  ///   version or mode is not known.
  public static func parseFirstFrame(_ frame: Data) throws(WireError) -> (HandshakeMode, Data) {
    let bytes = [UInt8](frame.prefix(3))
    guard bytes.count == 3, bytes[0] == magic, bytes[1] == version, let mode = HandshakeMode(rawValue: bytes[2])
    else { throw .badFirstFrame }
    return (mode, Data(frame.dropFirst(3)))
  }
}
