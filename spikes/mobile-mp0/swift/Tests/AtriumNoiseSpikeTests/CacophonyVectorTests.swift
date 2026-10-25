import CryptoKit
import Foundation
import Testing

@testable import AtriumNoiseSpike

/// The IK and IKpsk2 vectors extracted from cacophony by `tools/extract-vectors.sh`.
struct VectorFile: Decodable {
    let sha256: String
    let vectors: [Vector]

    struct Vector: Decodable {
        let protocol_name: String
        let init_prologue: String
        let resp_prologue: String
        let init_psks: [String]?
        let resp_psks: [String]?
        let init_static: String
        let init_ephemeral: String
        let init_remote_static: String
        let resp_static: String
        let resp_ephemeral: String
        let handshake_hash: String
        let messages: [Message]
    }

    struct Message: Decodable {
        let payload: String
        let ciphertext: String
    }

    /// Loads the bundled file.
    static func load() throws -> VectorFile {
        let url = try #require(Bundle.module.url(forResource: "cacophony-ik", withExtension: "json"))
        return try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url))
    }
}

@Suite("cacophony vectors")
struct CacophonyVectorTests {
    @Test func fixtureComesFromThePinnedFile() throws {
        let file = try VectorFile.load()
        #expect(file.sha256 == "3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae")
        #expect(file.vectors.map(\.protocol_name).sorted() == NoisePattern.allCases.map(\.protocolName).sorted())
    }

    @Test(arguments: NoisePattern.allCases)
    func matchesByteForByte(pattern: NoisePattern) throws {
        let vector = try #require(try VectorFile.load().vectors.first { $0.protocol_name == pattern.protocolName })
        #expect(vector.messages.count == 6)
        #expect(vector.init_prologue == vector.resp_prologue)
        #expect(vector.init_psks == vector.resp_psks)
        let psk = vector.init_psks.map { Data(hex: $0[0]) }
        // The vector's remote static is the responder's public key; check it before relying on it.
        #expect(privateKey(Data(hex: vector.resp_static)).publicKey.rawRepresentation.hex == vector.init_remote_static)

        let initiator = try NoiseHandshake(
            pattern: pattern, role: .initiator, prologue: Data(hex: vector.init_prologue),
            localStatic: privateKey(Data(hex: vector.init_static)),
            remoteStatic: Data(hex: vector.init_remote_static), psk: psk,
            fixedEphemeral: privateKey(Data(hex: vector.init_ephemeral)))
        let responder = try NoiseHandshake(
            pattern: pattern, role: .responder, prologue: Data(hex: vector.resp_prologue),
            localStatic: privateKey(Data(hex: vector.resp_static)), remoteStatic: nil, psk: psk,
            fixedEphemeral: privateKey(Data(hex: vector.resp_ephemeral)))

        let m = vector.messages
        let first = try initiator.writeMessage(payload: Data(hex: m[0].payload))
        #expect(first.hex == m[0].ciphertext)
        #expect(try responder.readMessage(first).hex == m[0].payload)
        #expect(responder.remoteStaticPublicKey == privateKey(Data(hex: vector.init_static)).publicKey.rawRepresentation)

        let second = try responder.writeMessage(payload: Data(hex: m[1].payload))
        #expect(second.hex == m[1].ciphertext)
        #expect(try initiator.readMessage(second).hex == m[1].payload)

        let initiatorResult = try initiator.split()
        let responderResult = try responder.split()
        #expect(initiatorResult.handshakeHash.hex == vector.handshake_hash)
        #expect(responderResult.handshakeHash.hex == vector.handshake_hash)

        // Transport messages alternate, starting with the initiator.
        for (index, message) in m.enumerated().dropFirst(2) {
            let (sender, receiver) =
                index % 2 == 0
                ? (initiatorResult.transport, responderResult.transport)
                : (responderResult.transport, initiatorResult.transport)
            let ciphertext = try sender.encrypt(Data(hex: message.payload))
            #expect(ciphertext.hex == message.ciphertext, "transport message \(index)")
            #expect(try receiver.decrypt(ciphertext).hex == message.payload, "transport message \(index)")
        }
    }

    @Test func ikProtocolNameIsUsedAsHashDirectly() {
        // 32 bytes exactly, so InitializeSymmetric must not hash it.
        #expect(NoisePattern.ik.protocolName.utf8.count == 32)
        #expect(SymmetricState(protocolName: NoisePattern.ik.protocolName).handshakeHash == Data(NoisePattern.ik.protocolName.utf8))
        #expect(NoisePattern.ikpsk2.protocolName.utf8.count == 36)
        #expect(
            SymmetricState(protocolName: NoisePattern.ikpsk2.protocolName).handshakeHash
                == Data(SHA256.hash(data: Data(NoisePattern.ikpsk2.protocolName.utf8))))
    }

    @Test func nonceIsFourZeroBytesThenLittleEndianCounter() {
        let nonce = CipherState.makeNonce(0x0102_0304_0506_0708)
        #expect(Data(nonce).hex == "000000000807060504030201")
    }
}
