import AtriumNoise
import Foundation
import Synchronization

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
  private let outbox: CiphertextBuffer
  private let writer: Task<Void, Never>
  private var closed = false
  nonisolated var bufferedByteCount: Int { outbox.bufferedByteCount }
  nonisolated var bufferedFrameCount: Int { outbox.bufferedFrameCount }

  /// Waits for the owned writer to exit without performing a second cleanup.
  ///
  /// - Remark: Lifecycle tests use this to observe late completion after abort without resetting
  ///   the accounting a second time through graceful close.
  /// - SideEffects: Suspends until the writer exits.
  nonisolated func waitForWriter() async { await writer.value }

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
    let outbox = CiphertextBuffer()
    self.outbox = outbox
    writer = Task {
      while let frame = await outbox.next() {
        do {
          try await transport.send(frame)
          outbox.complete(frame.count)
        } catch {
          outbox.abort()
          transport.close()
          return
        }
      }
    }
  }

  /// Releases the writer when the last channel owner goes away.
  ///
  /// - Remark: The writer retains its queue, not this actor, so dropping the actor must explicitly
  ///   wake it rather than relying on AsyncStream continuation destruction.
  /// - SideEffects: Cancels the writer, releases queued ciphertext and closes the transport.
  deinit {
    writer.cancel()
    outbox.abort()
    transport.close()
  }

  /// Sends one Atrium message, chunked as needed.
  ///
  /// - Remark: A message over the limit is refused before anything is sent, and ends the channel
  ///   like every other failure.
  /// - SideEffects: Queues frames on the transport.
  /// - Parameter message: The encoded message.
  /// - Throws: ``RemoteError/wire(_:)``, ``RemoteError/noise(_:)``, ``RemoteError/backpressure`` or
  ///   ``RemoteError/closed``.
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
  /// - Throws: ``RemoteError/noise(_:)``, ``RemoteError/badPayload``, ``RemoteError/backpressure`` or
  ///   ``RemoteError/closed``.
  public func sendControl(_ message: ControlMessage) throws(RemoteError) {
    try send(.control(RemoteJSON.encode(message)))
  }

  /// Sends a heartbeat (0x02).
  ///
  /// - Remark: The host answers with 0x03.
  /// - SideEffects: Queues a frame on the transport.
  /// - Throws: ``RemoteError/noise(_:)``, ``RemoteError/backpressure`` or ``RemoteError/closed``.
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
    outbox.abort()
    transport.close()
  }

  /// Encrypts one frame and queues it.
  ///
  /// - Remark: Encrypting here, in call order, is what keeps nonces in order on the wire.
  /// - SideEffects: Queues a frame; closes the channel when encryption or the byte budget fails.
  /// - Parameter frame: The frame.
  /// - Throws: ``RemoteError/noise(_:)``, ``RemoteError/backpressure`` or ``RemoteError/closed``.
  private func send(_ frame: ChannelFrame) throws(RemoteError) {
    guard !closed, !writer.isCancelled, !outbox.isAborted else { throw .closed }
    let ciphertext: Data
    do {
      ciphertext = try noise.encrypt(frame.encoded())
    } catch {
      fail()
      throw .noise(error)
    }
    guard outbox.enqueue(ciphertext) else {
      fail()
      throw .backpressure
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

/// A channel-local FIFO whose byte budget includes the writer's in-flight ciphertext.
///
/// - Remark: One writer owns dequeue/completion; abort can synchronously release the queue from
///   any task. This buffer is never reused by another channel or connection generation.
private final class CiphertextBuffer: Sendable {
  /// Queue, accounting and the sole writer's wake-up under one mutex.
  ///
  /// - Remark: Finishing drains queued frames; aborting discards them and invalidates completion.
  private struct State {
    var frames: [Data?] = []
    var head = 0
    var bytes = 0
    var finished = false
    var aborted = false
    var waiter: CheckedContinuation<Void, Never>?
  }

  private let state = Mutex(State())
  private let byteLimit = 2 * 1024 * 1024
  var bufferedByteCount: Int { state.withLock { $0.bytes } }
  var bufferedFrameCount: Int { state.withLock { $0.frames.count - $0.head } }
  var isAborted: Bool { state.withLock { $0.aborted } }

  /// Reserves bytes and appends ciphertext without removing earlier frames.
  ///
  /// - Remark: Rejecting rather than dropping preserves the Noise nonce sequence.
  /// - SideEffects: Retains ciphertext and wakes the writer.
  /// - Parameter frame: The encrypted frame including its authentication tag.
  /// - Returns: Whether the live queue has enough remaining budget.
  func enqueue(_ frame: Data) -> Bool {
    let result = state.withLock { state -> (Bool, CheckedContinuation<Void, Never>?) in
      guard !state.finished, frame.count <= byteLimit - state.bytes else { return (false, nil) }
      state.frames.append(frame)
      state.bytes += frame.count
      let waiter = state.waiter
      state.waiter = nil
      return (true, waiter)
    }
    result.1?.resume()
    return result.0
  }

  /// Hands a ciphertext to the writer without releasing its reserved bytes.
  ///
  /// - Remark: Dequeue is not send completion; a blocked socket still owns the full frame budget.
  /// - SideEffects: Removes a frame from queued storage or suspends the writer.
  /// - Returns: The oldest ciphertext, or nil after draining or abort.
  func next() async -> Data? {
    while !Task.isCancelled {
      let result = state.withLock { state -> (Data?, Bool) in
        guard state.head < state.frames.count else { return (nil, state.finished) }
        let frame = state.frames[state.head]
        state.frames[state.head] = nil
        state.head += 1
        if state.head >= 64 && state.head * 2 >= state.frames.count {
          state.frames.removeFirst(state.head)
          state.head = 0
        }
        return (frame, false)
      }
      if let frame = result.0 { return frame }
      if result.1 { return nil }
      await withCheckedContinuation { continuation in
        let resume = state.withLock { state in
          if state.finished || state.head < state.frames.count { return true }
          state.waiter = continuation
          return false
        }
        if resume { continuation.resume() }
      }
    }
    return nil
  }

  /// Releases the frame budget after the transport actually accepted it.
  ///
  /// - Remark: An abort has already released all reservations, so a late completion is ignored.
  /// - SideEffects: Decrements live reserved bytes.
  /// - Parameter bytes: Size of the frame just sent by the sole writer.
  func complete(_ bytes: Int) {
    state.withLock { state in
      guard !state.aborted else { return }
      state.bytes -= bytes
    }
  }

  /// Stops accepting frames while allowing the writer to drain existing reservations.
  ///
  /// - Remark: Graceful close gives final control messages a bounded chance to reach the peer.
  /// - SideEffects: Wakes the writer if it was idle.
  func finish() {
    let waiter = state.withLock { state in
      state.finished = true
      let waiter = state.waiter
      state.waiter = nil
      return waiter
    }
    waiter?.resume()
  }

  /// Releases all queued ciphertext and invalidates any outstanding send completion.
  ///
  /// - Remark: The channel cancels the writer and closes the socket to release its in-flight frame.
  /// - SideEffects: Drops retained frames, resets accounting and wakes the writer.
  func abort() {
    let waiter = state.withLock { state in
      state.finished = true
      state.aborted = true
      state.frames.removeAll()
      state.head = 0
      state.bytes = 0
      let waiter = state.waiter
      state.waiter = nil
      return waiter
    }
    waiter?.resume()
  }
}
