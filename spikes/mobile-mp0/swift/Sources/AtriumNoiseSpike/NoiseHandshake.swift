import CryptoKit
import Foundation

/// Noise `HandshakeState` for IK and IKpsk2 over 25519 / ChaChaPoly / SHA-256, either role (Noise §5.3).
///
/// - Remarks: A class, so the state cannot be copied and replayed from a snapshot. Any failed
///   call invalidates it for good (SPEC-0005 "Noise 通道"). Ephemeral keys come from
///   CryptoKit; the only way to fix them is the internal initializer that tests reach with
///   `@testable import`, so app code cannot.
/// - Side effects: none (key generation reads the system random source).
public final class NoiseHandshake {
    /// Noise's limit for any message (Noise §3).
    public static let maxMessageLength = 65535
    /// Atrium's limit for a handshake payload (SPEC-0005 "握手载荷").
    public static let maxPayloadLength = 1024

    /// Where the handshake stands.
    private enum Phase {
        case running, complete, split, invalidated
    }

    private let pattern: NoisePattern
    private let role: NoiseRole
    private var symmetric: SymmetricState
    private let localStatic: Curve25519.KeyAgreement.PrivateKey
    private var localEphemeral: Curve25519.KeyAgreement.PrivateKey?
    private var remoteStatic: Curve25519.KeyAgreement.PublicKey?
    private var remoteEphemeral: Curve25519.KeyAgreement.PublicKey?
    private var psk: Data?
    private var fixedEphemeral: Curve25519.KeyAgreement.PrivateKey?
    private var messageIndex = 0
    private var phase = Phase.running

    /// Starts a handshake with a fresh ephemeral key.
    ///
    /// - Parameters:
    ///   - pattern: IK or IKpsk2.
    ///   - role: The phone is the initiator, the Mac the responder.
    ///   - prologue: Bytes both sides must agree on; hashed, never sent.
    ///   - localStatic: This party's long-term key.
    ///   - remoteStatic: The responder's 32-byte public key; required for the initiator, must be
    ///     `nil` for the responder (it learns the initiator's key from message 1).
    ///   - psk: The 32-byte pre-shared key; required for IKpsk2, must be `nil` for IK.
    /// - Side effects: none.
    /// - Throws: ``NoiseError/invalidArgument`` when a key is missing, extra or the wrong length.
    public convenience init(
        pattern: NoisePattern,
        role: NoiseRole,
        prologue: Data,
        localStatic: Curve25519.KeyAgreement.PrivateKey,
        remoteStatic: Data? = nil,
        psk: Data? = nil
    ) throws(NoiseError) {
        try self.init(
            pattern: pattern, role: role, prologue: prologue, localStatic: localStatic,
            remoteStatic: remoteStatic, psk: psk, fixedEphemeral: nil)
    }

