import CryptoKit
import Foundation
import Testing

@testable import AtriumNoise

/// Flips one bit of `data` at `index`.
///
/// - Remark: Indexes from `startIndex`, so it works on slices too.
/// - SideEffects: none
/// - Parameters:
///   - data: The bytes.
///   - index: Which byte, from the start.
/// - Returns: The changed copy.
func flip(_ data: Data, at index: Int) -> Data {
  var copy = data
  copy[copy.startIndex + index] ^= 0x01
  return copy
}

@Suite("Noise refuses bad input")
struct NoiseNegativeTests {
  @Test("a changed byte anywhere in a handshake message fails and invalidates", arguments: NoisePattern.allCases)
  func tamperedHandshakeMessagesFailAndInvalidate(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 1)
    let keys = SessionKeys.random(pattern, using: &random)
    let first = try keys.initiator().writeMessage(payload: Data("hi".utf8))
    // Every byte is authenticated: ephemeral key, encrypted static, encrypted payload.
    for index in [0, 31, 32, 79, 80, first.count - 1] {
      let responder = try keys.responder()
      #expect(throws: NoiseError.decryptFailed) { try responder.readMessage(flip(first, at: index)) }
      #expect(throws: NoiseError.invalidated) { try responder.readMessage(first) }
      #expect(throws: NoiseError.invalidated) { try responder.writeMessage(payload: Data()) }
      #expect(throws: NoiseError.invalidated) { try responder.split() }
    }

