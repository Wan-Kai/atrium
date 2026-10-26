import CryptoKit
import Foundation

/// Noise `SymmetricState` for SHA-256: chaining key, handshake hash and a ``CipherState`` (Noise §5.2).
///
/// - Remarks: Internal for the same reason as ``CipherState``: copies would fork the transcript.
/// - Side effects: none.
struct SymmetricState {
    /// Chaining key `ck`.
    private(set) var chainingKey: Data
    /// Handshake hash `h`.
    private(set) var handshakeHash: Data
    /// The cipher used by `EncryptAndHash` / `DecryptAndHash`.
    private(set) var cipher = CipherState()

    /// Starts from the protocol name (Noise `InitializeSymmetric`).
    ///
    /// - Remarks: A name of at most 32 bytes is zero-padded and used as `h` directly; a longer one
    ///   is hashed. `Noise_IK_25519_ChaChaPoly_SHA256` is exactly 32 bytes, the IKpsk2 name is 36.
    /// - Side effects: none.
    init(protocolName: String) {
        let name = Data(protocolName.utf8)
        if name.count <= 32 {
            handshakeHash = name + Data(count: 32 - name.count)
        } else {
            handshakeHash = Data(SHA256.hash(data: name))
        }
        chainingKey = handshakeHash
    }

    /// Mixes DH output or another secret into the chaining key and resets the cipher key (Noise `MixKey`).
    ///
    /// - Side effects: none.
    mutating func mixKey(_ inputKeyMaterial: Data) {
        let outputs = Self.hkdf(chainingKey: chainingKey, inputKeyMaterial: inputKeyMaterial, count: 2)
        chainingKey = outputs[0]
        cipher.initializeKey(SymmetricKey(data: outputs[1]))
    }

    /// Appends `data` to the transcript hash (Noise `MixHash`).
    ///
    /// - Side effects: none.
    mutating func mixHash(_ data: Data) {
        handshakeHash = Data(SHA256.hash(data: handshakeHash + data))
    }

    /// Mixes a pre-shared key into both the chaining key and the transcript (Noise `MixKeyAndHash`).
    ///
    /// - Side effects: none.
    mutating func mixKeyAndHash(_ inputKeyMaterial: Data) {
        let outputs = Self.hkdf(chainingKey: chainingKey, inputKeyMaterial: inputKeyMaterial, count: 3)
        chainingKey = outputs[0]
        mixHash(outputs[1])
        cipher.initializeKey(SymmetricKey(data: outputs[2]))
    }

    /// Encrypts `plaintext` with `h` as associated data, then hashes the ciphertext (Noise `EncryptAndHash`).
    ///
    /// - Side effects: none.
    /// - Throws: ``NoiseError/nonceExhausted``.
    mutating func encryptAndHash(_ plaintext: Data) throws(NoiseError) -> Data {
        let ciphertext = try cipher.encryptWithAd(handshakeHash, plaintext)
        mixHash(ciphertext)
        return ciphertext
    }

    /// Decrypts `ciphertext` with `h` as associated data, then hashes the ciphertext (Noise `DecryptAndHash`).
    ///
    /// - Side effects: none.
    /// - Throws: ``NoiseError/decryptFailed`` or ``NoiseError/nonceExhausted``.
    mutating func decryptAndHash(_ ciphertext: Data) throws(NoiseError) -> Data {
        let plaintext = try cipher.decryptWithAd(handshakeHash, ciphertext)
        mixHash(ciphertext)
        return plaintext
    }

    /// Derives the two transport cipher states (Noise `Split`): first for initiator → responder.
    ///
    /// - Side effects: none.
    func split() -> (CipherState, CipherState) {
        let outputs = Self.hkdf(chainingKey: chainingKey, inputKeyMaterial: Data(), count: 2)
        var first = CipherState()
        var second = CipherState()
        first.initializeKey(SymmetricKey(data: outputs[0]))
        second.initializeKey(SymmetricKey(data: outputs[1]))
        return (first, second)
    }

    /// Noise's HKDF over HMAC-SHA256, returning 2 or 3 outputs of 32 bytes (Noise §4.3).
    ///
    /// - Side effects: none.
    static func hkdf(chainingKey: Data, inputKeyMaterial: Data, count: Int) -> [Data] {
        let tempKey = SymmetricKey(
            data: Data(HMAC<SHA256>.authenticationCode(for: inputKeyMaterial, using: SymmetricKey(data: chainingKey)))
        )
        var outputs: [Data] = []
        var previous = Data()
        for index in 1...count {
            previous = Data(HMAC<SHA256>.authenticationCode(for: previous + [UInt8(index)], using: tempKey))
            outputs.append(previous)
        }
        return outputs
    }
}
