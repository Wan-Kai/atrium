import CryptoKit
import Foundation
import Testing

@testable import AtriumNoiseSpike

@Suite("Noise refuses bad input")
struct NoiseNegativeTests {
    /// Flips one bit of `data` at `index`.
    func flip(_ data: Data, at index: Int) -> Data {
        var copy = data
        copy[copy.startIndex + index] ^= 0x01
        return copy
    }

    @Test(arguments: NoisePattern.allCases)
    func tamperedHandshakeMessagesFailAndInvalidate(pattern: NoisePattern) throws {
        let keys = SessionKeys.random(pattern)
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

    @Test(arguments: NoisePattern.allCases)
    func tamperedTransportMessageFailsAndInvalidatesBothDirections(pattern: NoisePattern) throws {
        let keys = SessionKeys.random(pattern)
        let (initiator, responder) = try completeHandshake(try keys.initiator(), try keys.responder())
        let good = try initiator.transport.encrypt(Data("payload".utf8))
        #expect(throws: NoiseError.decryptFailed) { try responder.transport.decrypt(flip(good, at: 3)) }
        #expect(throws: NoiseError.invalidated) { try responder.transport.decrypt(good) }
        #expect(throws: NoiseError.invalidated) { try responder.transport.encrypt(Data()) }
    }

    @Test(arguments: NoisePattern.allCases)
    func replayedTransportMessageFails(pattern: NoisePattern) throws {
        let keys = SessionKeys.random(pattern)
        let (initiator, responder) = try completeHandshake(try keys.initiator(), try keys.responder())
        let message = try initiator.transport.encrypt(Data("once".utf8))
        #expect(try responder.transport.decrypt(message) == Data("once".utf8))
        #expect(throws: NoiseError.decryptFailed) { try responder.transport.decrypt(message) }
    }

    @Test(arguments: NoisePattern.allCases)
    func reorderedTransportMessagesFail(pattern: NoisePattern) throws {
        let keys = SessionKeys.random(pattern)
        let (initiator, responder) = try completeHandshake(try keys.initiator(), try keys.responder())
        _ = try initiator.transport.encrypt(Data("first".utf8))
        let second = try initiator.transport.encrypt(Data("second".utf8))
        #expect(throws: NoiseError.decryptFailed) { try responder.transport.decrypt(second) }
    }

    @Test(arguments: NoisePattern.allCases)
    func replayedHandshakeMessageIsRefusedByAFinishedHandshake(pattern: NoisePattern) throws {
        let keys = SessionKeys.random(pattern)
        let initiator = try keys.initiator()
        let responder = try keys.responder()
        let first = try initiator.writeMessage(payload: Data())
        _ = try responder.readMessage(first)
        #expect(throws: NoiseError.invalidState) { try responder.readMessage(first) }
    }

    @Test(arguments: NoisePattern.allCases)
    func lowOrderEphemeralInMessageOneIsRefused(pattern: NoisePattern) throws {
        let keys = SessionKeys.random(pattern)
        let first = try keys.initiator().writeMessage(payload: Data())
        for point in lowOrderPoints {
            let responder = try keys.responder()
            #expect(throws: NoiseError.lowOrderPublicKey) { try responder.readMessage(point + first.dropFirst(32)) }
            #expect(throws: NoiseError.invalidated) { try responder.readMessage(first) }
        }
    }

    @Test(arguments: NoisePattern.allCases)
    func lowOrderEphemeralInMessageTwoIsRefused(pattern: NoisePattern) throws {
        let keys = SessionKeys.random(pattern)
        let responder = try keys.responder()
        _ = try responder.readMessage(try keys.initiator().writeMessage(payload: Data()))
        let second = try responder.writeMessage(payload: Data())
        for point in lowOrderPoints {
            let initiator = try keys.initiator()
            _ = try initiator.writeMessage(payload: Data())
            #expect(throws: NoiseError.lowOrderPublicKey) { try initiator.readMessage(point + second.dropFirst(32)) }
        }
    }

    @Test(arguments: NoisePattern.allCases)
    func lowOrderResponderStaticIsRefusedBeforeAnythingIsSent(pattern: NoisePattern) throws {
        let keys = SessionKeys.random(pattern)
        for point in lowOrderPoints {
            let initiator = try NoiseHandshake(
                pattern: pattern, role: .initiator, prologue: keys.prologue,
                localStatic: privateKey(keys.initStatic), remoteStatic: point, psk: keys.psk)
            #expect(throws: NoiseError.lowOrderPublicKey) { try initiator.writeMessage(payload: Data()) }
        }
    }

    @Test(arguments: NoisePattern.allCases)
    func oversizedAndTruncatedMessagesAreRefused(pattern: NoisePattern) throws {
        let keys = SessionKeys.random(pattern)
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
    }

    @Test func outputsStartAtIndexZero() throws {
        // Callers index into messages (the fuzz test found CryptoKit slices leaking out).
        let keys = SessionKeys.random(.ik)
        let (initiator, responder) = try completeHandshake(try keys.initiator(), try keys.responder())
        let message = try initiator.transport.encrypt(Data("x".utf8))
        #expect(message.startIndex == 0)
        #expect(try responder.transport.decrypt(message).startIndex == 0)
    }

    @Test(arguments: NoisePattern.allCases)
    func handshakePayloadLimitIsOneKiB(pattern: NoisePattern) throws {
        let keys = SessionKeys.random(pattern)
        let atLimit = try keys.initiator().writeMessage(payload: Data(count: NoiseHandshake.maxPayloadLength))
        #expect(try keys.responder().readMessage(atLimit).count == NoiseHandshake.maxPayloadLength)
        let initiator = try keys.initiator()
        #expect(throws: NoiseError.payloadTooLong) {
            try initiator.writeMessage(payload: Data(count: NoiseHandshake.maxPayloadLength + 1))
        }
        #expect(throws: NoiseError.invalidated) { try initiator.writeMessage(payload: Data()) }
        // Reading an oversized payload is covered against Torann, which has no such limit.
    }