    let responder = try keys.responder()
    _ = try responder.readMessage(first)
    let second = try responder.writeMessage(payload: Data())
    for index in [0, 31, 32, second.count - 1] {
      let initiator = try keys.initiator()
      _ = try initiator.writeMessage(payload: Data("hi".utf8))
      #expect(throws: NoiseError.decryptFailed) { try initiator.readMessage(flip(second, at: index)) }
      #expect(throws: NoiseError.invalidated) { try initiator.readMessage(second) }
    }
  }

  @Test("a changed transport message fails and invalidates both directions", arguments: NoisePattern.allCases)
  func tamperedTransportMessageFailsAndInvalidatesBothDirections(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 2)
    let keys = SessionKeys.random(pattern, using: &random)
    let (initiator, responder) = try completeHandshake(try keys.initiator(), try keys.responder())
    let good = try initiator.transport.encrypt(Data("payload".utf8))
    #expect(throws: NoiseError.decryptFailed) { try responder.transport.decrypt(flip(good, at: 3)) }
    #expect(throws: NoiseError.invalidated) { try responder.transport.decrypt(good) }
    #expect(throws: NoiseError.invalidated) { try responder.transport.encrypt(Data()) }
  }

  @Test("a replayed transport message fails", arguments: NoisePattern.allCases)
  func replayedTransportMessageFails(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 3)
    let keys = SessionKeys.random(pattern, using: &random)
    let (initiator, responder) = try completeHandshake(try keys.initiator(), try keys.responder())
    let message = try initiator.transport.encrypt(Data("once".utf8))
    #expect(try responder.transport.decrypt(message) == Data("once".utf8))
    #expect(throws: NoiseError.decryptFailed) { try responder.transport.decrypt(message) }
  }

  @Test("reordered transport messages fail", arguments: NoisePattern.allCases)
  func reorderedTransportMessagesFail(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 4)
    let keys = SessionKeys.random(pattern, using: &random)
    let (initiator, responder) = try completeHandshake(try keys.initiator(), try keys.responder())
    _ = try initiator.transport.encrypt(Data("first".utf8))
    let second = try initiator.transport.encrypt(Data("second".utf8))
    #expect(throws: NoiseError.decryptFailed) { try responder.transport.decrypt(second) }
  }

  @Test("a message from one direction cannot be read as the other", arguments: NoisePattern.allCases)
  func directionsUseDifferentKeys(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 5)
    let keys = SessionKeys.random(pattern, using: &random)
    let (initiator, _) = try completeHandshake(try keys.initiator(), try keys.responder())
    let own = try initiator.transport.encrypt(Data("mine".utf8))
    #expect(throws: NoiseError.decryptFailed) { try initiator.transport.decrypt(own) }
  }

  @Test("a finished handshake refuses a replayed message 1", arguments: NoisePattern.allCases)
  func replayedHandshakeMessageIsRefusedByAFinishedHandshake(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 6)
    let keys = SessionKeys.random(pattern, using: &random)
    let initiator = try keys.initiator()
    let responder = try keys.responder()
    let first = try initiator.writeMessage(payload: Data())
    _ = try responder.readMessage(first)
    #expect(throws: NoiseError.invalidState) { try responder.readMessage(first) }
  }

  @Test("a low-order ephemeral in message 1 is refused", arguments: NoisePattern.allCases)
  func lowOrderEphemeralInMessageOneIsRefused(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 7)
    let keys = SessionKeys.random(pattern, using: &random)
    let first = try keys.initiator().writeMessage(payload: Data())
    #expect(lowOrderPoints.count == 7)
    for point in lowOrderPoints {
      let responder = try keys.responder()
      #expect(throws: NoiseError.lowOrderPublicKey) { try responder.readMessage(point + first.dropFirst(32)) }
      #expect(throws: NoiseError.invalidated) { try responder.readMessage(first) }
    }
  }

  @Test("a low-order ephemeral in message 2 is refused", arguments: NoisePattern.allCases)
  func lowOrderEphemeralInMessageTwoIsRefused(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 8)
    let keys = SessionKeys.random(pattern, using: &random)
    let responder = try keys.responder()
    _ = try responder.readMessage(try keys.initiator().writeMessage(payload: Data()))
    let second = try responder.writeMessage(payload: Data())
    for point in lowOrderPoints {
      let initiator = try keys.initiator()
      _ = try initiator.writeMessage(payload: Data())
      #expect(throws: NoiseError.lowOrderPublicKey) { try initiator.readMessage(point + second.dropFirst(32)) }
    }
  }

  @Test("a low-order host key is refused before anything is sent", arguments: NoisePattern.allCases)
  func lowOrderResponderStaticIsRefusedBeforeAnythingIsSent(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 9)
    let keys = SessionKeys.random(pattern, using: &random)
    for point in lowOrderPoints {
      let initiator = try NoiseHandshake(
        pattern: pattern, role: .initiator, prologue: keys.prologue, localStatic: privateKey(keys.initStatic),
        remoteStatic: point, psk: keys.psk)
      #expect(throws: NoiseError.lowOrderPublicKey) { try initiator.writeMessage(payload: Data()) }
      #expect(throws: NoiseError.invalidated) { try initiator.writeMessage(payload: Data()) }
    }
  }

  @Test("oversized and truncated messages are refused", arguments: NoisePattern.allCases)
  func oversizedAndTruncatedMessagesAreRefused(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 10)
    let keys = SessionKeys.random(pattern, using: &random)
    #expect(throws: NoiseError.messageTooLong) {
      try keys.responder().readMessage(Data(count: NoiseHandshake.maxMessageLength + 1))
    }
    let first = try keys.initiator().writeMessage(payload: Data())
    #expect(first.count == 96)
    #expect(throws: NoiseError.messageTooShort) { try keys.responder().readMessage(first.prefix(95)) }
    #expect(throws: NoiseError.messageTooShort) { try keys.responder().readMessage(first.prefix(40)) }
    #expect(throws: NoiseError.messageTooShort) { try keys.responder().readMessage(Data()) }

    let (initiator, responder) = try completeHandshake(try keys.initiator(), try keys.responder())
    let largest = try responder.transport.encrypt(Data(count: NoiseTransport.maxPlaintextLength))
    #expect(largest.count == NoiseHandshake.maxMessageLength)
    #expect(try initiator.transport.decrypt(largest).count == NoiseTransport.maxPlaintextLength)
    #expect(throws: NoiseError.messageTooLong) {
      try initiator.transport.decrypt(Data(count: NoiseHandshake.maxMessageLength + 1))
    }
    #expect(throws: NoiseError.decryptFailed) { try responder.transport.decrypt(Data(count: 15)) }

    let other = try completeHandshake(try keys.initiator(), try keys.responder()).0
    #expect(throws: NoiseError.payloadTooLong) {
      try other.transport.encrypt(Data(count: NoiseTransport.maxPlaintextLength + 1))
    }
    #expect(throws: NoiseError.invalidated) { try other.transport.encrypt(Data()) }
  }

  @Test("every output starts at index 0, even for sliced input")
  func outputsStartAtIndexZero() throws {
    // Callers index into messages (MP0's fuzz test found CryptoKit slices leaking out).
    var random = SeededGenerator(seed: 11)
    let keys = SessionKeys.random(.ikpsk2, using: &random)
    let initiator = try keys.initiator()
    let responder = try keys.responder()
    let padded = Data([0xff]) + (try initiator.writeMessage(payload: Data("a".utf8)))
    let payload = try responder.readMessage(padded.dropFirst())
    #expect(payload == Data("a".utf8))
    #expect(payload.startIndex == 0)
    _ = try initiator.readMessage(try responder.writeMessage(payload: Data()))
    let (sender, receiver) = (try initiator.split().transport, try responder.split().transport)
    let message = try sender.encrypt(Data("x".utf8))
    #expect(message.startIndex == 0)
    let plaintext = try receiver.decrypt((Data([0]) + message).dropFirst())
    #expect(plaintext == Data("x".utf8))
    #expect(plaintext.startIndex == 0)
  }

  @Test("handshake payloads are limited to 1 KiB on both sides", arguments: NoisePattern.allCases)
  func handshakePayloadLimitIsOneKiB(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 12)
    let keys = SessionKeys.random(pattern, using: &random)
    let atLimit = try keys.initiator().writeMessage(payload: Data(count: NoiseHandshake.maxPayloadLength))
    #expect(try keys.responder().readMessage(atLimit).count == NoiseHandshake.maxPayloadLength)
    let initiator = try keys.initiator()
    #expect(throws: NoiseError.payloadTooLong) {
      try initiator.writeMessage(payload: Data(count: NoiseHandshake.maxPayloadLength + 1))
    }
    #expect(throws: NoiseError.invalidated) { try initiator.writeMessage(payload: Data()) }

    // A peer without the limit (writeLimit raised) builds messages our reader must refuse.
    let loose = try keys.initiator()
    loose.writeLimit = .max
    let oversized = try loose.writeMessage(payload: Data(count: NoiseHandshake.maxPayloadLength + 1))
    #expect(throws: NoiseError.payloadTooLong) { try keys.responder().readMessage(oversized) }

    let looseResponder = try keys.responder()
    looseResponder.writeLimit = .max
    _ = try looseResponder.readMessage(try keys.initiator().writeMessage(payload: Data()))
    let second = try looseResponder.writeMessage(payload: Data(count: NoiseHandshake.maxPayloadLength + 1))
    let reader = try keys.initiator()
    _ = try reader.writeMessage(payload: Data())
    #expect(throws: NoiseError.payloadTooLong) { try reader.readMessage(second) }
  }

  @Test("calls out of turn are refused and invalidate", arguments: NoisePattern.allCases)
  func callsOutOfTurnAreRefused(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 13)
    let keys = SessionKeys.random(pattern, using: &random)
    let initiator = try keys.initiator()
    #expect(!initiator.isComplete)
    #expect(throws: NoiseError.invalidState) { try initiator.split() }
    #expect(throws: NoiseError.invalidated) { try initiator.writeMessage(payload: Data()) }
    let reader = try keys.initiator()
    #expect(throws: NoiseError.invalidState) { try reader.readMessage(Data(count: 96)) }
    #expect(throws: NoiseError.invalidated) { try reader.writeMessage(payload: Data()) }
    let responder = try keys.responder()
    #expect(throws: NoiseError.invalidState) { try responder.writeMessage(payload: Data()) }
    #expect(throws: NoiseError.invalidated) { try responder.readMessage(Data(count: 96)) }

    let (fresh, other) = (try keys.initiator(), try keys.responder())
    _ = try completeHandshake(fresh, other)
    #expect(throws: NoiseError.invalidState) { try fresh.split() }
    #expect(throws: NoiseError.invalidated) { try fresh.writeMessage(payload: Data()) }
    #expect(throws: NoiseError.invalidState) { try other.readMessage(Data(count: 48)) }
    #expect(throws: NoiseError.invalidated) { try other.split() }

    let finished = try keys.initiator()
    let peer = try keys.responder()
    _ = try peer.readMessage(try finished.writeMessage(payload: Data()))
    _ = try finished.readMessage(try peer.writeMessage(payload: Data()))
    #expect(throws: NoiseError.invalidState) { try finished.writeMessage(payload: Data()) }
  }

  @Test("keys and PSKs must match the pattern and role")
  func argumentsMustMatchThePattern() throws {
    var random = SeededGenerator(seed: 14)
    let key = try privateKey(random.bytes(32))
    let peer = try privateKey(random.bytes(32)).publicKey.rawRepresentation
    let psk = random.bytes(32)
    let cases: [(NoisePattern, NoiseRole, Data?, Data?)] = [
      (.ikpsk2, .initiator, peer, nil),  // missing PSK
      (.ikpsk2, .initiator, peer, random.bytes(31)),  // short PSK
      (.ikpsk2, .initiator, peer, random.bytes(33)),  // long PSK
      (.ik, .initiator, peer, psk),  // PSK on IK
      (.ik, .initiator, nil, nil),  // initiator without the responder's key
      (.ik, .initiator, peer.prefix(31), nil),  // short remote static
      (.ik, .responder, peer, nil),  // responder must learn the key from message 1
    ]
    for (pattern, role, remote, psk) in cases {
      #expect(throws: NoiseError.invalidArgument) {
        try NoiseHandshake(
          pattern: pattern, role: role, prologue: Data(), localStatic: key, remoteStatic: remote, psk: psk)
      }
    }
    _ = try NoiseHandshake(
      pattern: .ikpsk2, role: .initiator, prologue: Data(), localStatic: key, remoteStatic: peer, psk: psk)
  }

  @Test("another prologue or host key fails message 1", arguments: NoisePattern.allCases)
  func mismatchedPrologueOrResponderKeyFailsMessageOne(pattern: NoisePattern) throws {
    var random = SeededGenerator(seed: 15)
    var keys = SessionKeys.random(pattern, using: &random)
    let first = try keys.initiator().writeMessage(payload: Data())
    var otherPrologue = keys
    otherPrologue.prologue += [0x00]
    #expect(throws: NoiseError.decryptFailed) { try otherPrologue.responder().readMessage(first) }
    keys.respStatic = random.bytes(32)
    #expect(throws: NoiseError.decryptFailed) { try keys.responder().readMessage(first) }
  }

  @Test("a wrong PSK is only noticed by the phone, at message 2")
  func wrongPSKIsOnlyNoticedByTheInitiatorAtMessageTwo() throws {
    // Why SPEC-0005 needs a key confirmation: the responder cannot tell from message 1.
    var random = SeededGenerator(seed: 16)
    let keys = SessionKeys.random(.ikpsk2, using: &random)
    var wrong = keys
    wrong.psk = random.bytes(32)
    let responder = try wrong.responder()
    _ = try responder.readMessage(try keys.initiator().writeMessage(payload: Data("pair".utf8)))
    let initiator = try keys.initiator()
    _ = try initiator.writeMessage(payload: Data("pair".utf8))
    #expect(throws: NoiseError.decryptFailed) { try initiator.readMessage(try responder.writeMessage(payload: Data())) }
  }

  @Test("the nonce stops before the reserved maximum")
  func nonceStopsBeforeTheReservedMaximum() throws {
    var random = SeededGenerator(seed: 17)
    let keys = SessionKeys.random(.ik, using: &random)
    let (initiator, responder) = try completeHandshake(try keys.initiator(), try keys.responder())
    initiator.transport.sendCipher.nonce = UInt64.max - 1
    responder.transport.receiveCipher.nonce = UInt64.max - 1
    let last = try initiator.transport.encrypt(Data("last".utf8))
    #expect(try responder.transport.decrypt(last) == Data("last".utf8))
    #expect(throws: NoiseError.nonceExhausted) { try initiator.transport.encrypt(Data()) }
    #expect(throws: NoiseError.nonceExhausted) { try responder.transport.decrypt(Data(count: 16)) }
  }
}
