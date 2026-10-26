import CryptoKit
import Foundation

@testable import AtriumNoiseSpike

extension Data {
    /// Decodes lower- or upper-case hex; traps on malformed input (test fixtures only).
    init(hex: String) {
        var bytes = [UInt8]()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        self.init(bytes)
    }

    /// Lower-case hex.
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

/// A private key from fixed bytes.
func privateKey(_ raw: Data) -> Curve25519.KeyAgreement.PrivateKey {
    try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
}

/// `count` bytes from the system random source.
func randomBytes(_ count: Int) -> Data {
    Data((0..<count).map { _ in UInt8.random(in: 0...255) })
}

/// The keys and inputs of one deterministic session.
struct SessionKeys {
    var pattern: NoisePattern
    var prologue: Data
    var psk: Data?
    var initStatic: Data
    var initEphemeral: Data
    var respStatic: Data
    var respEphemeral: Data

    /// Fresh random keys for `pattern`.
    static func random(_ pattern: NoisePattern) -> SessionKeys {
        SessionKeys(
            pattern: pattern,
            prologue: randomBytes(Int.random(in: 0...64)),
            psk: pattern == .ikpsk2 ? randomBytes(32) : nil,
            initStatic: randomBytes(32),
            initEphemeral: randomBytes(32),
            respStatic: randomBytes(32),
            respEphemeral: randomBytes(32)
        )
    }

    /// The responder's static public key.
    var respStaticPublic: Data { privateKey(respStatic).publicKey.rawRepresentation }

    /// Our initiator with the fixed ephemeral.
    func initiator() throws -> NoiseHandshake {
        try NoiseHandshake(
            pattern: pattern, role: .initiator, prologue: prologue, localStatic: privateKey(initStatic),
            remoteStatic: respStaticPublic, psk: psk, fixedEphemeral: privateKey(initEphemeral))
    }

    /// Our responder with the fixed ephemeral.
    func responder() throws -> NoiseHandshake {
        try NoiseHandshake(
            pattern: pattern, role: .responder, prologue: prologue, localStatic: privateKey(respStatic),
            remoteStatic: nil, psk: psk, fixedEphemeral: privateKey(respEphemeral))
    }
}

/// Runs both handshake messages between `initiator` and `responder`, returning both results.
func completeHandshake(
    _ initiator: NoiseHandshake, _ responder: NoiseHandshake, payloads: (Data, Data) = (Data(), Data())
) throws -> (NoiseHandshakeResult, NoiseHandshakeResult) {
    _ = try responder.readMessage(try initiator.writeMessage(payload: payloads.0))
    _ = try initiator.readMessage(try responder.writeMessage(payload: payloads.1))
    return (try initiator.split(), try responder.split())
}

/// X25519 public keys whose DH output is all zeros for every private key (libsodium's list).
let lowOrderPoints: [Data] = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
    "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map { Data(hex: $0) }
