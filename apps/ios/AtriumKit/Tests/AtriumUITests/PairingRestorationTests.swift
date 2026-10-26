import AtriumRemote
import AtriumTestSupport
import Foundation
import SwiftUI
import Testing

@testable import AtriumUI

@Suite("Pairing home restoration")
struct PairingRestorationTests {
  @Test("same-host pending replacement connects to the new relay and promotes after IK")
  func replacementRelay() async throws {
    let host = TestHost()
    let store = HostStore(MemorySecretStore())
    try store.confirm(host.record, deviceId: host.deviceId)
    var pending = host.record
    pending.deviceId = nil
    pending.relay = try #require(URL(string: "wss://replacement.test/new-path"))
    try store.savePending(pending)
    let selected = try #require(
      await PairingHome<EmptyView>.loadRestorationHost(from: store))
    #expect(selected.record == pending)
    let relay = MemoryRelay()
    let clock = Stopwatch(ManualClock())
    let environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1")
    let connection = try await PairingHome<EmptyView>.makeConnection(
      host: selected.record, store: store, environment: environment, ownership: selected.ownership)
    var statuses = connection.statuses.makeAsyncIterator()
    _ = await statuses.next()
    await connection.start()
    let incoming = await relay.next()
    #expect(relay.requested.map(\.absoluteString) == ["wss://replacement.test/new-path/v1/client?host=\(host.hostId)"])
    let side = try await host.accept(incoming.host, stopwatch: clock)
    #expect(side.mode == .ik)
    try await side.answerHello(protocolVersion: environment.protocolVersion)
    #expect(await statuses.next() == .syncing)
    var expected = pending
    expected.deviceId = host.deviceId
    #expect(try store.hosts() == [expected])
    #expect(try store.pendingHosts().isEmpty)
    await connection.stop()
  }

  @Test("home restoration and connection assembly never access secrets on the main thread")
  func keychainOffMainThread() async throws {
    let memory = MemorySecretStore()
    let host = TestHost()
    try HostStore(memory).confirm(host.record, deviceId: host.deviceId)
    let secrets = MainThreadCheckingStore(backing: memory)
    let store = HostStore(secrets)
    let selected = try #require(await PairingHome<EmptyView>.loadRestorationHost(from: store))
    let relay = MemoryRelay()
    let environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: Stopwatch(ManualClock()), jitter: { 0 }, appVersion: "1")
    let connection = try await PairingHome<EmptyView>.makeConnection(
      host: selected.record, store: store, environment: environment, ownership: selected.ownership)
    #expect(secrets.mainThreadAccesses.count == 0)
    #expect(relay.requested.isEmpty)
    await connection.stop()
  }

  @Test("replacement during asynchronous connection assembly cannot acquire a fresh claim for stale records")
  func staleRestorationDoesNotConnect() async throws {
    let host = TestHost()
    let store = HostStore(MemorySecretStore())
    try store.confirm(host.record, deviceId: host.deviceId)
    let selected = try #require(await PairingHome<EmptyView>.loadRestorationHost(from: store))
    try store.savePending(HostRecord(pending: PairingLink(host.linkText)))
    let relay = MemoryRelay()
    relay.failNext(with: .unreachable)
    let environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: Stopwatch(ManualClock()), jitter: { 0 }, appVersion: "1")
    let connection = try await PairingHome<EmptyView>.makeConnection(
      host: selected.record, store: store, environment: environment, ownership: selected.ownership)
    var statuses = connection.statuses.makeAsyncIterator()
    _ = await statuses.next()
    await connection.start()
    #expect(await statuses.next() == .superseded)
    #expect(relay.requested.isEmpty)
    await connection.stop()
  }

  @Test("another Mac's pending pairing never steals the selected confirmed host")
  func unrelatedPending() {
    let confirmed = TestHost().record
    var unrelated = confirmed
    unrelated.hostId = "hst_0000000000000000"
    unrelated.deviceId = nil
    #expect(PairingHome<EmptyView>.restorationHost(hosts: [confirmed], pendingHosts: [unrelated]) == confirmed)
    #expect(PairingHome<EmptyView>.restorationHost(hosts: [], pendingHosts: [unrelated]) == unrelated)
    #expect(PairingHome<EmptyView>.restorationHost(hosts: [], pendingHosts: []) == nil)
  }
}
