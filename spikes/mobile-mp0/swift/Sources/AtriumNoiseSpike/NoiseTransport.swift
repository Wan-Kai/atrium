import Foundation

/// The two transport cipher states after a handshake: one for sending, one for receiving.
///
/// - Remarks: Nonces are the implicit Noise counters, starting at 0 in each direction; a lost,
///   replayed or reordered message fails to decrypt (SPEC-0005 "传输"). Any failure invalidates
///   both directions. No rekey (SPEC-0005: not used; the nonce limit is unreachable in practice).
/// - Side effects: none.
public final class NoiseTransport {
    /// The largest plaintext that fits one Noise message with its 16-byte tag.
    public static let maxPlaintextLength = NoiseHandshake.maxMessageLength - 16

    var sendCipher: CipherState
    var receiveCipher: CipherState
    private var invalidated = false

    /// Wraps the cipher states from `Split`.
    ///
    /// - Side effects: none.
    init(send: CipherState, receive: CipherState) {
        sendCipher = send
        receiveCipher = receive
    }

    /// Encrypts one outgoing transport message.
    ///
    /// - Side effects: none.
    /// - Returns: Ciphertext with the tag, at most 65535 bytes.
    /// - Throws: ``NoiseError/payloadTooLong``, ``NoiseError/nonceExhausted`` or ``NoiseError/invalidated``.
    public func encrypt(_ plaintext: Data) throws(NoiseError) -> Data {
        guard !invalidated else { throw .invalidated }
        do throws(NoiseError) {
            guard plaintext.count <= Self.maxPlaintextLength else { throw NoiseError.payloadTooLong }
            return try sendCipher.encryptWithAd(Data(), plaintext)
        } catch {
            invalidated = true
            throw error
        }
    }

    /// Decrypts one incoming transport message.
    ///
    /// - Side effects: none.
    /// - Returns: The plaintext.
    /// - Throws: ``NoiseError/decryptFailed``, ``NoiseError/messageTooLong``,
    ///   ``NoiseError/nonceExhausted`` or ``NoiseError/invalidated``.
    public func decrypt(_ message: Data) throws(NoiseError) -> Data {
        guard !invalidated else { throw .invalidated }
        do throws(NoiseError) {
            guard message.count <= NoiseHandshake.maxMessageLength else { throw NoiseError.messageTooLong }
            return try receiveCipher.decryptWithAd(Data(), message)
        } catch {
            invalidated = true
            throw error
        }
    }
}
