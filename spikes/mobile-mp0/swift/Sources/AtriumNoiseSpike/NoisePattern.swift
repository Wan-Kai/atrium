/// The two Noise protocols Atrium speaks (SPEC-0005 "Noise 通道 · 模式").
///
/// - Remarks: Only these two are written out, as fixed token lists, instead of a general
///   pattern parser: less code to get wrong, and nothing else is needed.
public enum NoisePattern: Sendable, CaseIterable {
    /// `Noise_IK_25519_ChaChaPoly_SHA256`, for daily connections.
    case ik
    /// `Noise_IKpsk2_25519_ChaChaPoly_SHA256`, for pairing.
    case ikpsk2

    /// The full Noise protocol name, hashed into `h`.
    public var protocolName: String {
        switch self {
        case .ik: "Noise_IK_25519_ChaChaPoly_SHA256"
        case .ikpsk2: "Noise_IKpsk2_25519_ChaChaPoly_SHA256"
        }
    }

    /// Whether the pattern mixes a pre-shared key (which also makes `e` call `MixKey`).
    var usesPSK: Bool { self == .ikpsk2 }

    /// The tokens of each handshake message, in order. Message 0 is initiator → responder.
    var messages: [[Token]] {
        switch self {
        case .ik: [[.e, .es, .s, .ss], [.e, .ee, .se]]
        case .ikpsk2: [[.e, .es, .s, .ss], [.e, .ee, .se, .psk]]
        }
    }

    /// A Noise handshake token (Noise §7.1, §9).
    enum Token {
        case e, s, ee, es, se, ss, psk
    }
}

/// Which side of the handshake this party is.
public enum NoiseRole: Sendable {
    /// Sends the first message; the phone.
    case initiator
    /// Answers it; the Mac.
    case responder
}
