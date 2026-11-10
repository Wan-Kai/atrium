import AtriumNoise
import AtriumProtocol
import AtriumTestSupport
import Foundation
import Synchronization
import Testing

@testable import AtriumRemote

/// Waits until the phone made `attempts` connections and only the retry timer, set to `delay`, sleeps.
///
/// - Remark: Each attempt also has a handshake timer, cancelled when it fails; waiting for exactly
///   one sleeper with the expected wait keeps the clock steps exact and checks the backoff.
/// - SideEffects: Yields.
/// - Parameters:
///   - h: The harness.
///   - attempts: How many connections so far.
///   - delay: The backoff expected before the next one.
/// - Throws: When it never happens.
func waitForRetry(_ h: Harness, attempts: Int, delay: Duration) async throws {
  do {
    try await eventually { h.relay.requested.count == attempts && h.clock.remaining == [delay] }
  } catch {
    Issue.record("requested \(h.relay.requested.count), sleeping \(h.clock.remaining)")
    throw error
  }
}

@Suite("Remote connection", ConnectionResourceScope())
struct RemoteConnectionTests {
  @Test("connects with IK, says hello without a token as the device, syncs, then counts as connected")
  func connectsAndSyncs() async throws {
    let h = Harness()
    let connection = try h.connection()
    var statuses = StatusReader(connection)
    #expect(await statuses.next() == .connecting)
    await connection.start()
    let (side, hello) = try await h.acceptConnect()
    #expect(side.mode == .ik)
    #expect(side.deviceKey == (try h.store.deviceKey().publicKey.rawRepresentation))
    #expect(
      try RemoteJSON.decode(ConnectRequest.self, from: side.request)
        == ConnectRequest(appVersion: "0.1.0", protocolVersion: AtriumProtocol.protocolVersion))
    #expect(hello["type"] as? String == "hello")
    #expect(hello["clientId"] as? String == h.host.deviceId)
    #expect(hello["protocolVersion"] as? Int == AtriumProtocol.protocolVersion)
    #expect(hello["traceparent"] as? String == "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
    #expect(hello["token"] == nil)
    #expect(await statuses.next() == .syncing)
    #expect(await connection.status.canSend == false)

    let generation = await connection.generation
    await connection.markSynced(generation: generation - 1)
    await connection.markSynced(generation: generation)
    #expect(await statuses.next() == .connected)
    #expect(await connection.status.canSend)

