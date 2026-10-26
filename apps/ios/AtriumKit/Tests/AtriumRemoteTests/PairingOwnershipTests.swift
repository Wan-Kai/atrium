import AtriumRemote
import AtriumTestSupport
import Testing

/// Holds one old flow after its authenticated handshake, before its final result is consumed.
///
/// - Remark: Makes the old/new pairing interleaving deterministic, without sleeping.
actor PairingGate {
  private var continuation: CheckedContinuation<Void, Never>?
  private(set) var arrived = false

  /// Pauses the flow at its confirmation report.
  ///
  /// - Remark: Released by the test after the new flow has saved its pending record.
  /// - SideEffects: Stores one continuation.
  func wait() async {
    arrived = true
    await withCheckedContinuation { continuation = $0 }
  }

  /// Releases the paused flow.
  ///
  /// - Remark: Idempotent after the waiter has arrived.
  /// - SideEffects: Resumes the old flow.
  func release() {
    continuation?.resume()
    continuation = nil
  }
}

/// Pending ownership must distinguish two attempts even when their record bytes are identical.
///
/// - Remark: Tests both late rejection and late success, not just cancellation.
@Suite("Pairing record ownership")
struct PairingOwnershipTests {
  @Test("an old result cannot delete or confirm a newer same-content pending record", arguments: [false, true])
  func staleResult(succeeds: Bool) async throws {
    let h = Harness()
    let gate = PairingGate()
    let link = try PairingLink(h.host.linkText)
    let flow = PairingFlow(
      environment: h.environment, store: h.store,
      device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"))
    let old = Task {
      await flow.run(link) { state in
        if case .confirming = state { await gate.wait() }
      }
    }
    defer { old.cancel() }
    let first = await h.relay.next()
    let oldSide = try await h.host.accept(first.host, stopwatch: h.stopwatch)
    #expect(try await oldSide.nextControl() == .pairConfirm)
    try await eventually { await gate.arrived }

    let new = Task { await flow.run(link) { _ in } }
    defer { new.cancel() }
    let second = await h.relay.next()
    let newSide = try await h.host.accept(second.host, stopwatch: h.stopwatch)
    #expect(try await newSide.nextControl() == .pairConfirm)
    let pending = HostRecord(pending: link)
    #expect(try h.store.pendingHosts() == [pending])
    if succeeds {
      try await oldSide.send(.paired(deviceId: h.host.deviceId, hostName: "Old Commit"))
    } else {
      try await oldSide.send(.pairRejected(reason: "declined"))
    }
    await gate.release()
    let oldResult = await old.value
    if case .paired = oldResult.state { Issue.record("stale pairing published success") }
    oldResult.channel?.abort()
    #expect(try h.store.pendingHosts() == [pending])
    #expect(try h.store.hosts().isEmpty)

    try await newSide.send(.paired(deviceId: h.host.deviceId, hostName: "New Commit"))
    let newResult = await new.value
    var expected = h.host.record
    expected.hostName = "New Commit"
    #expect(newResult.state == .paired(expected))
    #expect(try h.store.hosts() == [expected])
    #expect(try h.store.pendingHosts().isEmpty)
    newResult.channel?.abort()
    await oldSide.close()
    await newSide.close()
    try await eventually { h.clock.sleeperCount == 0 }
  }
}
