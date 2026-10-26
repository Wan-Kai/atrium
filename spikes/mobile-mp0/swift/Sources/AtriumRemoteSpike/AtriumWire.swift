import AtriumNoiseSpike
import Foundation

/// Which Noise pattern a phone asks for in its first frame (SPEC-0005 "手机的第一帧").
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
public enum AtriumWire {
    /// First byte of the phone's first frame, ASCII `A`.
    public static let magic: UInt8 = 0x41
    /// Wire version; a host that does not know it closes instead of falling back.
    public static let version: UInt8 = 0x01

    /// The Noise prologue: `atrium-remote/1`, NUL, the host id, NUL.
    ///
    /// - Remarks: Binds the handshake to this host id; a phone talking to the wrong host
    ///   fails the handshake. The mode is not repeated here because the protocol name is
    ///   already hashed.
    /// - Side effects: none.
    public static func prologue(hostId: String) -> Data {
        Data("atrium-remote/1".utf8) + [0] + Data(hostId.utf8) + [0]
    }

    /// Prefixes handshake message 1 with the 3-byte header: magic, version, mode.
    ///
    /// - Side effects: none.
    public static func firstFrame(mode: HandshakeMode, noiseMessage: Data) -> Data {
        Data([magic, version, mode.rawValue]) + noiseMessage
    }

    /// Splits the phone's first frame into its mode and handshake message 1 (the host's side).
    ///
    /// - Side effects: none.
    /// - Throws: ``RemoteError/badFirstFrame`` when the frame is shorter than the header, or the
    ///   magic, version or mode is not known.
    public static func parseFirstFrame(_ frame: Data) throws(RemoteError) -> (HandshakeMode, Data) {
        let bytes = [UInt8](frame.prefix(3))
        guard bytes.count == 3, bytes[0] == magic, bytes[1] == version, let mode = HandshakeMode(rawValue: bytes[2])
        else { throw .badFirstFrame }
        return (mode, Data(frame.dropFirst(3)))
    }
}