    var messages = connection.messages.makeAsyncIterator()
    try await side.send(Data(#"{"type":"index_snapshot"}"#.utf8))
    #expect(
      await messages.next(isolation: #isolation)
        == RemoteMessage(generation: generation, data: Data(#"{"type":"index_snapshot"}"#.utf8)))
    try await connection.send(Data(#"{"type":"ping"}"#.utf8), generation: generation)
    #expect(try await side.nextMessage() == Data(#"{"type":"ping"}"#.utf8))
    await #expect(throws: RemoteError.closed) { try await connection.send(Data(), generation: generation + 1) }
    #expect(h.relay.requested.map(\.absoluteString) == ["wss://relay.test/atrium/v1/client?host=hst_0123456789abcdef"])
    await connection.stop()
    #expect(await statuses.next() == nil)
  }

  @Test("asks the Mac to deflate, and a deflated message arrives as the plain message")
  func deflatedMessages() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    let side = try await h.open(connection)
    let payload = try #require(try JSONSerialization.jsonObject(with: side.request) as? [String: Any])
    #expect(payload["compression"] as? [String] == ["deflate"])
    let received = Mutex<[Data]>([])
    let reader = Task { for await message in connection.messages { received.withLock { $0.append(message.data) } } }
    // `{"type":"index_snapshot"}` as the host's Node deflates it.
    let deflated = try #require(Data(base64Encoded: "q1YqqSxIVbJSysxLSa2IL85LLCjOyC9RqgUA"))
    try await #require(side.channel).send(.deflatedChunk(deflated, isLast: true))
    // Not blocking on the message: a phone that refuses the frame drops the link instead, and the
    // test fails rather than waiting for ever.
    try await eventually { await connection.status != .syncing || received.withLock { !$0.isEmpty } }
    #expect(received.withLock { $0 } == [Data(#"{"type":"index_snapshot"}"#.utf8)])
    #expect(await connection.status == .syncing)
    await connection.stop()
    reader.cancel()
  }

  @Test("device_unknown in message 2 deletes the Mac's records and stops for good")
  func deviceUnknownRevokes() async throws {
    let h = Harness()
    let connection = try h.connection()
    var statuses = StatusReader(connection)
    _ = await statuses.next()
    await connection.start()
    let incoming = await h.relay.next()
    _ = try await h.host.accept(
      incoming.host, stopwatch: h.stopwatch, answer: .reply(HandshakeReply(ok: false, reason: "device_unknown")))
    #expect(await statuses.next() == .revoked)
    #expect(try h.store.hosts().isEmpty)
    #expect(h.secrets.items["device-key"] != nil)
    try await eventually { h.clock.sleeperCount == 0 }
    h.clock.advance(by: .seconds(120))
    #expect(h.relay.requested.count == 1)
    #expect(await connection.status.isTerminal)
  }

  @Test("device_unknown for a pending pairing drops the pending record and says the pairing did not finish")
  func deviceUnknownForPending() async throws {
    let h = Harness()
    var pending = h.host.record
    pending.deviceId = nil
    let connection = try h.connection(record: pending)
    var statuses = StatusReader(connection)
    _ = await statuses.next()
    await connection.start()
    let incoming = await h.relay.next()
    _ = try await h.host.accept(
      incoming.host, stopwatch: h.stopwatch, answer: .reply(HandshakeReply(ok: false, reason: "device_unknown")))
    #expect(await statuses.next() == .pairingIncomplete)
    #expect(try h.store.pendingHosts().isEmpty)
  }

  @Test("a pending pairing the Mac did confirm becomes a full record on the first daily connection")
  func pendingIsConfirmedByIK() async throws {
    let h = Harness()
    var pending = h.host.record
    pending.deviceId = nil
    let connection = try h.connection(record: pending)
    var statuses = StatusReader(connection)
    _ = await statuses.next()
    await connection.start()
    _ = try await h.acceptConnect()
    #expect(await statuses.next() == .syncing)
    #expect(try h.store.hosts() == [h.host.record])
    #expect(try h.store.pendingHosts().isEmpty)
    #expect(await connection.host == h.host.record)
  }

  @Test("version_mismatch in message 2 stops without deleting anything")
  func versionMismatchInHandshake() async throws {
    let h = Harness()
    let connection = try h.connection()
    var statuses = StatusReader(connection)
    _ = await statuses.next()
    await connection.start()
    let incoming = await h.relay.next()
    _ = try await h.host.accept(
      incoming.host, stopwatch: h.stopwatch,
      answer: .reply(HandshakeReply(ok: false, reason: "version_mismatch", hostProtocol: 99)))
    #expect(await statuses.next() == .versionMismatch(hostProtocol: 99))
    #expect(try h.store.hosts() == [h.host.record])
    try await eventually { h.clock.sleeperCount == 0 }
    h.clock.advance(by: .seconds(120))
    #expect(h.relay.requested.count == 1)
  }

  @Test("a welcome with another protocol version stops as a version mismatch")
  func versionMismatchInWelcome() async throws {
    let h = Harness()
    let connection = try h.connection()
    var statuses = StatusReader(connection)
    _ = await statuses.next()
    await connection.start()
    _ = try await h.acceptConnect(protocolVersion: 99)
    #expect(await statuses.next() == .versionMismatch(hostProtocol: 99))
    #expect(try h.store.hosts() == [h.host.record])
  }

  @Test("revoked inside the channel deletes the Mac's records and stops")
  func revokedControl() async throws {
    let h = Harness()
    let connection = try h.connection()
    var statuses = StatusReader(connection)
    _ = await statuses.next()
    await connection.start()
    let side = try await h.open(connection)
    #expect(await statuses.next() == .syncing)
    try await side.send(.revoked)
    #expect(await statuses.next() == .revoked)
    #expect(try h.store.hosts().isEmpty)
  }

  @Test(
    "relay close codes only change the status, never delete, and are retried",
    arguments: [
      (
        TransportError.closed(code: 4404, reason: "offline:1700000000"),
        ConnectionStatus.hostOffline(lastSeen: Date(timeIntervalSince1970: 1_700_000_000))
      ),
      (.closed(code: 4404, reason: "offline:0"), .hostOffline(lastSeen: nil)),
      (.closed(code: 4401, reason: "device_unknown"), .reconnecting),
      (.closed(code: 4409, reason: "revoked"), .reconnecting),
      (.noNetwork, .noNetwork),
      (.unreachable, .relayUnreachable),
      (.failed, .reconnecting),
    ])
  func transportFailures(failure: TransportError, shown: ConnectionStatus) async throws {
    let h = Harness()
    h.relay.failNext(with: failure)
    let connection = try h.connection()
    var statuses = StatusReader(connection)
    _ = await statuses.next()
    await connection.start()
    #expect(await statuses.next() == shown)
    #expect(try h.store.hosts() == [h.host.record])
    await h.clock.waitForSleepers(1)
    h.clock.advance(by: .seconds(1))
    _ = try await h.acceptConnect()
    #expect(await statuses.next() == .syncing)
  }

  @Test("a host that closes mid-session is reconnected after a second")
  func dropFromOpenReconnects() async throws {
    let h = Harness()
    let connection = try h.connection()
    var statuses = StatusReader(connection)
    _ = await statuses.next()
    await connection.start()
    let side = try await h.open(connection)
    #expect(await statuses.next() == .syncing)
    let first = await connection.generation
    await side.close()
    #expect(await statuses.next() == .reconnecting)
    #expect(try h.store.hosts() == [h.host.record])
    await h.clock.waitForSleepers(1)
    h.clock.advance(by: .milliseconds(999))
    #expect(h.relay.requested.count == 1)
    h.clock.advance(by: .milliseconds(1))
    _ = try await h.acceptConnect()
    #expect(await statuses.next() == .syncing)
    #expect(await connection.generation > first)
  }

  @Test("reconnect waits double each time, up to 30 seconds, and the jitter only shortens them")
  func backoffDoubles() async throws {
    let h = Harness()
    for _ in 0..<7 { h.relay.failNext(with: .unreachable) }
    let connection = try h.connection()
    await connection.start()
    for (attempt, seconds) in [1, 2, 4, 8, 16, 30, 30].enumerated() {
      try await waitForRetry(h, attempts: attempt + 1, delay: .seconds(seconds))
      h.clock.advance(by: .seconds(seconds))
    }
    try await h.open(connection)
    #expect(h.relay.requested.count == 8)
    #expect(RemoteConnection.backoff(step: 0, jitter: 0) == .seconds(1))
    #expect(RemoteConnection.backoff(step: 3, jitter: 0.5) == .milliseconds(7200))
    #expect(RemoteConnection.backoff(step: 4, jitter: 0.999) < .seconds(16))
    #expect(RemoteConnection.backoff(step: 9, jitter: 0) == .seconds(30))
    #expect(RemoteConnection.backoff(step: 63, jitter: 0) == .seconds(30))
    #expect(RemoteConnection.backoff(step: 2, jitter: 1) == .milliseconds(3200))
    #expect(RemoteConnection.backoff(step: 2, jitter: 7) == .milliseconds(3200))
  }

  @Test("a network change resets the backoff and retries at once; without a network nothing is tried")
  func networkChanges() async throws {
    let h = Harness()
    for _ in 0..<3 { h.relay.failNext(with: .unreachable) }
    let connection = try h.connection()
    var statuses = StatusReader(connection)
    _ = await statuses.next()
    await connection.start()
    #expect(await statuses.next() == .relayUnreachable)
    try await waitForRetry(h, attempts: 1, delay: .seconds(1))
    h.clock.advance(by: .seconds(1))
    try await waitForRetry(h, attempts: 2, delay: .seconds(2))
    h.clock.advance(by: .seconds(2))
    try await waitForRetry(h, attempts: 3, delay: .seconds(4))

    await connection.networkChanged(available: false)
    #expect(await statuses.next() == .noNetwork)
    try await eventually { h.clock.sleeperCount == 0 }
    h.clock.advance(by: .seconds(60))
    #expect(h.relay.requested.count == 3)

    await connection.networkChanged(available: true)
    try await h.open(connection)
    #expect(await statuses.next() == .syncing)
    #expect(h.relay.requested.count == 4)
  }

  @Test("a network change while waiting retries at once, and the waits after it start at 1 s again")
  func networkChangeSkipsTheWait() async throws {
    let h = Harness()
    for _ in 0..<5 { h.relay.failNext(with: .unreachable) }
    let connection = try h.connection()
    await connection.start()
    try await waitForRetry(h, attempts: 1, delay: .seconds(1))
    h.clock.advance(by: .seconds(1))
    try await waitForRetry(h, attempts: 2, delay: .seconds(2))
    h.clock.advance(by: .seconds(2))
    try await waitForRetry(h, attempts: 3, delay: .seconds(4))
    await connection.networkChanged(available: true)
    try await waitForRetry(h, attempts: 4, delay: .seconds(1))
    h.clock.advance(by: .seconds(1))
    try await waitForRetry(h, attempts: 5, delay: .seconds(2))
    h.clock.advance(by: .seconds(2))
    try await h.open(connection)
    #expect(h.relay.requested.count == 6)
  }

  @Test("retrying now while waiting tries at once and starts the waits at 1 s again; without a network it waits")
  func retryNowSkipsTheWait() async throws {
    let h = Harness()
    for _ in 0..<4 { h.relay.failNext(with: .unreachable) }
    let connection = try h.connection()
    await connection.start()
    try await waitForRetry(h, attempts: 1, delay: .seconds(1))
    h.clock.advance(by: .seconds(1))
    try await waitForRetry(h, attempts: 2, delay: .seconds(2))
    await connection.retryNow()
    try await waitForRetry(h, attempts: 3, delay: .seconds(1))
    await connection.networkChanged(available: false)
    await connection.retryNow()
    h.clock.advance(by: .seconds(60))
    #expect(h.relay.requested.count == 3)
  }

  @Test("two unanswered heartbeats in a row end the link after 35 seconds")
  func unansweredHeartbeatsReconnect() async throws {
    let h = Harness()
    let connection = try h.connection()
    var statuses = StatusReader(connection)
    _ = await statuses.next()
    await connection.start()
    let incoming = await h.relay.next()
    let side = try await h.host.accept(incoming.host, stopwatch: h.stopwatch)
    try await side.answerHello(protocolVersion: AtriumProtocol.protocolVersion)
    #expect(await statuses.next() == .syncing)
    // Read ciphertext without the host channel's automatic heartbeat replies. Each scheduled write
    // must actually reach the wire before advancing time; enqueue alone is not a send receipt.
    #expect(try await incoming.host.receive().count == 17)
    for _ in 0..<3 {
      await step(h.clock, seconds: 10)
      #expect(try await incoming.host.receive().count == 17)
    }
    await step(h.clock, seconds: 4)
    #expect(await connection.status == .syncing)
    await step(h.clock, seconds: 1)
    #expect(await statuses.next() == .reconnecting)
    #expect(incoming.host.isClosed)
  }

  @Test("answered heartbeats keep the link, one every 10 seconds")
  func answeredHeartbeatsKeepTheLink() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    let side = try await h.open(connection)
    let heartbeats = Counter()
    let serving = Task { await side.serve(heartbeats: heartbeats) }
    try await eventually { heartbeats.count == 1 }
    try await eventually { await connection.heartbeatsAnswered == 1 }
    for second in 1...60 {
      await h.clock.waitForSleepers(1)
      h.clock.advance(by: .seconds(1))
      if second % 10 == 0 {
        try await eventually { heartbeats.count == second / 10 + 1 }
        try await eventually { await connection.heartbeatsAnswered == second / 10 + 1 }
      }
    }
    #expect(await connection.status == .syncing)
    #expect(h.relay.requested.count == 1)
    await connection.stop()
    serving.cancel()
  }

  @Test("a long message still arriving keeps the link though no heartbeat is answered")
  func arrivingChunksKeepTheLink() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    let side = try await h.open(connection)
    let channel = try #require(side.channel)
    var open = false
    for second in 0..<60 {
      if second % 5 == 0 {
        open = second % 30 != 25
        try await channel.send(.chunk(Data("part".utf8), isLast: !open))
        let now = Elapsed(offset: .seconds(second))
        try await eventually { await connection.channelHeard == now }
      }
      // Both loops asleep: the heartbeat's, and while a message is open the chunk deadline's.
      let sleepers = open ? 2 : 1
      try await eventually { h.clock.sleeperCount == sleepers }
      h.clock.advance(by: .seconds(1))
    }
    #expect(await connection.status == .syncing)
    #expect(h.relay.requested.count == 1)
    await connection.stop()
  }

  @Test("a handshake the host never answers times out after 15 seconds")
  func handshakeTimeout() async throws {
    let h = Harness()
    let connection = try h.connection()
    var statuses = StatusReader(connection)
    _ = await statuses.next()
    await connection.start()
    let incoming = await h.relay.next()
    await step(h.clock, seconds: 15)
    #expect(await statuses.next() == .reconnecting)
    #expect(incoming.host.isClosed)
  }

  @Test("foreground recovery survives the intermediate inactive phase")
  func foregroundThroughInactive() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    try await h.open(connection)
    await connection.markSynced(generation: connection.generation)
    await connection.setAppPhase(.background)
    await connection.closeForBackground()
    await connection.setAppPhase(.inactive)
    await connection.setAppPhase(.active)
    try await eventually { h.relay.requested.count == 2 }
    #expect(await connection.status == .syncing)
    try await h.open(connection)
    await connection.stop()
  }

  @Test("a short network outage cannot leave a healthy socket stuck at noNetwork")
  func networkReturnsWhileSocketIsOpen() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    try await h.open(connection)
    await connection.markSynced(generation: connection.generation)
    await connection.networkChanged(available: false)
    #expect(await connection.status == .noNetwork)
    await connection.networkChanged(available: true)
    try await eventually { h.relay.requested.count == 2 }
    try await h.open(connection)
    await connection.markSynced(generation: connection.generation)
    #expect(await connection.status.canSend)
    await connection.stop()
  }

  @Test("inactive and back leaves the link alone")
  func inactiveIsIgnored() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    let side = try await h.open(connection)
    let generation = await connection.generation
    await connection.markSynced(generation: generation)
    await connection.setAppPhase(.inactive)
    await connection.setAppPhase(.active)
    #expect(await connection.status == .connected)
    #expect(await connection.generation == generation)
    #expect(h.relay.requested.count == 1)
    _ = side
  }

