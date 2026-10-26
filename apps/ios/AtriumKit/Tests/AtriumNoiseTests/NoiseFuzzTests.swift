import Foundation
import Testing

@testable import AtriumNoise

/// Changes `data` in one of a few ways: bit flips, truncation, extension, or random bytes.
///
/// - Remark: Never returns `data` unchanged, so every case must be refused.
/// - SideEffects: none
/// - Parameters:
///   - data: The bytes.
///   - random: The seeded source.
/// - Returns: A different byte string.
func mutate(_ data: Data, using random: inout SeededGenerator) -> Data {
  var copy = Data(data)
  switch Int.random(in: 0..<4, using: &random) {
  case 0:
    for _ in 0..<Int.random(in: 1...4, using: &random) {
      copy[Int.random(in: 0..<copy.count, using: &random)] ^= UInt8(1 << Int.random(in: 0..<8, using: &random))
    }
  case 1: copy = copy.prefix(Int.random(in: 0..<copy.count, using: &random))
  case 2: copy += random.bytes(Int.random(in: 1...32, using: &random))
  default: copy = random.bytes(Int.random(in: 0...(copy.count + 64), using: &random))
  }
  return copy == data ? copy + [0] : copy
}

/// A payload size that includes the edges: empty, one byte, the limit, or anything up to `limit`.
///
/// - Remark: Edges are where off-by-one errors live.
/// - SideEffects: none
/// - Parameters:
///   - limit: The largest size.
///   - random: The seeded source.
/// - Returns: The size.
func edgySize(upTo limit: Int, using random: inout SeededGenerator) -> Int {
  [0, 1, limit, Int.random(in: 0...limit, using: &random)].randomElement(using: &random) ?? 0
}

/// Randomised checks of our own implementation, standing in for MP0's differential test against Torann.
///
/// - Remark: The cacophony vectors and the TS interop records pin the bytes; these check that random
///   sessions round-trip and that any change to a message is refused. Seeded, so a failure replays.
@Suite("Noise fuzz")
struct NoiseFuzzTests {
  @Test("random sessions round-trip and both sides agree on h", arguments: NoisePattern.allCases)
  func randomSessionsRoundTrip(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: pattern == .ik ? 100 : 200)
    for _ in 0..<50 {
      let keys = SessionKeys.random(pattern, using: &random)
      let first = random.bytes(edgySize(upTo: NoiseHandshake.maxPayloadLength, using: &random))
      let second = random.bytes(edgySize(upTo: NoiseHandshake.maxPayloadLength, using: &random))
      let initiator = try keys.initiator()
      let responder = try keys.responder()
      #expect(try responder.readMessage(try initiator.writeMessage(payload: first)) == first)
      #expect(responder.remoteStaticPublicKey == (try privateKey(keys.initStatic).publicKey.rawRepresentation))
      #expect(try initiator.readMessage(try responder.writeMessage(payload: second)) == second)
      let (a, b) = (try initiator.split(), try responder.split())
      #expect(a.handshakeHash == b.handshakeHash)
      #expect(a.remoteStaticPublicKey == (try keys.respStaticPublic))
      for step in 0..<6 {
        let payload = random.bytes(edgySize(upTo: NoiseTransport.maxPlaintextLength, using: &random))
        let (sender, receiver) = step % 2 == 0 ? (a.transport, b.transport) : (b.transport, a.transport)
        #expect(try receiver.decrypt(try sender.encrypt(payload)) == payload)
      }
    }
  }

  @Test("any change to a handshake or transport message is refused", arguments: NoisePattern.allCases)
  func fuzzedMessagesAreRefused(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: pattern == .ik ? 300 : 400)
    for _ in 0..<200 {
      let keys = SessionKeys.random(pattern, using: &random)
      let payload = random.bytes(edgySize(upTo: NoiseHandshake.maxPayloadLength, using: &random))
      let first = try keys.initiator().writeMessage(payload: payload)
      let badFirst = mutate(first, using: &random)
      #expect(throws: NoiseError.self) { try keys.responder().readMessage(badFirst) }

      let responder = try keys.responder()
      _ = try responder.readMessage(first)
      let second = try responder.writeMessage(payload: random.bytes(16))
      let initiator = try keys.initiator()
      _ = try initiator.writeMessage(payload: payload)
      let badSecond = mutate(second, using: &random)
      #expect(throws: NoiseError.self) { try initiator.readMessage(badSecond) }

      let (a, b) = try completeHandshake(try keys.initiator(), try keys.responder())
      let message = try a.transport.encrypt(random.bytes(edgySize(upTo: 2048, using: &random)))
      let badMessage = mutate(message, using: &random)
      #expect(throws: NoiseError.self) { try b.transport.decrypt(badMessage) }
    }
  }
}
