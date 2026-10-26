import AtriumNoiseSpike
import CryptoKit
import Foundation
import Synchronization

@testable import AtriumRemoteSpike

extension Data {
    /// Decodes hex; `nil` when malformed.
    init?(hexString hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
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

/// One direction of an in-memory socket pair.
final class Mailbox: Sendable {
    private struct State {
        var queue: [Data] = []
        var waiters: [CheckedContinuation<Data, any Error>] = []
        var closed = false
    }

    private let state = Mutex(State())

    func put(_ frame: Data) {
        let waiter: CheckedContinuation<Data, any Error>? = state.withLock { state in
            guard !state.closed else { return nil }
            if state.waiters.isEmpty {
                state.queue.append(frame)
                return nil
            }
            return state.waiters.removeFirst()
        }
        waiter?.resume(returning: frame)
    }

    func take() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let result: Result<Data, any Error>? = state.withLock { state in
                if !state.queue.isEmpty { return .success(state.queue.removeFirst()) }
                if state.closed { return .failure(RemoteError.socketClosed) }
                state.waiters.append(continuation)
                return nil
            }
            if let result { continuation.resume(with: result) }
        }
    }

    func close() {
        let waiters = state.withLock { state in
            state.closed = true
            defer { state.waiters = [] }
            return state.waiters
        }
        for waiter in waiters { waiter.resume(throwing: RemoteError.socketClosed) }
    }

    var isClosed: Bool { state.withLock { $0.closed } }
}

/// An in-memory ``FrameSocket``; closing either end closes both directions, like a WebSocket.
final class MemorySocket: FrameSocket {
    let inbox: Mailbox
    let outbox: Mailbox
    /// Every frame this end sent, in order.
    let sent = Mutex<[Data]>([])

    init(inbox: Mailbox, outbox: Mailbox) {
        self.inbox = inbox
        self.outbox = outbox
    }

    /// Two connected ends.
    static func pair() -> (MemorySocket, MemorySocket) {
        let a = Mailbox()
        let b = Mailbox()
        return (MemorySocket(inbox: a, outbox: b), MemorySocket(inbox: b, outbox: a))
    }

    func send(_ frame: Data) async throws {
        guard !outbox.isClosed else { throw RemoteError.socketClosed }
        sent.withLock { $0.append(frame) }
        outbox.put(frame)
    }

    func receive() async throws -> Data { try await inbox.take() }

    func close() {
        inbox.close()
        outbox.close()
    }

    var isClosed: Bool { inbox.isClosed }
}

/// What the test host does after reading handshake message 1.
enum HostBehaviour: Sendable {
    /// Accept, and for pairing confirm with `paired`.
    case accept
    /// Refuse in handshake message 2.
    case refuseHandshake(reason: String)
    /// Accept the handshake but answer the key confirmation with `pair_rejected`.
    case rejectPairing(reason: String)
}

/// A minimal Swift stand-in for the TS fake host, for testing the phone's flows in-process.
struct TestHost: Sendable {
    let hostId = "hst_0123456789abcdef"
    let hostKey = Curve25519.KeyAgreement.PrivateKey()
    let pairingId = "pair_0123456789abcdef"
    let psk = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    let deviceId = "dev_0123456789abcdef"
    let hostName = "Test Mac"

    var link: PairingLink {
        let text =
            "atrium://pair?v=1&relay=ws://127.0.0.1:1&host=\(hostId)&key=\(hostKey.publicKey.rawRepresentation.base64URL)"
            + "&pairing=\(pairingId)&psk=\(psk.base64URL)&name=Test%20Mac"
        return try! PairingLink(text)
    }

    /// What the host saw, for assertions.
    struct Seen: Sendable {
        var mode: HandshakeMode
        var request: Data
        var code: String?
        var hello: HelloMessage?
        var deviceKey: Data
    }

    /// Serves one connection as the responder; closes the socket on any failure, as a host does.
    func serve(_ socket: MemorySocket, behaviour: HostBehaviour = .accept) async throws -> Seen {
        do {
            return try await serveOrThrow(socket, behaviour: behaviour)
        } catch {
            socket.close()
            throw error
        }
    }

    private func serveOrThrow(_ socket: MemorySocket, behaviour: HostBehaviour) async throws -> Seen {
        let (mode, first) = try AtriumWire.parseFirstFrame(try await socket.receive())
        let handshake = try NoiseHandshake(
            pattern: mode.pattern, role: .responder, prologue: AtriumWire.prologue(hostId: hostId),
            localStatic: hostKey, psk: mode == .ikpsk2 ? psk : nil)
        let request = try handshake.readMessage(first)
        var seen = Seen(mode: mode, request: request, deviceKey: handshake.remoteStaticPublicKey ?? Data())
        let reply: HandshakeReply
        switch behaviour {
        case .refuseHandshake(let reason): reply = HandshakeReply(ok: false, reason: reason)
        case .accept, .rejectPairing:
            reply = mode == .ik ? HandshakeReply(ok: true, deviceId: deviceId) : HandshakeReply(ok: true)
        }
        try await socket.send(try handshake.writeMessage(payload: RemoteJSON.encode(reply)))
        let result = try handshake.split()
        let hash = result.handshakeHash
        let channel = SecureChannel(
            socket: socket, transport: result.transport, handshakeHash: hash,
            receiveLimit: ChannelLimits.phoneToHost, sendLimit: ChannelLimits.hostToPhone)
        guard reply.ok else {
            await channel.close()
            return seen
        }
        if mode == .ikpsk2 {
            guard case .control(let body) = try await channel.nextEvent(),
                try RemoteJSON.decode(ControlMessage.self, from: body) == .pairConfirm
            else { throw RemoteError.badPayload }
            seen.code = PairingCode.digits(handshakeHash: hash)
            if case .rejectPairing(let reason) = behaviour {
                try await channel.sendControl(.pairRejected(reason: reason))
                await channel.close()
                return seen
            }
            try await channel.sendControl(.paired(deviceId: deviceId, hostName: hostName))
        }
        try await channel.sendHeartbeat()
        while true {
            switch try await channel.nextEvent() {
            case .heartbeat, .heartbeatAck, .control: continue
            case .message(let body):
                let hello = try RemoteJSON.decode(HelloMessage.self, from: body)
                seen.hello = hello
                let welcome = WelcomeMessage(
                    type: "welcome", protocolVersion: atriumProtocolVersion, hostVersion: "0.0.0",
                    hostInstanceId: "h1", heartbeatMs: 10_000)
                try await channel.sendMessage(RemoteJSON.encode(welcome))
                // Stay up for the phone's heartbeat, answered by nextEvent itself.
                while try await channel.nextEvent() != .heartbeat {}
                await channel.close()
                return seen
            }
        }
    }
}
