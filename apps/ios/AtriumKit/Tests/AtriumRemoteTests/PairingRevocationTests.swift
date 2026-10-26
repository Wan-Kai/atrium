import AtriumRemote
import AtriumTestSupport
import Foundation
import Testing

/// Revocation during pairing has the same authenticated, version-limited cleanup as daily links.
///
/// - Remark: The old host record is removable only when authenticated by the scanned host key.
@Suite("Pairing revocation")
struct PairingRevocationTests {
  @Test(
    "authenticated revoked clears matching host and pending, exposing partial failures",
    arguments: ["", "host.", "pending."])
  func revoke(prefix: String) async throws {
    let h = Harness()
    let link = try PairingLink(h.host.linkText)
    try h.store.confirm(HostRecord(pending: link), deviceId: h.host.deviceId)
    let deviceKey = try h.store.deviceKey().rawRepresentation
    let flow = PairingFlow(
      environment: h.environment, store: h.store, device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"))
    let task = Task { await flow.run(link) { _ in } }
    defer { task.cancel() }
    let incoming = await h.relay.next()
    let side = try await h.host.accept(incoming.host, stopwatch: h.stopwatch)
    #expect(try await side.nextControl() == .pairConfirm)
    let account = prefix + link.hostId
    if !prefix.isEmpty { h.secrets.failDelete(account, with: .keychain(-99)) }
    try await side.send(.revoked)
    let result = await task.value
    #expect(result.state == .failed(.revoked))
    #expect(result.channel == nil)
    #expect(incoming.host.isClosed)
    if prefix.isEmpty {
      #expect(result.storageIssue == nil)
    } else {
      #expect(result.storageIssue?.error == .keychain(-99))
      #expect(h.secrets.items[account] != nil)
      h.secrets.failDelete(account, with: nil)
      let recovery = try #require(result.storageRecovery)
      guard case .removed = await recovery.retry() else {
        Issue.record("cleanup did not finish")
        return
      }
    }
    #expect(try h.store.hosts().isEmpty)
    #expect(try h.store.pendingHosts().isEmpty)
    #expect(try h.store.deviceKey().rawRepresentation == deviceKey)
    await side.close()
    try await eventually { h.clock.sleeperCount == 0 }
  }

  @Test("a differently authenticated old host is not revoked by a newly scanned key")
  func keyScope() async throws {
    let h = Harness()
    let link = try PairingLink(h.host.linkText)
    var old = HostRecord(pending: link)
    old.hostKey = Data(repeating: 9, count: 32)
    let previous = try h.store.confirm(old, deviceId: "old-device")
    let flow = PairingFlow(
      environment: h.environment, store: h.store, device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"))
    let task = Task { await flow.run(link) { _ in } }
    defer { task.cancel() }
    let incoming = await h.relay.next()
    let side = try await h.host.accept(incoming.host, stopwatch: h.stopwatch)
    #expect(try await side.nextControl() == .pairConfirm)
    try await side.send(.revoked)
    #expect(await task.value.state == .failed(.revoked))
    #expect(try h.store.hosts() == [previous])
    #expect(try h.store.pendingHosts().isEmpty)
    await side.close()
  }
}
