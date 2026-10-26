import AtriumRemote
import AtriumTestSupport
import SwiftUI
import Testing

@testable import AtriumUI

@Suite("Pairing storage presentation")
struct PairingStoragePresentationTests {
  @Test("home receives storage-only updates while revocation status stays unchanged")
  func observesStorageIndependently() async throws {
    let host = TestHost()
    let secrets = MemorySecretStore()
    let store = HostStore(secrets)
    try store.confirm(host.record, deviceId: host.deviceId)
    let relay = MemoryRelay()
    let clock = Stopwatch(ManualClock())
    let environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1")
    let connection = try await PairingHome<EmptyView>.makeConnection(
      host: host.record, store: store, environment: environment)
    var shown: RemoteStorageIssue?
    let observer = Task { await PairingHome<EmptyView>.observeStorageIssues(of: connection) { shown = $0 } }
    defer { observer.cancel() }
    var statuses = connection.statuses.makeAsyncIterator()
    _ = await statuses.next()
    secrets.failWrites(with: .keychain(-1))
    await connection.start()
    let incoming = await relay.next()
    let side = try await host.accept(
      incoming.host, stopwatch: clock, answer: .reply(HandshakeReply(ok: false, reason: "device_unknown")))
    defer { side.channel?.abort() }
    #expect(await statuses.next() == .revoked)
    try await waitUntil { shown?.error == .keychain(-1) }
    #expect(shown?.operation == .removeHost)
    secrets.failWrites(with: .keychain(-2))
    await connection.retryStorage()
    try await waitUntil { shown?.error == .keychain(-2) }
    #expect(await connection.status == .revoked)
    secrets.failWrites(with: nil)
    await connection.retryStorage()
    try await waitUntil { shown == nil }
    #expect(await connection.status == .revoked)
    #expect(try store.hosts().isEmpty)
    #expect(relay.requested.count == 1)
    await connection.stop()
    observer.cancel()
    await observer.value
  }

  @Test("storage wording distinguishes save and cleanup without accepting raw error text")
  func safeStorageMessages() {
    #expect(PairingStorageNotice.message(for: .confirmPairing) == "没能保存配对记录，请解锁手机后重试。")
    #expect(PairingStorageNotice.message(for: .removeHost) == "没能清理配对记录，请解锁手机后重试。")
    #expect(PairingStorageNotice.message(for: .removePending) == "没能清理配对记录，请解锁手机后重试。")
  }

  /// Waits for the independently scheduled main-actor subscriber with a finite yield budget.
  ///
  /// - Remark: No wall clock or network is involved.
  /// - SideEffects: Yields the main actor.
  /// - Parameter condition: The expected presentation update.
  /// - Throws: When the update does not arrive.
  private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<100_000 {
      if condition() { return }
      await Task.yield()
    }
    Issue.record("storage presentation did not update")
    throw CancellationError()
  }
}
