import CryptoKit
import Foundation
import Testing

@testable import AtriumNoise

/// The IK and IKpsk2 vectors extracted from cacophony by `spikes/mobile-mp0/swift/tools/extract-vectors.sh`.
///
/// - Remark: The file keeps cacophony's snake-case names; the decoder converts them.
struct VectorFile: Decodable {
  let sha256: String
  let vectors: [Vector]

  /// One cacophony vector.
  ///
  /// - Remark: Only the fields IK and IKpsk2 use.
  struct Vector: Decodable {
    let protocolName: String
    let initPrologue: String
    let respPrologue: String
    let initPsks: [String]?
    let respPsks: [String]?
    let initStatic: String
    let initEphemeral: String
    let initRemoteStatic: String
    let respStatic: String
    let respEphemeral: String
    let handshakeHash: String
    let messages: [Message]
  }

  /// One message of a vector.
  ///
  /// - Remark: Handshake messages first, then transport messages alternating from the initiator.
  struct Message: Decodable {
    let payload: String
    let ciphertext: String
  }

  /// Loads the bundled file.
  ///
  /// - Remark: Copied from the MP0 spike, unchanged.
  /// - SideEffects: Reads the fixture.
  /// - Returns: The vectors.
  /// - Throws: When the file is missing or malformed.
  static func load() throws -> VectorFile {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(VectorFile.self, from: fixture("cacophony-ik.json"))
  }
}

@Suite("cacophony vectors")
struct CacophonyVectorTests {
  @Test("the fixture is the pinned cacophony file and has exactly IK and IKpsk2")
  func fixtureComesFromThePinnedFile() throws {
    let file = try VectorFile.load()
    #expect(file.sha256 == "3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae")
    #expect(file.vectors.map(\.protocolName).sorted() == NoisePattern.allCases.map(\.protocolName).sorted())
  }

  @Test("handshake, hash and transport match the vector byte for byte", arguments: NoisePattern.allCases)
  func matchesByteForByte(pattern: NoisePattern) throws {
    let vector = try #require(try VectorFile.load().vectors.first { $0.protocolName == pattern.protocolName })
    #expect(vector.messages.count == 6)
    #expect(vector.initPrologue == vector.respPrologue)
    #expect(vector.initPsks == vector.respPsks)
    let psk = try vector.initPsks.map { try bytes($0[0]) }
    // The vector's remote static is the responder's public key; check it before relying on it.
    #expect(
      try privateKey(bytes(vector.respStatic)).publicKey.rawRepresentation.hex == vector.initRemoteStatic)

    let initiator = try NoiseHandshake(
      pattern: pattern, role: .initiator, prologue: bytes(vector.initPrologue),
      localStatic: privateKey(bytes(vector.initStatic)), remoteStatic: bytes(vector.initRemoteStatic), psk: psk,
      fixedEphemeral: privateKey(bytes(vector.initEphemeral)))
    let responder = try NoiseHandshake(
      pattern: pattern, role: .responder, prologue: bytes(vector.respPrologue),
      localStatic: privateKey(bytes(vector.respStatic)), remoteStatic: nil, psk: psk,
      fixedEphemeral: privateKey(bytes(vector.respEphemeral)))

    let m = vector.messages
    let first = try initiator.writeMessage(payload: bytes(m[0].payload))
    #expect(first.hex == m[0].ciphertext)
    #expect(try responder.readMessage(first).hex == m[0].payload)
    #expect(
      responder.remoteStaticPublicKey == (try privateKey(bytes(vector.initStatic)).publicKey.rawRepresentation))

    let second = try responder.writeMessage(payload: bytes(m[1].payload))
    #expect(second.hex == m[1].ciphertext)
    #expect(try initiator.readMessage(second).hex == m[1].payload)
    #expect(initiator.isComplete && responder.isComplete)

    let initiatorResult = try initiator.split()
    let responderResult = try responder.split()
    #expect(initiatorResult.handshakeHash.hex == vector.handshakeHash)
    #expect(responderResult.handshakeHash.hex == vector.handshakeHash)

    // Transport messages alternate, starting with the initiator.
    for (index, message) in m.enumerated().dropFirst(2) {
      let (sender, receiver) =
        index % 2 == 0
        ? (initiatorResult.transport, responderResult.transport)
        : (responderResult.transport, initiatorResult.transport)
      let ciphertext = try sender.encrypt(bytes(message.payload))
      #expect(ciphertext.hex == message.ciphertext, "transport message \(index)")
      #expect(try receiver.decrypt(ciphertext).hex == message.payload, "transport message \(index)")
    }
  }

  @Test("the IK name is used as h directly, the longer IKpsk2 name is hashed")
  func protocolNameIsUsedAsHashDirectlyOnlyWhenShort() {
    #expect(NoisePattern.ik.protocolName == "Noise_IK_25519_ChaChaPoly_SHA256")
    #expect(NoisePattern.ikpsk2.protocolName == "Noise_IKpsk2_25519_ChaChaPoly_SHA256")
    #expect(NoisePattern.ik.protocolName.utf8.count == 32)
    #expect(
      SymmetricState(protocolName: NoisePattern.ik.protocolName).handshakeHash
        == Data(NoisePattern.ik.protocolName.utf8))
    #expect(
      SymmetricState(protocolName: NoisePattern.ikpsk2.protocolName).handshakeHash
        == Data(SHA256.hash(data: Data(NoisePattern.ikpsk2.protocolName.utf8))))
    #expect(SymmetricState(protocolName: "short").handshakeHash == Data("short".utf8) + Data(count: 27))
  }

  @Test("the nonce is four zero bytes then the little-endian counter")
  func nonceIsFourZeroBytesThenLittleEndianCounter() throws {
    let nonce = try CipherState.makeNonce(0x0102_0304_0506_0708)
    #expect(Data(nonce).hex == "000000000807060504030201")
  }
}
