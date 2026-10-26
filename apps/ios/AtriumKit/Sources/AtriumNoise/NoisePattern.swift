/// The two Noise protocols the app speaks with the host (SPEC-0005 "Noise 通道 · 模式").
///
/// - Remark: ADR-0016 fixes IK for daily connections and IKpsk2 for pairing, both on X25519,
///   ChaChaPoly and SHA-256. Only these two are written out, as fixed token lists, instead of a
///   general pattern parser: less code to get wrong, and nothing else is needed. The name is mixed
///   into the handshake hash, so it must match the host's byte for byte.
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

  /// The tokens of each handshake message in order, message 0 being initiator → responder.
  var messages: [[Token]] {
    switch self {
    case .ik: [[.e, .es, .s, .ss], [.e, .ee, .se]]
    case .ikpsk2: [[.e, .es, .s, .ss], [.e, .ee, .se, .psk]]
    }
  }

  /// A Noise handshake token (Noise §7.1, §9).
  ///
  /// - Remark: Internal: callers pick a pattern, never tokens.
  enum Token {
    case e
    case s
    case ee
    case es
    case se
    case ss
    case psk
  }
}

/// Which side of the handshake this party is.
///
/// - Remark: The phone always starts (SPEC-0005 "模式"); the responder role exists for tests and
///   the interop records, which play the host.
public enum NoiseRole: Sendable {
  /// Sends the first message; the phone.
  case initiator
  /// Answers it; the Mac.
  case responder
}
