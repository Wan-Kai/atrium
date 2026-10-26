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
