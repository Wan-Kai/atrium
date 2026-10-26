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
