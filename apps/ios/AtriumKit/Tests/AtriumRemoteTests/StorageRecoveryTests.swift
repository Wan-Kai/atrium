import AtriumRemote
import AtriumTestSupport
import Testing

/// Stops an actor even when a required assertion throws.
///
/// - Remark: New storage failure tests must not leave receive loops or clock sleepers behind.
/// - SideEffects: Runs the body and always stops the connection.
/// - Parameters:
///   - connection: The owned actor.
///   - body: The test.
/// - Throws: The body's error after cleanup.
func withStoppedConnection(_ connection: RemoteConnection, body: () async throws -> Void) async throws {
  do { try await body() } catch {
    await connection.stop()
    throw error
  }
  await connection.stop()
}

/// Serializes the optional storage-state iterator for assertions.
///
/// - Remark: Nil state is an element, not stream termination.
struct StorageIssueReader {
  private var iterator: AsyncStream<RemoteStorageIssue?>.Iterator

  /// Opens the connection's storage-state subscription.
  ///
  /// - Remark: One consumer per stream.
  /// - SideEffects: none
  /// - Parameter connection: Source actor.
  init(_ connection: RemoteConnection) { iterator = connection.storageIssues.makeAsyncIterator() }

  /// Reads the next state including a nil resolution.
  ///
  /// - Remark: Preserves actor isolation across iterator suspension.
  /// - SideEffects: Consumes a state.
  /// - Returns: Next element or termination.
  mutating func next() async -> RemoteStorageIssue?? { await iterator.next(isolation: #isolation) }
}

/// Authenticated terminal facts and local storage outcomes must remain independently observable.
///
/// - Remark: Uses actual handshakes and selective secret-store failures, not mocked connections.
@Suite("Storage recovery")
struct StorageRecoveryTests {
  @Test(
    "partial revocation cleanup retries only failed entries without restarting networking",
    arguments: ["host.", "pending."])
  func partialCleanup(prefix: String) async throws {
    let h = Harness()
    let pending = HostRecord(pending: try PairingLink(h.host.linkText))
    let confirmed = try h.store.confirm(pending, deviceId: h.host.deviceId)
    try h.store.savePending(pending)
    let key = try h.store.deviceKey()
    let connection = RemoteConnection(host: confirmed, deviceKey: key, store: h.store, environment: h.environment)
    try await withStoppedConnection(connection) {
      var states = StorageIssueReader(connection)
      #expect(await states.next() == .some(nil))
      await connection.start()
      let side = try await h.open(connection)
      let failed = prefix + confirmed.hostId
      let other = (prefix == "host." ? "pending." : "host.") + confirmed.hostId
      let prior = h.secrets.deletionAttempts
      h.secrets.failDelete(failed, with: .keychain(-99))
      try await side.send(.revoked)
      try await eventually { await connection.status == .revoked }
      try await eventually { h.clock.sleeperCount == 0 }
      #expect(h.secrets.items[other] == nil)
      #expect(h.secrets.items[failed] != nil)
      let issue = try #require(await connection.storageIssue)
      #expect(issue.error == .keychain(-99))
      #expect(await states.next() == .some(issue))
      #expect(await connection.status.isTerminal)
      #expect(try h.store.deviceKey().rawRepresentation == key.rawRepresentation)
      let failedCount = h.secrets.deletionAttempts[failed, default: 0]
      #expect(failedCount == prior[failed, default: 0] + 1)
      let otherCount = h.secrets.deletionAttempts[other, default: 0]

      await connection.retryStorage()
      #expect(h.secrets.deletionAttempts[failed] == failedCount + 1)
      await connection.setAppPhase(.background)
      await connection.setAppPhase(.inactive)
      await connection.setAppPhase(.active)
      #expect(h.secrets.deletionAttempts[failed] == failedCount + 2)
      await connection.setAppPhase(.active)
      #expect(h.secrets.deletionAttempts[failed] == failedCount + 2)
      #expect(h.secrets.deletionAttempts[other] == otherCount)
      #expect(h.relay.queued == 0)
      #expect(h.clock.sleeperCount == 0)

      h.secrets.failDelete(failed, with: nil)
      await connection.retryStorage()
      #expect(await connection.storageIssue == nil)
      #expect(await states.next() == .some(nil))
      #expect(await connection.status == .revoked)
      #expect(try h.store.hosts().isEmpty)
      #expect(try h.store.pendingHosts().isEmpty)
      #expect(h.secrets.deletionAttempts[other] == otherCount)
      #expect(h.relay.queued == 0)
    }
    try await eventually { h.clock.sleeperCount == 0 }
  }

  @Test("unknown pending-device cleanup failure remains observable and can be retried")
  func pendingCleanup() async throws {
    let h = Harness()
    let pending = HostRecord(pending: try PairingLink(h.host.linkText))
    let connection = try h.connection(record: pending)
    try await withStoppedConnection(connection) {
      h.secrets.failDelete("pending.\(pending.hostId)", with: .keychain(-99))
      await connection.start()
      let incoming = await h.relay.next()
      _ = try await h.host.accept(
        incoming.host, stopwatch: h.stopwatch, answer: .reply(HandshakeReply(ok: false, reason: "device_unknown")))
      try await eventually { await connection.status == .pairingIncomplete }
      #expect(try h.store.pendingHosts() == [pending])
      let issue = try #require(await connection.storageIssue)
      #expect(issue.operation == .removePending)
      h.secrets.failDelete("pending.\(pending.hostId)", with: nil)
      await connection.retryStorage()
      #expect(await connection.storageIssue == nil)
      #expect(await connection.status == .pairingIncomplete)
      #expect(try h.store.pendingHosts().isEmpty)
      #expect(h.relay.queued == 0)
    }
  }

  @Test("pending confirmation failure stays visible while syncing and retries without reconnecting")
  func confirmationFailure() async throws {
    let h = Harness()
    let pending = HostRecord(pending: try PairingLink(h.host.linkText))
    let connection = try h.connection(record: pending)
    try await withStoppedConnection(connection) {
      await connection.start()
      h.secrets.failWrites(with: .keychain(-99), includingDeletes: false)
      _ = try await h.open(connection)
      #expect(await connection.status == .syncing)
      let issue = try #require(await connection.storageIssue)
      #expect(issue.operation == .confirmPairing)
      #expect(try h.store.pendingHosts() == [pending])
      #expect(try h.store.hosts().isEmpty)
      h.secrets.failWrites(with: nil)
      await connection.retryStorage()
      #expect(await connection.storageIssue == nil)
      #expect(await connection.status == .syncing)
      #expect(try h.store.hosts() == [h.host.record])
      #expect(try h.store.pendingHosts().isEmpty)
      #expect(h.relay.queued == 0)
    }
    try await eventually { h.clock.sleeperCount == 0 }
  }

  @Test("old revocation retries cannot erase a new same-content pairing", arguments: [false, true])
  func supersededCleanup(newConfirmation: Bool) async throws {
    let h = Harness()
    let connection = try h.connection()
    try await withStoppedConnection(connection) {
      await connection.start()
      let side = try await h.open(connection)
      h.secrets.failWrites(with: .keychain(-99))
      try await side.send(.revoked)
      try await eventually { await connection.status == .revoked }
      _ = try #require(await connection.storageIssue)
      h.secrets.failWrites(with: nil)
      let pending = HostRecord(pending: try PairingLink(h.host.linkText))
      try h.store.savePending(pending)
      if newConfirmation {
        try h.store.confirm(pending, deviceId: h.host.deviceId)
        try h.store.savePending(pending)
      }
      let versions = h.store.claim(pending.hostId)
      await connection.retryStorage()
      #expect(await connection.storageIssue == nil)
      #expect(await connection.status == .revoked)
      #expect(try h.store.hosts() == [h.host.record])
      #expect(try h.store.pendingHosts() == [pending])
      #expect(h.store.claim(pending.hostId) == versions)
    }
  }

  @Test("old confirmation retry cannot overwrite a newer pairing")
  func supersededConfirmation() async throws {
    let h = Harness()
    let pending = HostRecord(pending: try PairingLink(h.host.linkText))
    let connection = try h.connection(record: pending)
    try await withStoppedConnection(connection) {
      h.secrets.failWrites(with: .keychain(-99), includingDeletes: false)
      await connection.start()
      _ = try await h.open(connection)
      _ = try #require(await connection.storageIssue)
      h.secrets.failWrites(with: nil)
      try h.store.savePending(pending)
      let newest = try h.store.confirm(pending, deviceId: "new-device", hostName: "New Commit")
      await connection.retryStorage()
      #expect(await connection.storageIssue == nil)
      #expect(try h.store.hosts() == [newest])
      #expect(try h.store.pendingHosts().isEmpty)
    }
  }
}
