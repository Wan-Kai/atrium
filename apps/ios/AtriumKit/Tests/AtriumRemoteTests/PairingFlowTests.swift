import AtriumNoise
import AtriumProtocol
import AtriumTestSupport
import Foundation
import Testing

@testable import AtriumRemote

/// Exercises the complete pairing exchange, not an invented handshake stub.
///
/// - Remark: The responder uses the same memory transport and real Noise as daily-connection tests.
@Suite("Pairing flow")
struct PairingFlowTests {
  @Test("shows matching SAS, persists pending first, then promotes and hands over the channel")
  func confirms() async throws {
    let h = Harness()
    let link = try PairingLink(h.host.linkText)
    let (states, report) = AsyncStream<AtriumRemote.PairingState>.makeStream()
    var iterator = states.makeAsyncIterator()
    let flow = PairingFlow(
      environment: h.environment, store: h.store,
      device: DeviceInfo(deviceName: "Phone", model: "iPhone17,1", appVersion: "1"))
    let task = Task { await flow.run(link) { report.yield($0) } }
    defer {
      task.cancel()
      report.finish()
    }
    #expect(await iterator.next() == .connecting)
    let incoming = await h.relay.next()
    #expect(try h.store.pendingHosts() == [HostRecord(pending: link)])
    let side = try await h.host.accept(incoming.host, stopwatch: h.stopwatch)
    #expect(side.mode == .ikpsk2)
    #expect(
      try RemoteJSON.decode(PairRequest.self, from: side.request)
        == PairRequest(
          pairingId: link.pairingId, deviceName: "Phone", model: "iPhone17,1", appVersion: "1",
          protocolVersion: AtriumProtocol.protocolVersion))
    #expect(try await side.nextControl() == .pairConfirm)
    #expect(await iterator.next() == .confirming(code: side.code, secondsLeft: 120))
    #expect(side.code.count == 6)
    try await side.send(.paired(deviceId: h.host.deviceId, hostName: h.host.hostName))
    let outcome = await task.value
    #expect(outcome.state == .paired(h.host.record))
    #expect(await iterator.next() == .paired(h.host.record))
    #expect(try h.store.hosts() == [h.host.record])
    #expect(try h.store.pendingHosts().isEmpty)
    #expect(outcome.channel != nil)
    await outcome.channel?.close()
    try await eventually { h.clock.sleeperCount == 0 }
  }

  @Test(
    "authenticated refusal drops pending but keeps an existing host",
    arguments: [
      ("declined", PairingFailure.declined), ("pairing_busy", .busy),
      ("pairing_expired", .expired), ("host_error", .hostError), ("timeout", .timedOut),
      ("cancelled", .cancelled), ("rejected", .other("rejected")),
    ])
  func refuses(reason: String, failure: PairingFailure) async throws {
    let h = Harness()
    try h.store.confirm(h.host.record, deviceId: h.host.deviceId)
    let flow = PairingFlow(
      environment: h.environment, store: h.store,
      device: DeviceInfo(deviceName: "Phone", model: "M", appVersion: "1"))
    let link = try PairingLink(h.host.linkText)
    let task = Task { await flow.run(link) { _ in } }
    defer { task.cancel() }
    let incoming = await h.relay.next()
    let side = try await h.host.accept(incoming.host, stopwatch: h.stopwatch)
    #expect(try await side.nextControl() == .pairConfirm)
    try await side.send(.pairRejected(reason: reason))
    let outcome = await task.value
    #expect(outcome.state == .failed(failure))
    #expect(outcome.channel == nil)
    #expect(try h.store.pendingHosts().isEmpty)
    #expect(try h.store.hosts() == [h.host.record])
    #expect(incoming.host.isClosed)
    try await eventually { h.clock.sleeperCount == 0 }
  }

  @Test("losing the answer retains pending for recovery by a daily IK connection")
  func interrupted() async throws {
    let h = Harness()
    let link = try PairingLink(h.host.linkText)
    let flow = PairingFlow(
      environment: h.environment, store: h.store,
      device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"))
    let task = Task { await flow.run(link) { _ in } }
    defer { task.cancel() }
    let incoming = await h.relay.next()
    let side = try await h.host.accept(incoming.host, stopwatch: h.stopwatch)
    #expect(try await side.nextControl() == .pairConfirm)
    await side.close()
    #expect(await task.value.state == .failed(.interrupted))
    #expect(try h.store.pendingHosts() == [HostRecord(pending: link)])
    #expect(try h.store.hosts().isEmpty)
  }

  @Test("keychain failure before connecting does not open a socket")
  func unavailableStore() async throws {
    let h = Harness()
    h.secrets.failWrites(with: .corrupt)
    let flow = PairingFlow(
      environment: h.environment, store: h.store,
      device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"))
    let result = await flow.run(try PairingLink(h.host.linkText)) { _ in }
    #expect(result.state == .failed(.keychainUnavailable))
    #expect(h.relay.requested.isEmpty)
    #expect(h.secrets.items.isEmpty)
  }

  @Test("confirmation write failure preserves pending for the next connection")
  func confirmationWriteFailure() async throws {
    let h = Harness()
    let link = try PairingLink(h.host.linkText)
    let flow = PairingFlow(
      environment: h.environment, store: h.store,
      device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"))
    let task = Task { await flow.run(link) { _ in } }
    defer { task.cancel() }
    let incoming = await h.relay.next()
    let side = try await h.host.accept(incoming.host, stopwatch: h.stopwatch)
    #expect(try await side.nextControl() == .pairConfirm)
    h.secrets.failWrites(with: .corrupt, includingDeletes: false)
    try await side.send(.paired(deviceId: h.host.deviceId, hostName: h.host.hostName))
    #expect(await task.value.state == .failed(.keychainUnavailable))
    #expect(try h.store.pendingHosts() == [HostRecord(pending: link)])
    #expect(try h.store.hosts().isEmpty)
    #expect(incoming.host.isClosed)
  }

  @Test("a missing paired answer times out without erasing the recoverable pending record")
  func missingAnswer() async throws {
    let h = Harness()
    let link = try PairingLink(h.host.linkText)
    let flow = PairingFlow(
      environment: h.environment, store: h.store,
      device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"))
    let task = Task { await flow.run(link) { _ in } }
    defer { task.cancel() }
    let incoming = await h.relay.next()
    let side = try await h.host.accept(incoming.host, stopwatch: h.stopwatch)
    #expect(try await side.nextControl() == .pairConfirm)
    try await eventually { h.clock.remaining == [.seconds(1)] }
    h.clock.advance(by: .seconds(125))
    #expect(await task.value.state == .failed(.timedOut))
    #expect(try h.store.pendingHosts() == [HostRecord(pending: link)])
    #expect(incoming.host.isClosed)
    try await eventually { h.clock.sleeperCount == 0 }
  }

  @Test("a suspended countdown uses elapsed time rather than counting timer wakeups")
  func elapsedCountdown() async throws {
    let h = Harness()
    let (states, report) = AsyncStream<AtriumRemote.PairingState>.makeStream()
    var iterator = states.makeAsyncIterator()
    let link = try PairingLink(h.host.linkText)
    let flow = PairingFlow(
      environment: h.environment, store: h.store,
      device: DeviceInfo(deviceName: "P", model: "M", appVersion: "1"))
    let task = Task { await flow.run(link) { report.yield($0) } }
    defer {
      task.cancel()
      report.finish()
    }
    _ = await iterator.next()
    let incoming = await h.relay.next()
    let side = try await h.host.accept(incoming.host, stopwatch: h.stopwatch)
    #expect(try await side.nextControl() == .pairConfirm)
    #expect(await iterator.next() == .confirming(code: side.code, secondsLeft: 120))
    try await eventually { h.clock.remaining == [.seconds(1)] }
    h.clock.advance(by: .seconds(60))
    #expect(await iterator.next() == .confirming(code: side.code, secondsLeft: 60))
    task.cancel()
    _ = await task.value
    #expect(incoming.host.isClosed)
    try await eventually { h.clock.sleeperCount == 0 }
  }
}
