import AtriumNoiseSpike
import Foundation

/// An established Noise channel over a ``FrameSocket``: framing, chunking, heartbeats.
///
/// - Remarks: Encryption happens in the actor, in call order, and the ciphertexts go through one
///   writer task, so concurrent senders can never put nonces on the wire out of order. One
///   consumer calls ``nextEvent()``. Any failure closes the socket (SPEC-0005: failures close the
///   channel, no recovery inside it).
/// - Side effects: Owns a writer task and the socket; ``close()`` ends both.
public actor SecureChannel {
    /// The final handshake hash, input of the pairing code.
    public nonisolated let handshakeHash: Data
    private let socket: any FrameSocket
    private let transport: NoiseTransport
    private let sendLimit: Int
    private let clock = ContinuousClock()
    private var reassembler: FrameReassembler<ContinuousClock.Instant>
    private let outbox: AsyncStream<Data>.Continuation
    private let writer: Task<Void, Never>
    private var closed = false

    /// Wraps a finished handshake.
    ///
    /// - Parameters:
    ///   - socket: The socket the handshake ran on.
    ///   - transport: From ``NoiseHandshake/split()``.
    ///   - handshakeHash: From ``NoiseHandshake/split()``.
    ///   - receiveLimit: Largest incoming message; 8 MiB on the phone.
    ///   - sendLimit: Largest outgoing message; 1 MiB on the phone.
    ///   - chunkTimeout: How long an incoming chunked message may stay open.
    /// - Side effects: Starts the writer task.
    public init(
        socket: any FrameSocket,
        transport: sending NoiseTransport,
        handshakeHash: Data,
        receiveLimit: Int = ChannelLimits.hostToPhone,
        sendLimit: Int = ChannelLimits.phoneToHost,
        chunkTimeout: Duration = ChannelLimits.chunkTimeout
    ) {
        self.socket = socket
        self.transport = transport
        self.handshakeHash = handshakeHash
        self.sendLimit = sendLimit
        reassembler = FrameReassembler(limit: receiveLimit, timeout: chunkTimeout)
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        outbox = continuation
        writer = Task {
            for await frame in stream {
                do {
                    try await socket.send(frame)
                } catch {
                    socket.close()
                    return
                }
            }
        }
    }

    /// Sends one Atrium message, chunked as needed.
    ///
    /// - Side effects: Queues frames on the socket.
    /// - Throws: ``RemoteError/messageTooLarge(limit:)``, ``RemoteError/noise(_:)`` or
    ///   ``RemoteError/socketClosed``.
    public func sendMessage(_ message: Data) throws(RemoteError) {
        let frames: [ChannelFrame]
        do {
            frames = try ChannelFrame.chunks(of: message, limit: sendLimit)
        } catch {
            fail()
            throw error
        }
        for frame in frames { try send(frame) }
    }

    /// Sends a control message (frame type 0x04).
    ///
    /// - Side effects: Queues a frame on the socket.
    /// - Throws: ``RemoteError/noise(_:)`` or ``RemoteError/socketClosed``.
    public func sendControl(_ message: ControlMessage) throws(RemoteError) {
        try send(.control(RemoteJSON.encode(message)))
    }

    /// Sends a heartbeat (0x02).
    ///
    /// - Side effects: Queues a frame on the socket.
    /// - Throws: ``RemoteError/noise(_:)`` or ``RemoteError/socketClosed``.
    public func sendHeartbeat() throws(RemoteError) {
        try send(.heartbeat)
    }

    /// Waits for the next event; answers the peer's heartbeats by itself.
    ///
    /// - Remarks: While a chunked message is open, the wait is bounded by its 30-second deadline.
    /// - Side effects: Reads from the socket; may queue a heartbeat answer; closes the channel on
    ///   any failure.
    /// - Throws: ``RemoteError``.
    public func nextEvent() async throws(RemoteError) -> ChannelEvent {
        while true {
            guard !closed else { throw .socketClosed }
            let ciphertext = try await receiveFrame()
            do throws(RemoteError) {
                let plaintext: Data
                do {
                    plaintext = try transport.decrypt(ciphertext)
                } catch {
                    throw RemoteError.noise(error)
                }
                guard let event = try reassembler.receive(ChannelFrame.decode(plaintext), at: clock.now) else {
                    continue
                }
                if event == .heartbeat { try send(.heartbeatAck) }
                return event
            } catch {
                fail()
                throw error
            }
        }
    }

    /// Sends what is queued, then closes the socket.
    ///
    /// - Side effects: Closes the network connection; ends the writer task.
    public func close() async {
        guard !closed else { return }
        closed = true
        outbox.finish()
        await writer.value
        socket.close()
    }

    /// Encrypts one frame and queues it.
    ///
    /// - Side effects: Queues a frame on the socket; closes the channel when encryption fails.
    private func send(_ frame: ChannelFrame) throws(RemoteError) {
        guard !closed else { throw .socketClosed }
        do {
            outbox.yield(try transport.encrypt(frame.encoded()))
        } catch {
            fail()
            throw .noise(error)
        }
    }

    /// Receives one ciphertext, bounded by the open chunk's deadline if there is one.
    ///
    /// - Side effects: Reads from the socket; closes the channel on failure or timeout.
    private func receiveFrame() async throws(RemoteError) -> Data {
        let socket = socket
        let deadline = reassembler.deadline
        let result: Data?
        do {
            result = try await withThrowingTaskGroup(of: Data?.self) { group in
                group.addTask { try await socket.receive() }
                if let deadline {
                    group.addTask {
                        try await Task.sleep(until: deadline, clock: .continuous)
                        return nil
                    }
                }
                let first = try await group.next() ?? nil
                // Closing is what unblocks a pending receive; cancellation alone may not.
                if first == nil { socket.close() }
                group.cancelAll()
                return first
            }
        } catch {
            fail()
            throw .socketClosed
        }
        guard let result else {
            fail()
            throw .chunkTimeout
        }
        return result
    }

    /// Marks the channel closed and releases the socket and writer.
    ///
    /// - Side effects: Closes the network connection; ends the writer task.
    private func fail() {
        guard !closed else { return }
        closed = true
        outbox.finish()
        writer.cancel()
        socket.close()
    }
}
