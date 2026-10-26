import CryptoKit
import Foundation

/// Noise `SymmetricState` for SHA-256: chaining key, handshake hash and a ``CipherState`` (Noise §5.2).
///
/// - Remark: Internal for the same reason as ``CipherState``: a copy would fork the transcript.
struct SymmetricState {
  /// Chaining key `ck`.
  private(set) var chainingKey: Data
  /// Handshake hash `h`.
  private(set) var handshakeHash: Data
  /// The cipher used by `EncryptAndHash` / `DecryptAndHash`.
  private(set) var cipher = CipherState()

  /// Starts from the protocol name (Noise `InitializeSymmetric`).
  ///
  /// - Remark: A name of at most 32 bytes is zero-padded and used as `h` directly; a longer one is
  ///   hashed. `Noise_IK_25519_ChaChaPoly_SHA256` is exactly 32 bytes, the IKpsk2 name is 36.
  /// - SideEffects: none
  /// - Parameter protocolName: The full Noise protocol name.
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
  /// - Remark: Two HKDF outputs: the new chaining key and the cipher key.
  /// - SideEffects: none
  /// - Parameter inputKeyMaterial: The secret to mix in.
  mutating func mixKey(_ inputKeyMaterial: Data) {
    let outputs = Self.hkdf(chainingKey: chainingKey, inputKeyMaterial: inputKeyMaterial, count: 2)
    chainingKey = outputs[0]
    cipher.initializeKey(SymmetricKey(data: outputs[1]))
  }

  /// Appends `data` to the transcript hash (Noise `MixHash`).
  ///
  /// - Remark: `h = SHA-256(h ‖ data)`.
  /// - SideEffects: none
  /// - Parameter data: What to hash in.
  mutating func mixHash(_ data: Data) {
    handshakeHash = Data(SHA256.hash(data: handshakeHash + data))
  }

  /// Mixes a pre-shared key into both the chaining key and the transcript (Noise `MixKeyAndHash`).
  ///
  /// - Remark: Three HKDF outputs: chaining key, a value hashed into `h`, and the cipher key.
  /// - SideEffects: none
  /// - Parameter inputKeyMaterial: The pre-shared key.
  mutating func mixKeyAndHash(_ inputKeyMaterial: Data) {
    let outputs = Self.hkdf(chainingKey: chainingKey, inputKeyMaterial: inputKeyMaterial, count: 3)
    chainingKey = outputs[0]
    mixHash(outputs[1])
    cipher.initializeKey(SymmetricKey(data: outputs[2]))
  }

  /// Encrypts `plaintext` with `h` as associated data, then hashes the ciphertext (Noise `EncryptAndHash`).
  ///
  /// - Remark: Before any key is mixed in, the plaintext passes through unencrypted, as Noise says.
  /// - SideEffects: none
  /// - Parameter plaintext: What to encrypt.
  /// - Returns: The ciphertext.
  /// - Throws: ``NoiseError/nonceExhausted``.
  mutating func encryptAndHash(_ plaintext: Data) throws(NoiseError) -> Data {
    let ciphertext = try cipher.encryptWithAd(handshakeHash, plaintext)
    mixHash(ciphertext)
    return ciphertext
  }

  /// Decrypts `ciphertext` with `h` as associated data, then hashes the ciphertext (Noise `DecryptAndHash`).
  ///
  /// - Remark: The mirror of ``encryptAndHash(_:)``.
  /// - SideEffects: none
  /// - Parameter ciphertext: What to decrypt.
  /// - Returns: The plaintext.
  /// - Throws: ``NoiseError/decryptFailed`` or ``NoiseError/nonceExhausted``.
  mutating func decryptAndHash(_ ciphertext: Data) throws(NoiseError) -> Data {
    let plaintext = try cipher.decryptWithAd(handshakeHash, ciphertext)
    mixHash(ciphertext)
    return plaintext
  }

  /// Derives the two transport cipher states (Noise `Split`): first for initiator → responder.
  ///
  /// - Remark: No rekey is ever used (SPEC-0005 "传输"), so the chaining key is not kept.
  /// - SideEffects: none
  /// - Returns: The initiator → responder and responder → initiator ciphers.
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
  /// - Remark: The same as RFC 5869 HKDF with an empty info, written out so the code reads like
  ///   Noise §4.3 and the outputs come back as the separate 32-byte values Noise names.
  /// - SideEffects: none
  /// - Parameters:
  ///   - chainingKey: The salt, `ck`.
  ///   - inputKeyMaterial: The secret.
  ///   - count: How many outputs, 2 or 3.
  /// - Returns: The outputs.
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
