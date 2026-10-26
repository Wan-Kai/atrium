import AtriumRemote
import AtriumTestSupport
import Foundation
import Testing

@testable import AtriumUI

/// Tests the UI projection against the real pairing flow and Noise responder.
///
/// - Remark: No camera or platform keychain is needed for protocol-state projection.
@Suite("Pairing screen projection")
struct PairingModelTests {
  @Test("invalid pasted links never connect and unknown errors never expose raw text")
  func invalidInput() {
    let relay = MemoryRelay()
    let model = PairingModel(
      environment: RemoteEnvironment(
        connect: { relay.connect($0) }, stopwatch: Stopwatch(ManualClock()), jitter: { 0 }, appVersion: "1"),
      store: HostStore(MemorySecretStore()), device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
      onPaired: { _ in Issue.record("invalid link paired") })
    model.submit("not a pairing link")
    #expect(model.invalidLink)
    #expect(model.state == nil)
    #expect(relay.requested.isEmpty)
    #expect(!PairingView.message(for: .other("secret-marker")).contains("secret-marker"))
    model.cancel()
    #expect(!model.invalidLink)
  }

  @Test("a completed pairing transfers its channel exactly once")
  func handsOverOnce() async throws {
    let relay = MemoryRelay()
    let clock = Stopwatch(ManualClock())
    let host = TestHost()
    let secrets = MemorySecretStore()
    var delivered: [PairingOutcome] = []
    let model = PairingModel(
      environment: RemoteEnvironment(connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1"),
      store: HostStore(secrets), device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
      onPaired: { delivered.append($0) })
    model.submit(host.linkText)
    model.submit(host.linkText)
    let incoming = await relay.next()
    let side = try await host.accept(incoming.host, stopwatch: clock)
    #expect(try await side.nextControl() == .pairConfirm)
    try await waitUntil { model.state == .confirming(code: side.code, secondsLeft: 120) }
    #expect(relay.requested.count == 1)
    try await side.send(.paired(deviceId: host.deviceId, hostName: host.hostName))
    try await waitUntil { model.state == .paired(host.record) }
    // Dismissing the success screen must not abort a successful pairing before the home adopts it.
    model.cancel()
    #expect(!incoming.host.isClosed)
    #expect(delivered.count == 1)
    let outcome = try #require(delivered.first)
    model.cancel()
    #expect(delivered.count == 1)
    #expect(!incoming.host.isClosed)
    outcome.channel?.abort()
    #expect(incoming.host.isClosed)
  }

  @Test("pairing launched from the main-actor screen keeps secret IO off the main thread")
  func pairingStorageOffMainThread() async throws {
    let relay = MemoryRelay()
    let clock = Stopwatch(ManualClock())
    let host = TestHost()
    let secrets = MainThreadCheckingStore(backing: MemorySecretStore())
    let model = PairingModel(
      environment: RemoteEnvironment(connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1"),
      store: HostStore(secrets), device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
      onPaired: { $0.channel?.abort() })
    defer { model.cancel() }
    model.submit(host.linkText)
    let incoming = await relay.next()
    let side = try await host.accept(incoming.host, stopwatch: clock)
    defer { side.channel?.abort() }
    #expect(try await side.nextControl() == .pairConfirm)
    try await side.send(.paired(deviceId: host.deviceId, hostName: host.hostName))
    try await waitUntil { !model.isRunning }
    #expect(model.state == .paired(host.record))
    #expect(secrets.mainThreadAccesses.count == 0)
  }

  @Test("cancelled callbacks cannot resurrect a dismissed screen")
  func cancelledAttempt() async throws {
    let relay = MemoryRelay()
    let host = TestHost()
    let model = PairingModel(
      environment: RemoteEnvironment(
        connect: { relay.connect($0) }, stopwatch: Stopwatch(ManualClock()), jitter: { 0 }, appVersion: "1"),
      store: HostStore(MemorySecretStore()), device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
      onPaired: { _ in Issue.record("cancelled attempt paired") })
    model.submit(host.linkText)
    let incoming = await relay.next()
    model.cancel()
    try await waitUntil { incoming.host.isClosed }
    #expect(model.state == nil)
  }

  @Test("cancel keeps the running task owned until its cleanup actually returns")
  func cancellationSerializesSubmission() async throws {
    let relay = MemoryRelay()
    let host = TestHost()
    let model = PairingModel(
      environment: RemoteEnvironment(
        connect: { relay.connect($0) }, stopwatch: Stopwatch(ManualClock()), jitter: { 0 }, appVersion: "1"),
      store: HostStore(MemorySecretStore()), device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
      onPaired: { _ in Issue.record("cancelled attempt paired") })
    model.submit(host.linkText)
    let incoming = await relay.next()
    model.cancel()
    #expect(model.isRunning)
    model.submit("not a pairing link")
    #expect(!model.invalidLink)
    try await waitUntil { !model.isRunning }
    #expect(incoming.host.isClosed)
    #expect(model.state == nil)
    #expect(relay.requested.count == 1)
    model.submit("not a pairing link")
    #expect(model.invalidLink)
  }

  @Test("cancelling a confirmation preserves recovery data without starting IK")
  func cancellationNeverReconnects() async throws {
    let relay = MemoryRelay()
    let clock = ManualClock()
    let stopwatch = Stopwatch(clock)
    let host = TestHost()
    let store = HostStore(MemorySecretStore())
    let model = PairingModel(
      environment: RemoteEnvironment(
        connect: { relay.connect($0) }, stopwatch: stopwatch, jitter: { 0 }, appVersion: "1"),
      store: store, device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
      onPaired: { _ in Issue.record("cancelled confirmation transferred a channel") })
    defer { model.cancel() }
    model.submit(host.linkText)
    let incoming = await relay.next()
    let side = try await host.accept(incoming.host, stopwatch: stopwatch)
    defer { side.channel?.abort() }
    #expect(try await side.nextControl() == .pairConfirm)
    try await waitUntil { model.state == .confirming(code: side.code, secondsLeft: 120) }
    model.cancel()
    try await waitUntil { !model.isRunning }
    #expect(model.state == nil)
    #expect(try store.pendingHosts() == [HostRecord(pending: PairingLink(host.linkText))])
    #expect(try store.hosts().isEmpty)
    #expect(incoming.host.isClosed)
    clock.advance(by: .seconds(300))
    #expect(relay.requested.count == 1)
  }

  @Test("failed confirmation storage is visible and explicitly retryable without re-pairing")
  func confirmationStorageRetry() async throws {
    let relay = MemoryRelay()
    let clock = Stopwatch(ManualClock())
    let host = TestHost()
    let secrets = MemorySecretStore()
    let store = HostStore(secrets)
    var delivered: [PairingOutcome] = []
    let model = PairingModel(
      environment: RemoteEnvironment(connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1"),
      store: store, device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
      onPaired: { delivered.append($0) })
    defer { model.cancel() }
    model.submit(host.linkText)
    let incoming = await relay.next()
    let side = try await host.accept(incoming.host, stopwatch: clock)
    defer { side.channel?.abort() }
    #expect(try await side.nextControl() == .pairConfirm)
    secrets.failWrites(with: .keychain(-1))
    try await side.send(.paired(deviceId: host.deviceId, hostName: host.hostName))
    try await waitUntil { !model.isRunning }
    #expect(model.state == .failed(.keychainUnavailable))
    #expect(model.storageIssue?.operation == .confirmPairing)
    #expect(model.storageIssue?.error == .keychain(-1))
    #expect(delivered.isEmpty)
    secrets.failWrites(with: .keychain(-2))
    model.retryStorage()
    try await waitUntil { !model.isRunning }
    #expect(model.storageIssue?.error == .keychain(-2))
    #expect(model.state == .failed(.keychainUnavailable))
    secrets.failWrites(with: nil)
    model.retryStorage()
    model.retryStorage()
    try await waitUntil { !model.isRunning }
    #expect(model.storageIssue == nil)
    #expect(model.state == .paired(host.record))
    #expect(delivered.count == 1)
    #expect(delivered.first?.channel == nil)
    #expect(try store.hosts() == [host.record])
    #expect(try store.pendingHosts().isEmpty)
    #expect(relay.requested.count == 1)
  }

  @Test("revocation cleanup failure stays revoked after an explicit storage retry")
  func revokedStorageRetry() async throws {
    let relay = MemoryRelay()
    let clock = Stopwatch(ManualClock())
    let host = TestHost()
    let secrets = MemorySecretStore()
    let store = HostStore(secrets)
    try store.confirm(host.record, deviceId: host.deviceId)
    let model = PairingModel(
      environment: RemoteEnvironment(connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1"),
      store: store, device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
      onPaired: { _ in Issue.record("revoked pairing transferred a channel") })
    defer { model.cancel() }
    model.submit(host.linkText)
    let incoming = await relay.next()
    let side = try await host.accept(incoming.host, stopwatch: clock)
    defer { side.channel?.abort() }
    #expect(try await side.nextControl() == .pairConfirm)
    secrets.failWrites(with: .keychain(-1))
    try await side.send(.revoked)
    try await waitUntil { !model.isRunning }
    #expect(model.state == .failed(.revoked))
    #expect(model.storageIssue?.operation == .removeHost)
    secrets.failWrites(with: nil)
    model.retryStorage()
    try await waitUntil { !model.isRunning }
    #expect(model.storageIssue == nil)
    #expect(model.state == .failed(.revoked))
    #expect(try store.hosts().isEmpty)
    #expect(try store.pendingHosts().isEmpty)
    #expect(relay.requested.count == 1)
  }

  @Test("a newer record prevents an already returned pairing outcome from being handed over")
  func staleOutcomeIsNotAdopted() async throws {
    let relay = MemoryRelay()
    let clock = Stopwatch(ManualClock())
    let host = TestHost()
    let store = HostStore(MemorySecretStore())
    let environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1")
    let device = DeviceInfo(deviceName: "P", model: "M", appVersion: "1")
    let flow = PairingFlow(environment: environment, store: store, device: device)
    let link = try PairingLink(host.linkText)
    let attempt = Task { await flow.run(link) { _ in } }
    defer { attempt.cancel() }
    let incoming = await relay.next()
    let side = try await host.accept(incoming.host, stopwatch: clock)
    defer { side.channel?.abort() }
    #expect(try await side.nextControl() == .pairConfirm)
    try await side.send(.paired(deviceId: host.deviceId, hostName: host.hostName))
    let outcome = await attempt.value
    defer { outcome.channel?.abort() }
    #expect(outcome.state == .paired(host.record))
    // Reproduces replacement during the hop from the remote flow back to the main-actor consumer.
    try store.savePending(HostRecord(pending: link))
    var delivered = 0
    let model = PairingModel(environment: environment, store: store, device: device, onPaired: { _ in delivered += 1 })
    defer { model.cancel() }
    model.finish(outcome)
    #expect(model.state == .failed(.superseded))
    #expect(delivered == 0)
    #expect(incoming.host.isClosed)
    outcome.channel?.abort()
  }

  @Test("cancelled or superseded storage recovery never hands off a channel", arguments: [true, false])
  func storageRetryDoesNotReviveOldPairing(cancel: Bool) async throws {
    let relay = MemoryRelay()
    let clock = Stopwatch(ManualClock())
    let host = TestHost()
    let secrets = MemorySecretStore()
    let store = HostStore(secrets)
    var delivered = 0
    let model = PairingModel(
      environment: RemoteEnvironment(connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1"),
      store: store, device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
      onPaired: { _ in delivered += 1 })
    defer { model.cancel() }
    model.submit(host.linkText)
    let incoming = await relay.next()
    let side = try await host.accept(incoming.host, stopwatch: clock)
    defer { side.channel?.abort() }
    #expect(try await side.nextControl() == .pairConfirm)
    secrets.failWrites(with: .keychain(-1))
    try await side.send(.paired(deviceId: host.deviceId, hostName: host.hostName))
    try await waitUntil { !model.isRunning }
    #expect(model.storageIssue != nil)
    secrets.failWrites(with: nil)
    let pending = try HostRecord(pending: PairingLink(host.linkText))
    if cancel { model.cancel() } else { try store.savePending(pending) }
    model.retryStorage()
    try await waitUntil { !model.isRunning }
    #expect(model.state == (cancel ? nil : .failed(.superseded)))
    #expect(model.storageIssue == nil)
    #expect(delivered == 0)
    #expect(try store.pendingHosts() == [pending])
    #expect(try store.hosts().isEmpty)
    #expect(relay.requested.count == 1)
  }

  @Test(
    "foreground retries retained storage once without reviving cancelled or replaced pairings",
    arguments: ["retry", "replace", "cancel"])
  func foregroundStorageRetry(mode: String) async throws {
    let relay = MemoryRelay()
    let clock = Stopwatch(ManualClock())
    let host = TestHost()
    let secrets = MemorySecretStore()
    let store = HostStore(secrets)
    var delivered = 0
    let model = PairingModel(
      environment: RemoteEnvironment(connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1"),
      store: store, device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"),
      onPaired: { _ in delivered += 1 })
    defer { model.cancel() }
    model.submit(host.linkText)
    let incoming = await relay.next()
    let side = try await host.accept(incoming.host, stopwatch: clock)
    defer { side.channel?.abort() }
    #expect(try await side.nextControl() == .pairConfirm)
    secrets.failWrites(with: .keychain(-1))
    try await side.send(.paired(deviceId: host.deviceId, hostName: host.hostName))
    try await waitUntil { !model.isRunning }
    #expect(model.storageIssue?.error == .keychain(-1))
    model.setAppPhase(.active)
    model.setAppPhase(.inactive)
    model.setAppPhase(.active)
    #expect(!model.isRunning)
    secrets.failWrites(with: nil)
    let pending = try HostRecord(pending: PairingLink(host.linkText))
    if mode == "cancel" { model.cancel() }
    if mode == "replace" { try store.savePending(pending) }
    secrets.failWrites(with: .keychain(-2))
    model.setAppPhase(.background)
    model.setAppPhase(.inactive)
    #expect(!model.isRunning)
    model.setAppPhase(.active)
    #expect(model.isRunning == (mode != "cancel"))
    model.setAppPhase(.active)
    try await waitUntil { !model.isRunning }
    #expect(delivered == 0)
    #expect(relay.requested.count == 1)
    if mode == "retry" {
      #expect(model.storageIssue?.error == .keychain(-2))
      #expect(model.state == .failed(.keychainUnavailable))
      secrets.failWrites(with: .keychain(-3))
      model.setAppPhase(.active)
      #expect(!model.isRunning)
      #expect(model.storageIssue?.error == .keychain(-2))
      secrets.failWrites(with: nil)
      model.setAppPhase(.background)
      model.setAppPhase(.inactive)
      model.setAppPhase(.active)
      try await waitUntil { !model.isRunning }
      #expect(model.state == .paired(host.record))
      #expect(model.storageIssue == nil)
      #expect(delivered == 1)
      model.setAppPhase(.active)
      #expect(!model.isRunning)
      #expect(delivered == 1)
    } else {
      #expect(model.storageIssue == nil)
      #expect(model.state == (mode == "cancel" ? nil : .failed(.superseded)))
      #expect(try store.pendingHosts() == [pending])
      #expect(try store.hosts().isEmpty)
    }
  }

  /// Waits for a remote task to publish state without advancing virtual time.
  ///
  /// - Remark: A finite yield budget makes missing callbacks a failure, not a hanging test.
  /// - SideEffects: Yields the main actor.
  /// - Parameter condition: The expected state.
  /// - Throws: When the callback never arrives.
  private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<100_000 {
      if condition() { return }
      await Task.yield()
    }
    Issue.record("pairing state did not arrive")
    throw CancellationError()
  }
}
