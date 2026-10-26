import AtriumNoise
import Foundation

/// An established Noise channel over a ``RemoteTransport``: framing, chunking, heartbeats.
///
/// - Remark: Encryption happens in the actor, in call order, and the ciphertexts go through one
///   writer task, so concurrent senders can never put nonces on the wire out of order. One consumer
///   calls ``nextEvent()``. Any failure closes the transport (SPEC-0005: failures close the channel,
///   no recovery inside it).
public actor SecureChannel {
  /// The final handshake hash, input of the pairing code.
  public nonisolated let handshakeHash: Data
  private let transport: any RemoteTransport
  private let noise: NoiseTransport
  private let sendLimit: Int
  private let stopwatch: Stopwatch
  private var reassembler: FrameReassembler<Elapsed>
  private let outbox: AsyncStream<Data>.Continuation
  private let writer: Task<Void, Never>
  private var closed = false

  /// Wraps a finished handshake.
  ///
  /// - Remark: The phone's limits are the defaults: 8 MiB in, 1 MiB out (SPEC-0005 "大小"); tests
  ///   playing the host swap them.
  /// - SideEffects: Starts the writer task.
  /// - Parameters:
  ///   - transport: The connection the handshake ran on.
  ///   - noise: From ``NoiseHandshake/split()``.
  ///   - handshakeHash: From ``NoiseHandshake/split()``.
  ///   - stopwatch: The injected clock, for the chunk timeout.
  ///   - receiveLimit: Largest incoming message.
  ///   - sendLimit: Largest outgoing message.
  ///   - chunkTimeout: How long an incoming chunked message may stay open.
  public init(
    transport: any RemoteTransport,
    noise: sending NoiseTransport,
    handshakeHash: Data,
    stopwatch: Stopwatch,
    receiveLimit: Int = ChannelLimits.hostToPhone,
    sendLimit: Int = ChannelLimits.phoneToHost,
    chunkTimeout: Duration = ChannelLimits.chunkTimeout
  ) {
    self.transport = transport
    self.noise = noise
    self.handshakeHash = handshakeHash
    self.sendLimit = sendLimit
    self.stopwatch = stopwatch
    reassembler = FrameReassembler(limit: receiveLimit, timeout: chunkTimeout)
    let (stream, continuation) = AsyncStream<Data>.makeStream()
    outbox = continuation
    writer = Task {
      for await frame in stream {
        do {
          try await transport.send(frame)
        } catch {
          transport.close()
          return
        }
      }
    }
  }

  /// Sends one Atrium message, chunked as needed.
  ///
  /// - Remark: A message over the limit is refused before anything is sent, and ends the channel
  ///   like every other failure.
  /// - SideEffects: Queues frames on the transport.
  /// - Parameter message: The encoded message.
  /// - Throws: ``RemoteError/wire(_:)``, ``RemoteError/noise(_:)`` or ``RemoteError/closed``.
  public func sendMessage(_ message: Data) throws(RemoteError) {
    let frames: [ChannelFrame]
    do {
      frames = try ChannelFrame.chunks(of: message, limit: sendLimit)
    } catch {
      fail()
      throw .wire(error)
    }
    for frame in frames { try send(frame) }
  }

  /// Sends a control message (frame type 0x04).
  ///
  /// - Remark: Single chunk by definition.
  /// - SideEffects: Queues a frame on the transport.
  /// - Parameter message: The control message.
  /// - Throws: ``RemoteError/noise(_:)``, ``RemoteError/badPayload`` or ``RemoteError/closed``.
  public func sendControl(_ message: ControlMessage) throws(RemoteError) {
    try send(.control(RemoteJSON.encode(message)))
  }

  /// Sends a heartbeat (0x02).
  ///
  /// - Remark: The host answers with 0x03.
  /// - SideEffects: Queues a frame on the transport.
  /// - Throws: ``RemoteError/noise(_:)`` or ``RemoteError/closed``.
  public func sendHeartbeat() throws(RemoteError) {
    try send(.heartbeat)
  }

  /// Waits for the next event; answers the peer's heartbeats by itself.
  ///
  /// - Remark: While a chunked message is open, the wait is bounded by its 30-second deadline.
  /// - SideEffects: Reads from the transport; may queue a heartbeat answer; closes the channel on
  ///   any failure.
  /// - Returns: The event.
  /// - Throws: ``RemoteError``.
  public func nextEvent() async throws(RemoteError) -> ChannelEvent {
    while true {
      guard !closed, !writer.isCancelled else { throw .closed }
      let ciphertext = try await receiveFrame()
      guard !closed, !writer.isCancelled else { throw .closed }
      do throws(RemoteError) {
        let plaintext: Data
        do {
          plaintext = try noise.decrypt(ciphertext)
        } catch {
          throw RemoteError.noise(error)
        }
        let event: ChannelEvent?
        do {
          event = try reassembler.receive(ChannelFrame.decode(plaintext), at: stopwatch.now)
        } catch {
          throw RemoteError.wire(error)
        }
        guard let event else { continue }
        if event == .heartbeat { try send(.heartbeatAck) }
        return event
      } catch {
        fail()
        throw error
      }
    }
  }

  /// Sends what is queued, then closes the transport.
  ///
  /// - Remark: Gives final control messages at most two seconds to drain. Teardown that must not
  ///   wait uses ``abort()`` instead.
  /// - SideEffects: Closes the network connection; ends the writer task.
  public func close() async {
    guard !closed else { return }
    closed = true
    outbox.finish()
    let writer = writer
    let stopwatch = stopwatch
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await writer.value }
      group.addTask { try? await stopwatch.sleep(for: .seconds(2)) }
      _ = await group.next()
      abort()
      group.cancelAll()
    }
  }

  /// Immediately closes the underlying socket and cancels its writer.
  ///
  /// - Remark: Synchronous and nonisolated so connection teardown cannot leave an unowned cleanup
  ///   task waiting on backpressure. Cancelling alone is insufficient for some transports.
  /// - SideEffects: Closes the transport and ends queued writes without flushing.
  public nonisolated func abort() {
    writer.cancel()
    outbox.finish()
    transport.close()
  }

  /// Encrypts one frame and queues it.
  ///
  /// - Remark: Encrypting here, in call order, is what keeps nonces in order on the wire.
  /// - SideEffects: Queues a frame; closes the channel when encryption fails.
  /// - Parameter frame: The frame.
  /// - Throws: ``RemoteError/noise(_:)`` or ``RemoteError/closed``.
  private func send(_ frame: ChannelFrame) throws(RemoteError) {
    guard !closed, !writer.isCancelled else { throw .closed }
    do {
      outbox.yield(try noise.encrypt(frame.encoded()))
    } catch {
      fail()
      throw .noise(error)
    }
  }

  /// Receives one ciphertext, bounded by the open chunk's deadline if there is one.
  ///
  /// - Remark: Closing the transport is what unblocks a pending receive; cancellation alone may not.
  /// - SideEffects: Reads from the transport; closes the channel on failure or timeout.
  /// - Returns: The ciphertext.
  /// - Throws: ``RemoteError/transport(_:)`` or ``RemoteError/wire(_:)`` with the chunk timeout.
  private func receiveFrame() async throws(RemoteError) -> Data {
    let transport = transport
    let stopwatch = stopwatch
    let wait = reassembler.deadline.map { stopwatch.now.duration(to: $0) }
    let result: Result<Data, TransportError>?
    result = await withTaskGroup(of: Result<Data, TransportError>?.self) { group in
      group.addTask {
        do throws(TransportError) {
          return .success(try await transport.receive())
        } catch {
          return .failure(error)
        }
      }
      if let wait {
        group.addTask {
          try? await stopwatch.sleep(for: wait)
          return nil
        }
      }
      let first = await group.next() ?? nil
      if first == nil { transport.close() }
      group.cancelAll()
      return first
    }
    switch result {
    case .success(let data): return data
    case .failure(let error):
      fail()
      throw .transport(error)
    case nil:
      fail()
      throw .wire(.chunkTimeout)
    }
  }

  /// Marks the channel closed and releases the transport and writer.
  ///
  /// - Remark: Unlike ``close()`` it does not wait for queued frames.
  /// - SideEffects: Closes the network connection; ends the writer task.
  private func fail() {
    guard !closed else { return }
    closed = true
    abort()
  }
}
