/// The two Noise protocols the app speaks with the host, by their full names.
///
/// - Remark: ADR-0016 fixes the handshake to IK for daily connections and IKpsk2 for pairing, both
///   on X25519, ChaChaPoly and SHA-256; the name is mixed into the handshake hash, so it must match
///   the host's byte for byte. The handshake itself comes in MP0.
public enum NoiseSuite: String, Sendable, CaseIterable {
  /// Daily connections from a paired phone.
  case ik = "Noise_IK_25519_ChaChaPoly_SHA256"
  /// The first connection, with the pairing key as the PSK.
  case ikpsk2 = "Noise_IKpsk2_25519_ChaChaPoly_SHA256"
}