    /// Starts a handshake, optionally with a fixed ephemeral key. Test entry point only.
    ///
    /// - Remarks: Internal so only `@testable` test code can pin the ephemeral key, which test
    ///   vectors and interop records need; a fixed ephemeral in production breaks forward secrecy.
    /// - Side effects: none.
    init(
        pattern: NoisePattern,
        role: NoiseRole,
        prologue: Data,
        localStatic: Curve25519.KeyAgreement.PrivateKey,
        remoteStatic: Data?,
        psk: Data?,
        fixedEphemeral: Curve25519.KeyAgreement.PrivateKey?
    ) throws(NoiseError) {
        self.pattern = pattern
        self.role = role
        self.localStatic = localStatic
        self.fixedEphemeral = fixedEphemeral

        switch (pattern.usesPSK, psk) {
        case (true, let key?) where key.count == 32: self.psk = key
        case (false, nil): self.psk = nil
        default: throw .invalidArgument
        }

        symmetric = SymmetricState(protocolName: pattern.protocolName)
        symmetric.mixHash(prologue)

        // Pre-message `<- s`: both sides hash the responder's static key.
        switch (role, remoteStatic) {
        case (.initiator, let raw?):
            guard raw.count == 32, let key = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw) else {
                throw .invalidArgument
            }
            self.remoteStatic = key
            symmetric.mixHash(raw)
        case (.responder, nil):
            symmetric.mixHash(localStatic.publicKey.rawRepresentation)
        default:
            throw .invalidArgument
        }
    }

    /// Whether both handshake messages have been processed and ``split()`` may be called.
    public var isComplete: Bool { phase == .complete }

    /// The peer's static public key once known: at once for the initiator, after message 1 for the responder.
    ///
    /// - Remarks: The responder needs it after message 1 to look the device up before it answers
    ///   (SPEC-0005 "日常连接" step 2).
    public var remoteStaticPublicKey: Data? { remoteStatic?.rawRepresentation }

    /// The current handshake hash `h`; after the last message it is the value both sides share.
    public var handshakeHash: Data { symmetric.handshakeHash }

    /// Writes the next handshake message carrying `payload`.
    ///
    /// - Side effects: none.
    /// - Returns: The Noise message, without Atrium's first-frame header.
    /// - Throws: ``NoiseError``; any failure invalidates the handshake.
    public func writeMessage(payload: Data) throws(NoiseError) -> Data {
        try guardRunning()
        do {
            return try performWrite(payload: payload)
        } catch {
            invalidate()
            throw error
        }
    }

    /// Reads the next handshake message from the peer.
    ///
    /// - Side effects: none.
    /// - Returns: The decrypted payload.
    /// - Throws: ``NoiseError``; any failure invalidates the handshake.
    public func readMessage(_ message: Data) throws(NoiseError) -> Data {
        try guardRunning()
        do {
            return try performRead(message: message)
        } catch {
            invalidate()
            throw error
        }
    }

    /// Ends the handshake and returns the transport and the final handshake hash.
    ///
    /// - Remarks: Can be called once; the handshake refuses everything afterwards, and its
    ///   ephemeral key and PSK are dropped. Calling it early invalidates the handshake like any
    ///   other failure.
    /// - Side effects: none.
    /// - Throws: ``NoiseError/invalidState`` before both messages, ``NoiseError/invalidated`` after a failure.
    public func split() throws(NoiseError) -> NoiseHandshakeResult {
        switch phase {
        case .complete: break
        case .invalidated: throw .invalidated
        case .running, .split:
            invalidate()
            throw .invalidState
        }
        let (initiatorToResponder, responderToInitiator) = symmetric.split()
        let transport =
            role == .initiator
            ? NoiseTransport(send: initiatorToResponder, receive: responderToInitiator)
            : NoiseTransport(send: responderToInitiator, receive: initiatorToResponder)
        let result = NoiseHandshakeResult(
            transport: transport,
            handshakeHash: symmetric.handshakeHash,
            remoteStaticPublicKey: remoteStatic?.rawRepresentation ?? Data()
        )
        phase = .split
        dropSecrets()
        return result
    }

    /// Throws unless the handshake is still exchanging messages; misuse invalidates it.
    ///
    /// - Side effects: none.
    private func guardRunning() throws(NoiseError) {
        switch phase {
        case .running: return
        case .invalidated: throw .invalidated
        case .complete, .split:
            invalidate()
            throw .invalidState
        }
    }

    /// Whether the next message is ours to write.
    private var isOurTurnToWrite: Bool { (messageIndex % 2 == 0) == (role == .initiator) }

    /// Processes the tokens of the next message as the sender.
    ///
    /// - Side effects: none (a fresh ephemeral key reads the system random source).
    private func performWrite(payload: Data) throws(NoiseError) -> Data {
        guard isOurTurnToWrite else { throw .invalidState }
        guard payload.count <= Self.maxPayloadLength else { throw .payloadTooLong }
        var message = Data()
        for token in pattern.messages[messageIndex] {
            switch token {
            case .e:
                let ephemeral = fixedEphemeral ?? Curve25519.KeyAgreement.PrivateKey()
                fixedEphemeral = nil
                localEphemeral = ephemeral
                let raw = ephemeral.publicKey.rawRepresentation
                message += raw
                symmetric.mixHash(raw)
                if pattern.usesPSK { symmetric.mixKey(raw) }
            case .s:
                message += try symmetric.encryptAndHash(localStatic.publicKey.rawRepresentation)
            case .psk:
                try mixPSK()
            case .ee, .es, .se, .ss:
                try mixDH(token)
            }
        }
        message += try symmetric.encryptAndHash(payload)
        advance()
        return message
    }

    /// Processes the tokens of the next message as the receiver.
    ///
    /// - Side effects: none.
    private func performRead(message: Data) throws(NoiseError) -> Data {
        guard !isOurTurnToWrite else { throw .invalidState }
        guard message.count <= Self.maxMessageLength else { throw .messageTooLong }
        var rest = message[...]
        for token in pattern.messages[messageIndex] {
            switch token {
            case .e:
                let raw = try take(32, from: &rest)
                remoteEphemeral = try Self.publicKey(raw)
                symmetric.mixHash(raw)
                if pattern.usesPSK { symmetric.mixKey(raw) }
            case .s:
                let length = symmetric.cipher.hasKey ? 48 : 32
                let raw = try symmetric.decryptAndHash(try take(length, from: &rest))
                remoteStatic = try Self.publicKey(raw)
            case .psk:
                try mixPSK()
            case .ee, .es, .se, .ss:
                try mixDH(token)
            }
        }
        let tagLength = symmetric.cipher.hasKey ? 16 : 0
        guard rest.count >= tagLength else { throw .messageTooShort }
        guard rest.count - tagLength <= Self.maxPayloadLength else { throw .payloadTooLong }
        let payload = try symmetric.decryptAndHash(Data(rest))
        advance()
        return payload
    }

    /// Mixes the DH result a token names, picking keys by role (Noise §7.1).
    ///
    /// - Side effects: none.
    private func mixDH(_ token: NoisePattern.Token) throws(NoiseError) {
        let isInitiator = role == .initiator
        let pair: (Curve25519.KeyAgreement.PrivateKey?, Curve25519.KeyAgreement.PublicKey?)
        switch token {
        case .ee: pair = (localEphemeral, remoteEphemeral)
        case .es: pair = isInitiator ? (localEphemeral, remoteStatic) : (localStatic, remoteEphemeral)
        case .se: pair = isInitiator ? (localStatic, remoteEphemeral) : (localEphemeral, remoteStatic)
        case .ss: pair = (localStatic, remoteStatic)
        case .e, .s, .psk: throw .invalidState
        }
        guard let privateKey = pair.0, let publicKey = pair.1 else { throw .invalidState }
        symmetric.mixKey(try Self.dh(privateKey, publicKey))
    }

    /// Mixes the pre-shared key (the `psk` token).
    ///
    /// - Side effects: none.
    private func mixPSK() throws(NoiseError) {
        guard let psk else { throw .invalidState }
        symmetric.mixKeyAndHash(psk)
    }

    /// Moves to the next message, or to `complete` after the last one.
    ///
    /// - Side effects: none.
    private func advance() {
        messageIndex += 1
        if messageIndex == pattern.messages.count { phase = .complete }
    }

    /// Marks the handshake unusable and drops its secrets.
    ///
    /// - Side effects: none.
    private func invalidate() {
        phase = .invalidated
        dropSecrets()
    }

    /// Releases references to the ephemeral key and the PSK.
    ///
    /// - Remarks: Swift cannot reliably zero `Data` or CryptoKit keys; dropping the references
    ///   is the best this layer can do (README "已知限制").
    /// - Side effects: none.
    private func dropSecrets() {
        localEphemeral = nil
        fixedEphemeral = nil
        psk = nil
    }

    /// Splits `count` bytes off the front of `rest`.
    ///
    /// - Side effects: none.
    private func take(_ count: Int, from rest: inout Data.SubSequence) throws(NoiseError) -> Data {
        guard rest.count >= count else { throw .messageTooShort }
        let head = Data(rest.prefix(count))
        rest = rest.dropFirst(count)
        return head
    }

    /// Parses a received X25519 public key.
    ///
    /// - Side effects: none.
    private static func publicKey(_ raw: Data) throws(NoiseError) -> Curve25519.KeyAgreement.PublicKey {
        do {
            return try Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw)
        } catch {
            throw .lowOrderPublicKey
        }
    }

    /// X25519 with the all-zero check SPEC-0005 requires.
    ///
    /// - Remarks: CryptoKit already throws for low-order points; the explicit check keeps the
    ///   rule independent of that undocumented behaviour. The OR-fold has no early exit.
    /// - Side effects: none.
    private static func dh(
        _ privateKey: Curve25519.KeyAgreement.PrivateKey,
        _ publicKey: Curve25519.KeyAgreement.PublicKey
    ) throws(NoiseError) -> Data {
        let shared: SharedSecret
        do {
            shared = try privateKey.sharedSecretFromKeyAgreement(with: publicKey)
        } catch {
            throw .lowOrderPublicKey
        }
        let bytes = shared.withUnsafeBytes { Data($0) }
        guard bytes.reduce(0, |) != 0 else { throw .lowOrderPublicKey }
        return bytes
    }
}

/// What a finished handshake hands over.
public struct NoiseHandshakeResult {
    /// The transport cipher pair for this side.
    public let transport: NoiseTransport
    /// The final handshake hash `h`, the input to the pairing code.
    public let handshakeHash: Data
    /// The peer's static public key, now authenticated.
    public let remoteStaticPublicKey: Data
}