  @Test("back from the background with a fresh link: syncing at once, one probe, the same link")
  func foregroundProbeAnswered() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    let side = try await h.open(connection)
    let heartbeats = Counter()
    let serving = Task { await side.serve(heartbeats: heartbeats) }
    try await eventually { await connection.heartbeatsAnswered == 1 }
    let generation = await connection.generation
    await connection.markSynced(generation: generation)
    await connection.setAppPhase(.background)
    await connection.setAppPhase(.active)
    // In the same call: no clock moved (SPEC-0005: within 0.5 s).
    #expect(await connection.status == .syncing)
    try await eventually { heartbeats.count == 2 }
    try await eventually { await connection.heartbeatsAnswered == 2 }
    await h.clock.waitForSleepers(2)
    h.clock.advance(by: .seconds(2))
    try await eventually { h.clock.sleeperCount == 1 }
    #expect(await connection.generation == generation)
    #expect(h.relay.requested.count == 1)
    await connection.stop()
    serving.cancel()
  }

  @Test("back from the background, a probe without answer for 2 seconds opens a new link")
  func foregroundProbeUnanswered() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    try await h.open(connection)
    await connection.setAppPhase(.background)
    await connection.setAppPhase(.active)
    #expect(await connection.status == .syncing)
    await h.clock.waitForSleepers(2)
    h.clock.advance(by: .seconds(2))
    _ = try await h.acceptConnect()
    #expect(h.relay.requested.count == 2)
  }

  @Test("back from the background after 20 quiet seconds opens a new link at once")
  func foregroundAfterQuiet() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    try await h.open(connection)
    await step(h.clock, seconds: 20)
    await connection.setAppPhase(.background)
    await connection.setAppPhase(.active)
    #expect(await connection.status == .syncing)
    _ = try await h.acceptConnect()
    #expect(h.relay.requested.count == 2)
  }

  @Test("closed for the background, back in front reconnects at once and resets the backoff")
  func closedForBackground() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    let side = try await h.open(connection)
    await connection.setAppPhase(.background)
    await connection.closeForBackground()
    try await eventually { (try? await side.next()) == nil }
    h.clock.advance(by: .seconds(600))
    #expect(h.relay.requested.count == 1)
    await connection.setAppPhase(.active)
    #expect(await connection.status == .syncing)
    _ = try await h.acceptConnect()
    #expect(h.relay.requested.count == 2)
  }

  @Test("no retries while in the background; the retry happens on return")
  func noRetriesInTheBackground() async throws {
    let h = Harness()
    let connection = try h.connection()
    await connection.start()
    let side = try await h.open(connection)
    await connection.setAppPhase(.background)
    await side.close()
    try await eventually { await connection.status == .reconnecting }
    try await eventually { h.clock.sleeperCount == 0 }
    h.clock.advance(by: .seconds(60))
    #expect(h.relay.requested.count == 1)
    await connection.setAppPhase(.active)
    _ = try await h.acceptConnect()
    #expect(h.relay.requested.count == 2)
  }

  @Test("the pairing channel is handed over and goes on to hello without a new connection")
  func handover() async throws {
    let h = Harness()
    let (phone, hostEnd) = MemoryTransport.pair()
    let link = try PairingLink(h.host.linkText)
    async let opened = RemoteHandshake.pair(
      link: link, deviceKey: try h.store.deviceKey(), info: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
      transport: phone, stopwatch: h.stopwatch)
    let side = try await h.host.accept(hostEnd, stopwatch: h.stopwatch)
    let pairing = try await opened
    #expect(try await side.nextControl() == .pairConfirm)
    try h.store.confirm(HostRecord(pending: link), deviceId: h.host.deviceId)
    let connection = RemoteConnection(
      host: h.host.record, deviceKey: try h.store.deviceKey(), store: h.store, environment: h.environment,
      handover: pairing.channel)
    ConnectionTestResources.current?.register(connection, clock: h.clock)
    await connection.start()
    let hello = try await side.answerHello(protocolVersion: AtriumProtocol.protocolVersion)
    #expect(hello["clientId"] as? String == h.host.deviceId)
    try await eventually { await connection.status == .syncing }
    #expect(h.relay.requested.isEmpty)
  }

  /// Deliberate body failure used to exercise mandatory resource teardown.
  ///
  /// - Remark: A cleanup failure must not masquerade as this expected error.
  private enum PlannedFailure: Error, Equatable { case expected }

  @Test("a throwing test body still releases its connection and manual-clock sleepers")
  func teardownAfterThrow() async throws {
    let h = Harness()
    await #expect(throws: PlannedFailure.expected) {
      try await ConnectionTestResources().run {
        let connection = try h.connection()
        await connection.start()
        _ = try await h.open(connection)
        throw PlannedFailure.expected
      }
    }
    #expect(h.clock.sleeperCount == 0)
  }

  @Test("the offline reason is read only when it is offline:<positive seconds>")
  func lastSeenParsing() {
    #expect(RemoteConnection.lastSeen("offline:1700000000") == Date(timeIntervalSince1970: 1_700_000_000))
    #expect(RemoteConnection.lastSeen("offline:0") == nil)
    #expect(RemoteConnection.lastSeen("offline:x") == nil)
    #expect(RemoteConnection.lastSeen("1700000000") == nil)
    #expect(RemoteConnection.status(for: .handshakeTimeout) == .reconnecting)
    #expect(ConnectionStatus.revoked.isTerminal && ConnectionStatus.pairingIncomplete.isTerminal)
    #expect(!ConnectionStatus.hostOffline(lastSeen: nil).isTerminal && !ConnectionStatus.syncing.canSend)
  }
}
