import CryptoKit
import Foundation
import Testing

@testable import AtriumNoise

extension Data {
  /// Decodes lower- or upper-case hex, or `nil` when malformed.
  ///
  /// - Remark: Fixtures write bytes as hex (interop FORMAT.md).
  /// - SideEffects: none
  /// - Parameter hex: The hex text.
  init?(hex: String) {
    guard hex.count % 2 == 0 else { return nil }
    var bytes: [UInt8] = []
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
      bytes.append(byte)
      index = next
    }
    self.init(bytes)
  }

  /// Lower-case hex.
  var hex: String { map { String(format: "%02x", $0) }.joined() }
}

/// Hex to bytes for a fixture field, failing the test when it is malformed.
///
/// - Remark: Keeps `#require` out of every call site.
/// - SideEffects: none
/// - Parameter hex: The hex text.
/// - Returns: The bytes.
/// - Throws: When `hex` is not hex.
func bytes(_ hex: String) throws -> Data {
  try #require(Data(hex: hex), "not hex: \(hex.prefix(16))…")
}

/// A private key from fixed bytes.
///
/// - Remark: CryptoKit accepts any 32 bytes; it clamps them itself.
/// - SideEffects: none
/// - Parameter raw: 32 bytes.
/// - Returns: The key.
/// - Throws: When `raw` is not 32 bytes.
func privateKey(_ raw: Data) throws -> Curve25519.KeyAgreement.PrivateKey {
  try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
}

/// A seeded random generator (SplitMix64), so the randomised tests replay the same inputs.
///
/// - Remark: testing.md "Swift（手机端）": random inputs come from a seed, not the system source.
struct SeededGenerator: RandomNumberGenerator {
  private var state: UInt64

  /// Starts from a seed.
  ///
  /// - Remark: Each test passes its own seed so tests stay independent of their order.
  /// - SideEffects: none
  /// - Parameter seed: Any value.
  init(seed: UInt64) {
    state = seed
  }

  /// The next 64 random bits.
  ///
  /// - Remark: SplitMix64's step and mix.
  /// - SideEffects: none
  /// - Returns: The bits.
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }

  /// `count` random bytes.
  ///
  /// - Remark: For keys, PSKs, prologues and payloads.
  /// - SideEffects: none
  /// - Parameter count: How many.
  /// - Returns: The bytes.
  mutating func bytes(_ count: Int) -> Data {
    Data((0..<count).map { _ in UInt8.random(in: 0...255, using: &self) })
  }
}

/// The keys and inputs of one deterministic session.
///
/// - Remark: Both roles are ours, built from the same inputs, so any test can run a full session.
struct SessionKeys {
  var pattern: NoisePattern
  var prologue: Data
  var psk: Data?
  var initStatic: Data
  var initEphemeral: Data
  var respStatic: Data
  var respEphemeral: Data

  /// Fresh keys for `pattern` from `random`.
  ///
  /// - Remark: The prologue length varies too, up to 64 bytes.
  /// - SideEffects: none
  /// - Parameters:
  ///   - pattern: IK or IKpsk2.
  ///   - random: The seeded source.
  /// - Returns: The keys.
  static func random(_ pattern: NoisePattern, using random: inout SeededGenerator) -> SessionKeys {
    SessionKeys(
      pattern: pattern,
      prologue: random.bytes(Int.random(in: 0...64, using: &random)),
      psk: pattern == .ikpsk2 ? random.bytes(32) : nil,
      initStatic: random.bytes(32),
      initEphemeral: random.bytes(32),
      respStatic: random.bytes(32),
      respEphemeral: random.bytes(32)
    )
  }

  /// The responder's static public key.
  var respStaticPublic: Data {
    get throws { try privateKey(respStatic).publicKey.rawRepresentation }
  }

  /// Our initiator with the fixed ephemeral.
  ///
  /// - Remark: Uses the internal initializer only tests can reach.
  /// - SideEffects: none
  /// - Returns: The handshake.
  /// - Throws: ``NoiseError`` for bad keys.
  func initiator() throws -> NoiseHandshake {
    try NoiseHandshake(
      pattern: pattern, role: .initiator, prologue: prologue, localStatic: privateKey(initStatic),
      remoteStatic: respStaticPublic, psk: psk, fixedEphemeral: privateKey(initEphemeral))
  }

  /// Our responder with the fixed ephemeral.
  ///
  /// - Remark: Uses the internal initializer only tests can reach.
  /// - SideEffects: none
  /// - Returns: The handshake.
  /// - Throws: ``NoiseError`` for bad keys.
  func responder() throws -> NoiseHandshake {
    try NoiseHandshake(
      pattern: pattern, role: .responder, prologue: prologue, localStatic: privateKey(respStatic),
      remoteStatic: nil, psk: psk, fixedEphemeral: privateKey(respEphemeral))
  }
}

/// Runs both handshake messages between `initiator` and `responder`, returning both results.
///
/// - Remark: Most tests only care about the transports afterwards.
/// - SideEffects: none
/// - Parameters:
///   - initiator: The phone's side.
///   - responder: The host's side.
///   - payloads: The two handshake payloads.
/// - Returns: The initiator's and the responder's results.
/// - Throws: ``NoiseError``.
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
].compactMap { Data(hex: $0) }

/// Loads a fixture from the test bundle.
///
/// - Remark: Fixtures live in `Fixtures/` and are read through `Bundle.module` (testing.md).
/// - SideEffects: Reads a file.
/// - Parameter name: The file name with its extension.
/// - Returns: The bytes.
/// - Throws: When the file is missing.
func fixture(_ name: String) throws -> Data {
  let url = try #require(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: nil))
  return try Data(contentsOf: url)
}
