/// Why a Noise handshake or transport operation failed.
///
/// - Remarks: Every failure is terminal: the handshake or transport that threw refuses
///   every later call with ``invalidated`` (SPEC-0005 "Noise 通道": a failed decrypt closes
///   the channel). Cases carry no key material, so they are safe to log.
public enum NoiseError: Error, Equatable, Sendable {
    /// A method was called in the wrong order, for example reading when it is our turn to write.
    case invalidState
    /// An earlier call failed; this object can no longer be used.
    case invalidated
    /// A key or pre-shared key has the wrong length, or a required one is missing.
    case invalidArgument
    /// The message is longer than Noise's 65535-byte limit.
    case messageTooLong
    /// The message ends before every token of the pattern has been read.
    case messageTooShort
    /// A handshake payload is longer than Atrium's 1 KiB limit, or a transport payload
    /// does not fit into one Noise message.
    case payloadTooLong
    /// Authenticated decryption failed: the message was changed, replayed, reordered or
    /// encrypted under different keys.
    case decryptFailed
    /// A Diffie-Hellman result was all zeros, or CryptoKit rejected the public key.
    case lowOrderPublicKey
    /// The nonce reached 2^64 - 1, which Noise reserves.
    case nonceExhausted
}
