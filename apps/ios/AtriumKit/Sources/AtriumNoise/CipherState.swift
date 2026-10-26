import CryptoKit
import Foundation

/// Noise `CipherState` for ChaChaPoly: a key and the implicit message counter (Noise §5.1).
///
/// - Remark: Internal on purpose. It is a value type, so a copy would reuse nonces; only
///   ``NoiseHandshake`` and ``NoiseTransport``, which are classes and cannot be copied, hold one.
struct CipherState {
  /// The cipher key, or `nil` before the handshake has mixed in a DH result.
  private(set) var key: SymmetricKey?
  /// The next nonce; tests set it to reach the reserved upper bound.
  var nonce: UInt64 = 0

  /// Whether a key has been set.
  var hasKey: Bool { key != nil }

  /// Sets the key and resets the nonce (Noise `InitializeKey`).
  ///
  /// - Remark: Called once per `MixKey` during the handshake and once per direction by `Split`.
  /// - SideEffects: none
  /// - Parameter key: The new 32-byte key.
  mutating func initializeKey(_ key: SymmetricKey) {
    self.key = key
    nonce = 0
  }

  /// Encrypts `plaintext` with associated data `ad`, or returns it unchanged without a key.
  ///
  /// - Remark: Noise reserves nonce 2^64 - 1, so the last usable nonce is 2^64 - 2. The result is
  ///   rebased to index 0: CryptoKit's fields are `Data` slices, and `+` keeps the left side's
  ///   indices, which broke callers that index from 0 (MP0 spike, README "CryptoKit 返回切片").
  /// - SideEffects: none
  /// - Parameters:
  ///   - ad: The associated data.
  ///   - plaintext: What to encrypt.
  /// - Returns: Ciphertext followed by the 16-byte tag.
  /// - Throws: ``NoiseError/nonceExhausted``.
  mutating func encryptWithAd(_ ad: Data, _ plaintext: Data) throws(NoiseError) -> Data {
    guard let key else { return Data(plaintext) }
    guard nonce < UInt64.max else { throw .nonceExhausted }
    let sealed: ChaChaPoly.SealedBox
    do {
      sealed = try ChaChaPoly.seal(plaintext, using: key, nonce: Self.makeNonce(nonce), authenticating: ad)
    } catch {
      // CryptoKit only fails here on malformed nonces, which makeNonce never builds.
      throw .invalidState
    }
    nonce += 1
    return Data(sealed.ciphertext + sealed.tag)
  }

  /// Decrypts and authenticates `ciphertext`, or returns it unchanged without a key.
  ///
  /// - Remark: The nonce only advances on success; callers invalidate the whole state on failure
  ///   anyway (SPEC-0005: a decrypt failure closes the channel).
  /// - SideEffects: none
  /// - Parameters:
  ///   - ad: The associated data.
  ///   - ciphertext: Ciphertext followed by the tag.
  /// - Returns: The plaintext, starting at index 0.
  /// - Throws: ``NoiseError/decryptFailed`` or ``NoiseError/nonceExhausted``.
  mutating func decryptWithAd(_ ad: Data, _ ciphertext: Data) throws(NoiseError) -> Data {
    guard let key else { return Data(ciphertext) }
    guard nonce < UInt64.max else { throw .nonceExhausted }
    guard ciphertext.count >= 16 else { throw .decryptFailed }
    let plaintext: Data
    do {
      let box = try ChaChaPoly.SealedBox(
        nonce: Self.makeNonce(nonce),
        ciphertext: ciphertext.prefix(ciphertext.count - 16),
        tag: ciphertext.suffix(16)
      )
      plaintext = try ChaChaPoly.open(box, using: key, authenticating: ad)
    } catch {
      throw .decryptFailed
    }
    nonce += 1
    return Data(plaintext)
  }

  /// Builds the 96-bit ChaChaPoly nonce: 4 zero bytes then the counter, little-endian (Noise §12.3).
  ///
  /// - Remark: 12 bytes is always a valid ChaChaPoly nonce, so the error path is unreachable; it
  ///   maps to ``NoiseError/invalidState`` instead of a force-try.
  /// - SideEffects: none
  /// - Parameter counter: The message counter.
  /// - Returns: The nonce.
  /// - Throws: ``NoiseError/invalidState`` if CryptoKit refused 12 bytes.
  static func makeNonce(_ counter: UInt64) throws(NoiseError) -> ChaChaPoly.Nonce {
    var bytes = Data(count: 4)
    withUnsafeBytes(of: counter.littleEndian) { bytes.append(contentsOf: $0) }
    do {
      return try ChaChaPoly.Nonce(data: bytes)
    } catch {
      throw .invalidState
    }
  }
}
