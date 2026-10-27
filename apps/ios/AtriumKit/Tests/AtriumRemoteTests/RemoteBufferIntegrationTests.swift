import AtriumNoise
import AtriumTestSupport
import Foundation
import Testing

@testable import AtriumRemote

/// Exercises overflow through the actual receive loop rather than only the private queue.
///
/// - Remark: The stopped consumer must cause explicit failure and teardown, never silent message loss.
@Suite("Remote buffer integration", ConnectionResourceScope())
struct RemoteBufferIntegrationTests {
  @Test("the 1025th unread empty message closes the current connection")
  func unreadCountCloses() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    let side = try await h.open(connection)
    var reader = connection.messages.makeAsyncIterator()
    for _ in 0..<1024 { try await side.send(Data()) }
    try await barrier(side)
    #expect(await connection.status == .syncing)
    #expect(await connection.unreadMessageCount == 1024)
    #expect(await connection.unreadByteCount == 0)
    try await side.send(Data())
    try await eventually { await connection.status == .reconnecting }
    #expect(await connection.lastFailure == .backpressure)
    #expect(await connection.unreadMessageCount == 0)
    #expect(await connection.unreadByteCount == 0)
    #expect(h.relay.requested.count == 1)
    try await waitForRetry(h, attempts: 1, delay: .seconds(1))
    h.clock.advance(by: .seconds(1))
    let next = try await h.open(connection)
    let fresh = Data("fresh".utf8)
    try await next.send(fresh)
    let delivered = try #require(await reader.next(isolation: #isolation))
    #expect(delivered.data == fresh)
    #expect(await delivered.generation == connection.generation)
    #expect(await connection.unreadByteCount == 0)
    await connection.stop()
    #expect(await reader.next(isolation: #isolation) == nil)
  }

  @Test("exactly 16 MiB of unread payload fits, then one byte closes without replay")
  func unreadBytesClose() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    let side = try await h.open(connection)
    let message = Data(repeating: 0x61, count: 65_536)
    for _ in 0..<32 {
      for _ in 0..<8 { try await side.send(message) }
      try await barrier(side)
    }
    #expect(await connection.status == .syncing)
    #expect(await connection.unreadByteCount == 16 * 1024 * 1024)
    #expect(await connection.unreadMessageCount == 256)
    try await side.send(Data([0x61]))
    try await eventually { await connection.status == .reconnecting }
    #expect(await connection.lastFailure == .backpressure)
    #expect(await connection.unreadByteCount == 0)
    #expect(await connection.unreadMessageCount == 0)
    #expect(h.relay.requested.count == 1)
  }

  @Test("two maximum host messages remain complete through framing and nonce progression")
  func maximumHostMessages() async throws {
    let (channel, host, peer) = try openChannel(stopwatch: Stopwatch(ManualClock()))
    defer {
      channel.abort()
      peer.close()
    }
    let message = Data(repeating: 0x61, count: 8 * 1024 * 1024)
    for _ in 0..<2 {
      for frame in try ChannelFrame.chunks(of: message, limit: ChannelLimits.hostToPhone) {
        try await peer.send(host.encrypt(frame.encoded()))
      }
      #expect(try await channel.nextEvent() == .message(message))
    }
  }

  @Test("public send overflow closes the old writer and reconnects without replaying unacknowledged messages")
  func outboundOverflowReconnects() async throws {
    let h = Harness()
    let link = try PairingLink(h.host.linkText)
    let endpoint = try #require(clientEndpoint(relay: link.relay, hostId: link.hostId))
    let transport = PausedConnectionTransport(h.relay.connect(endpoint))
    defer {
      transport.close()
      transport.releaseClosedRead()
    }
    let key = try h.store.deviceKey()
    try h.store.savePending(HostRecord(pending: link))
    let pairingTask = Task {
      try await RemoteHandshake.pair(
        link: link, deviceKey: key, info: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
        transport: transport, stopwatch: h.stopwatch)
    }
    defer { pairingTask.cancel() }
    let incoming = await h.relay.next()
    let oldSide = try await h.host.accept(incoming.host, stopwatch: h.stopwatch)
    defer { oldSide.channel?.abort() }
    let pairing = try await pairingTask.value
    defer { pairing.channel.abort() }
    #expect(try await oldSide.nextControl() == .pairConfirm)
    try await oldSide.send(.paired(deviceId: h.host.deviceId, hostName: h.host.record.hostName))
    _ = try await RemoteHandshake.awaitPaired(pairing.channel)
    let record = try h.store.confirm(HostRecord(pending: link), deviceId: h.host.deviceId)
    let connection = RemoteConnection(
      host: record, deviceKey: key, store: h.store, environment: h.environment, handover: pairing.channel)
    ConnectionTestResources.current?.register(connection, clock: h.clock)
    await connection.start()
    try await oldSide.answerHello(protocolVersion: h.environment.protocolVersion)
    try await eventually { await connection.status == .syncing }
    try await eventually { h.clock.sleeperCount == 1 && pairing.channel.bufferedByteCount == 0 }
    let oldGeneration = await connection.generation
    await connection.markSynced(generation: oldGeneration)
    transport.pauseWriter()

    // Public send only enqueues this marker body; a blocked writer means no host acknowledgement.
    var oldCommand = Data("{\"type\":\"ping\",\"id\":\"old\",\"padding\":\"".utf8)
    oldCommand.append(Data(repeating: 0x61, count: (1 << 20) - oldCommand.count - 2))
    oldCommand.append(Data("\"}".utf8))
    try await connection.send(oldCommand, generation: oldGeneration)
    try await eventually { transport.hasBlockedWriter }
    #expect(pairing.channel.bufferedByteCount == oldCommand.count + 17 * 17)
    #expect(pairing.channel.bufferedFrameCount == 16)
    await #expect(throws: RemoteError.backpressure) {
      try await connection.send(oldCommand, generation: oldGeneration)
    }
    // The terminal read is still held: this transition must come from send's failure handling.
    try #require(await connection.status == .reconnecting)
    #expect(await connection.lastFailure == .backpressure)
    #expect(transport.isClosed)
    await pairing.channel.waitForWriter()
    #expect(!transport.hasBlockedWriter)
    #expect(pairing.channel.bufferedByteCount == 0)
    #expect(pairing.channel.bufferedFrameCount == 0)
    try await eventually { transport.hasHeldRead }
    #expect(!transport.terminalReadReturned)

    try await waitForRetry(h, attempts: 1, delay: .seconds(1))
    h.clock.advance(by: .seconds(1))
    let (newSide, hello) = try await h.acceptConnect()
    defer { newSide.channel?.abort() }
    #expect(newSide.mode == .ik)
    #expect(hello["clientId"] as? String == h.host.deviceId)
    try await eventually { await connection.status == .syncing }
    let newGeneration = await connection.generation
    #expect(newGeneration > oldGeneration)
    #expect(h.relay.requested.count == 2)
    await connection.markSynced(generation: newGeneration)

    // A cancelled old receive now completes after the new IK/hello, not before the reconnect.
    transport.releaseClosedRead()
    try await eventually { transport.terminalReadReturned }
    await #expect(throws: RemoteError.closed) {
      try await connection.send(oldCommand, generation: oldGeneration)
    }
    let fresh = Data(#"{"type":"ping","id":"fresh"}"#.utf8)
    try await connection.send(fresh, generation: newGeneration)
    #expect(try await newSide.nextMessage() == fresh)
    let response = Data(#"{"type":"pong","id":"fresh"}"#.utf8)
    try await newSide.send(response)
    try await eventually {
      let unread = await connection.unreadMessageCount
      let status = await connection.status
      return unread == 1 || status != .connected
    }
    try #require(await connection.status == .connected)
    var messages = connection.messages.makeAsyncIterator()
    let reply = try #require(await messages.next(isolation: #isolation))
    #expect(reply == RemoteMessage(generation: newGeneration, data: response))
    #expect(await connection.generation == newGeneration)
    #expect(await connection.status == .connected)
    #expect(await connection.lastFailure == .backpressure)
    #expect(pairing.channel.bufferedByteCount == 0)
    #expect(h.relay.requested.count == 2)
    await connection.stop()
    await newSide.close()
    try await eventually { h.clock.sleeperCount == 0 }
    #expect(await connection.unreadByteCount == 0)
    #expect(await connection.unreadMessageCount == 0)
    #expect(await messages.next(isolation: #isolation) == nil)
  }

  /// Proves all earlier host messages reached the receive loop without consuming application messages.
  ///
  /// - Remark: A heartbeat ACK is ordered after preceding frames on the same Noise stream.
  /// - SideEffects: Sends a heartbeat and reads control/heartbeat events.
  /// - Parameter side: Authenticated host endpoint.
  /// - Throws: If the connection closed or the channel failed.
  private func barrier(_ side: HostSide) async throws {
    let channel = try #require(side.channel)
    try await channel.sendHeartbeat()
    while try await side.next() != .heartbeatAck {}
  }
}