    @Test(arguments: NoisePattern.allCases)
    func callsOutOfTurnAreRefused(pattern: NoisePattern) throws {
        let keys = SessionKeys.random(pattern)
        let initiator = try keys.initiator()
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
    }

    @Test func argumentsMustMatchThePattern() throws {
        let key = Curve25519.KeyAgreement.PrivateKey()
        let peer = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        let psk = randomBytes(32)
        let cases: [(NoisePattern, NoiseRole, Data?, Data?)] = [
            (.ikpsk2, .initiator, peer, nil),  // missing PSK
            (.ikpsk2, .initiator, peer, randomBytes(31)),  // short PSK
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
    }

    @Test(arguments: NoisePattern.allCases)
    func mismatchedPrologueOrResponderKeyFailsMessageOne(pattern: NoisePattern) throws {
        var keys = SessionKeys.random(pattern)
        let first = try keys.initiator().writeMessage(payload: Data())
        var otherPrologue = keys
        otherPrologue.prologue += [0x00]
        #expect(throws: NoiseError.decryptFailed) { try otherPrologue.responder().readMessage(first) }
        keys.respStatic = randomBytes(32)
        #expect(throws: NoiseError.decryptFailed) { try keys.responder().readMessage(first) }
    }

    @Test func wrongPSKIsOnlyNoticedByTheInitiatorAtMessageTwo() throws {
        // Why SPEC-0005 needs a key confirmation: the responder cannot tell from message 1.
        let keys = SessionKeys.random(.ikpsk2)
        var wrong = keys
        wrong.psk = randomBytes(32)
        let responder = try wrong.responder()
        _ = try responder.readMessage(try keys.initiator().writeMessage(payload: Data("pair".utf8)))
        let initiator = try keys.initiator()
        _ = try initiator.writeMessage(payload: Data("pair".utf8))
        #expect(throws: NoiseError.decryptFailed) { try initiator.readMessage(try responder.writeMessage(payload: Data())) }
    }

    @Test func nonceStopsBeforeTheReservedMaximum() throws {
        let keys = SessionKeys.random(.ik)
        let (initiator, responder) = try completeHandshake(try keys.initiator(), try keys.responder())
        initiator.transport.sendCipher.nonce = UInt64.max - 1
        responder.transport.receiveCipher.nonce = UInt64.max - 1
        let last = try initiator.transport.encrypt(Data("last".utf8))
        #expect(try responder.transport.decrypt(last) == Data("last".utf8))
        #expect(throws: NoiseError.nonceExhausted) { try initiator.transport.encrypt(Data()) }
        #expect(throws: NoiseError.nonceExhausted) { try responder.transport.decrypt(Data(count: 16)) }
    }
}
