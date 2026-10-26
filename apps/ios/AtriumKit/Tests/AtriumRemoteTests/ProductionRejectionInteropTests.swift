import AtriumProtocol
import AtriumRemote
import AtriumTestSupport
import Foundation
import Testing

/// Checks the actual TS service's authenticated refusal through a production loopback relay.
///
/// - Remark: Opt-in service boundary, not startHost/faux-pi or a production keychain contract.
/// - SideEffects: Opens loopback HTTP/WebSocket connections and changes isolated in-memory records.
struct ProductionRejectionInteropTests {
  /// Receives a real Mac refusal while retaining the old local host and deleting only pending.
  ///
  /// - Remark: The old record is a local fixture seed, not evidence of a previous server pairing.
  /// - SideEffects: Runs and drains a production PairingFlow; the TS fixture makes the host decision.
  @Test(
    .enabled(if: ProcessInfo.processInfo.environment["ATRIUM_LOCAL_INTEROP_SCENARIO"] == "production-rejection"))
  func macRefusal() async throws {
    let control = try LocalInteropControl()
    let setup = try await control.request("setup")
    #expect(setup["protocolVersion"] as? Int == protocolVersion)
    let link = try PairingLink(try #require(setup["link"] as? String))
    try #require(link.relay.scheme == "ws" && link.relay.host() == "127.0.0.1" && link.relay.port != nil)
    #expect(link.relay.path() == "/atrium")
    let store = HostStore(MemorySecretStore())
    let previous = try store.confirm(HostRecord(pending: link), deviceId: "dev_0000000000000001")
    let key = try store.deviceKey()
    let flow = PairingFlow(
      environment: .live(appVersion: "0.1.0"), store: store,
      device: DeviceInfo(deviceName: "Local Swift rejection", model: "macOS test", appVersion: "0.1.0"))
    let codes = AsyncStream<String>.makeStream()
    defer { codes.continuation.finish() }
    try await withThrowingTaskGroup(of: PairingOutcome.self) { group in
      group.addTask {
        defer { codes.continuation.finish() }
        return await flow.run(link) { state in
          if case .confirming(let code, _) = state { codes.continuation.yield(code) }
        }
      }
      defer { group.cancelAll() }
      var iterator = codes.stream.makeAsyncIterator()
      let code = try #require(await iterator.next())
      #expect(code.count == 6 && code.allSatisfy(\.isNumber))
      #expect(try store.pendingHosts() == [HostRecord(pending: link)])
      let refusal = try await control.request("reject", body: ["sas": code])
      #expect(refusal["reason"] as? String == "declined")
      #expect(refusal["acceptCount"] as? Int == 0)
      #expect(refusal["deviceCount"] as? Int == 0)
      let outcome = try #require(await group.next())
      defer { outcome.channel?.abort() }
      #expect(outcome.state == .failed(.declined))
      #expect(outcome.channel == nil)
      #expect(outcome.storageIssue == nil)
      #expect(try store.pendingHosts().isEmpty)
      #expect(try store.hosts() == [previous])
      let keyUnchanged = try store.deviceKey().rawRepresentation == key.rawRepresentation
      #expect(keyUnchanged)
    }
    let status = try await control.request("status")
    #expect(status["reason"] as? String == "declined")
    #expect(status["acceptCount"] as? Int == 0)
    #expect(status["deviceCount"] as? Int == 0)
  }
}
