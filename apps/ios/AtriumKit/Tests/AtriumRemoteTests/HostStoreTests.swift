import AtriumRemote
import AtriumTestSupport
import Foundation
import Testing

/// Storage contracts above Security.framework, exercised with real encoded records.
///
/// - Remark: Platform keychain access is a separate simulator check.
@Suite("Host records")
struct HostStoreTests {
  @Test("the device key survives new store instances and forgetting one Mac")
  func persistentIdentity() throws {
    let secrets = MemorySecretStore()
    let store = HostStore(secrets)
    let first = try store.deviceKey().rawRepresentation
    #expect(first.count == 32)
    #expect(try HostStore(secrets).deviceKey().rawRepresentation == first)
    let host = TestHost()
    try store.savePending(HostRecord(pending: PairingLink(host.linkText)))
    try store.confirm(host.record, deviceId: host.deviceId)
    try store.removeHost(host.hostId)
    #expect(try store.hosts().isEmpty)
    #expect(try store.pendingHosts().isEmpty)
    #expect(secrets.items == ["device-key": first])
  }

  @Test("a replacement pairing does not overwrite the known Mac until confirmation")
  func replacement() throws {
    let secrets = MemorySecretStore()
    let store = HostStore(secrets)
    let host = TestHost()
    try store.confirm(host.record, deviceId: host.deviceId)
    var pending = HostRecord(pending: try PairingLink(host.linkText))
    pending.relay = try #require(URL(string: "wss://new-relay.test"))
    try store.savePending(pending)
    #expect(try store.hosts() == [host.record])
    #expect(try store.pendingHosts() == [pending])
    let confirmed = try store.confirm(pending, deviceId: "new-device", hostName: "New Mac")
    #expect(confirmed.relay == pending.relay)
    #expect(confirmed.deviceId == "new-device")
    #expect(confirmed.hostName == "New Mac")
    #expect(try store.hosts() == [confirmed])
    #expect(try store.pendingHosts().isEmpty)
  }

  @Test("failed confirmation preserves the pending record and the previous confirmed host")
  func failedWrite() throws {
    let secrets = MemorySecretStore()
    let store = HostStore(secrets)
    let host = TestHost()
    try store.confirm(host.record, deviceId: host.deviceId)
    let pending = HostRecord(pending: try PairingLink(host.linkText))
    try store.savePending(pending)
    let before = secrets.items
    secrets.failWrites(with: .corrupt)
    #expect(throws: StoreError.corrupt) { try store.confirm(pending, deviceId: "replacement") }
    #expect(secrets.items == before)
    #expect(throws: StoreError.corrupt) { try store.removeHost(host.hostId) }
    #expect(secrets.items == before)
  }

  @Test("corrupt identity never silently rotates; corrupt host records do not hide good ones")
  func corruptRecords() throws {
    let secrets = MemorySecretStore()
    let store = HostStore(secrets)
    let host = TestHost()
    try secrets.write("device-key", Data([1]))
    #expect(throws: StoreError.corrupt) { try store.deviceKey() }
    #expect(secrets.items["device-key"] == Data([1]))
    try secrets.write("host.corrupt", Data([2]))
    try store.confirm(host.record, deviceId: host.deviceId, hostName: "")
    #expect(try store.hosts() == [host.record])
    #expect(secrets.items["host.corrupt"] == Data([2]))
  }

  @Test("forgetting one host preserves other hosts and their pending pairings")
  func scopedRemoval() throws {
    let secrets = MemorySecretStore()
    let store = HostStore(secrets)
    let host = TestHost()
    var other = host.record
    other.hostId = "hst_ffffffffffffffff"
    try store.confirm(host.record, deviceId: host.deviceId)
    try store.confirm(other, deviceId: host.deviceId)
    try store.savePending(other)
    try store.removeHost(host.hostId)
    #expect(try store.hosts() == [other])
    #expect(try store.pendingHosts() == [other])
  }
}
