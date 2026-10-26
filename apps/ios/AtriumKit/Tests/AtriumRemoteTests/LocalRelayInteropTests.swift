import AtriumNoise
import AtriumRemote
import AtriumTestSupport
import Foundation
import Testing

/// Exercises the shipping Swift transport against the real relay and unchanged TS MP0 host.
///
/// - Remark: Opt-in via Integration/run.mjs; no deployed server or user keychain is accessed.
/// - SideEffects: Opens loopback WebSockets and HTTP control requests.
struct LocalRelayInteropTests {
  /// Pairs, reconnects with IK, exchanges a heartbeat, then observes revocation and refusal.
  ///
  /// - Remark: MP0 speaks protocol 25; every version override is confined to this test.
  /// - SideEffects: Opens and closes loopback connections and changes isolated in-memory stores.
  @Test(
    .enabled(
      if: ProcessInfo.processInfo.environment["ATRIUM_LOCAL_INTEROP_CONTROL"] != nil
        && ProcessInfo.processInfo.environment["ATRIUM_LOCAL_INTEROP_SCENARIO"] != "production-rejection"))
  func pairingReconnectHeartbeatAndRevocation() async throws {
    let control = try LocalInteropControl()
    let setup = try await control.request("setup")
    let link = try PairingLink(try #require(setup["link"] as? String))
    try #require(link.relay.scheme == "ws" && link.relay.host() == "127.0.0.1")
    try #require(link.relay.path() == "/atrium")
    let endpoint = try #require(clientEndpoint(relay: link.relay, hostId: link.hostId))
    #expect(endpoint.path() == "/atrium/v1/client")
    let secrets = MemorySecretStore()
    let store = HostStore(secrets)
    let pending = HostRecord(pending: link)
    try store.savePending(pending)
    let key = try store.deviceKey()
    let stopwatch = Stopwatch(ContinuousClock())
    let transport = WebSocketTransport(url: endpoint)
    defer { transport.close() }
    let pairing = try await RemoteHandshake.pair(
      link: link, deviceKey: key,
      info: DeviceInfo(deviceName: "Local Swift interop", model: "macOS test", appVersion: "0.1.0"),
      transport: transport, stopwatch: stopwatch, protocolVersion: 25)
    defer { pairing.channel.abort() }
    let confirmation = try await control.request("confirm", body: ["sas": pairing.code])
    try #require(confirmation["sas"] as? String == pairing.code)
    #expect(pairing.code.count == 6 && pairing.code.allSatisfy(\.isNumber))
    let paired = try await RemoteHandshake.awaitPaired(pairing.channel)
    let record = try store.confirm(pending, deviceId: paired.deviceId, hostName: paired.hostName)
    #expect(paired.hostName == "Local MP0 host")
    #expect(try store.pendingHosts().isEmpty)
    #expect(try store.hosts() == [record])
    let welcome = try await RemoteHandshake.hello(
      channel: pairing.channel, deviceId: paired.deviceId, traceparent: makeTraceparent(), protocolVersion: 25)
    #expect(welcome.protocolVersion == 25)
    #expect(welcome.hostVersion == "0.0.0-mp0-spike")
    await pairing.channel.close()

    // Reload the identity through the production store, then open a different TCP/Noise channel.
    let reopenedStore = HostStore(secrets)
    let saved = try #require(reopenedStore.hosts().first)
    let savedKey = try reopenedStore.deviceKey()
    #expect(savedKey.rawRepresentation == key.rawRepresentation)
    let dailyTransport = WebSocketTransport(url: endpoint)
    defer { dailyTransport.close() }
    let daily = try await RemoteHandshake.connect(
      hostId: saved.hostId, hostKey: saved.hostKey, deviceKey: savedKey, appVersion: "0.1.0",
      transport: dailyTransport, stopwatch: stopwatch, protocolVersion: 25)
    defer { daily.channel.abort() }
    #expect(daily.deviceId == paired.deviceId)
    let dailyWelcome = try await RemoteHandshake.hello(
      channel: daily.channel, deviceId: daily.deviceId, traceparent: makeTraceparent(), protocolVersion: 25)
    #expect(dailyWelcome.hostInstanceId == welcome.hostInstanceId)
    #expect(dailyWelcome.heartbeatMs == 10_000)
    try await daily.channel.sendHeartbeat()
    #expect(try await daily.channel.nextEvent() == .heartbeatAck)
    let status = try await control.request("status")
    #expect(status["helloCount"] as? Int == 2)
    #expect(status["deviceCount"] as? Int == 1)

    _ = try await control.request("revoke", body: ["deviceId": daily.deviceId])
    let revoked = try await daily.channel.nextEvent()
    guard case .control(let body) = revoked else {
      Issue.record("Expected authenticated revoked control frame")
      return
    }
    #expect(try JSONDecoder().decode(ControlMessage.self, from: body) == .revoked)
    do {
      _ = try await daily.channel.nextEvent()
      Issue.record("Revocation did not close the open channel")
    } catch {
      guard case RemoteError.transport(.closed) = error else { throw error }
    }
    let rejectedTransport = WebSocketTransport(url: endpoint)
    defer { rejectedTransport.close() }
    do {
      let unexpected = try await RemoteHandshake.connect(
        hostId: saved.hostId, hostKey: saved.hostKey, deviceKey: savedKey, appVersion: "0.1.0",
        transport: rejectedTransport, stopwatch: stopwatch, protocolVersion: 25)
      unexpected.channel.abort()
      Issue.record("Revoked static key was accepted on a new IK channel")
    } catch {
      #expect(error == .rejected(reason: "device_unknown", hostProtocol: nil))
    }
    let finalStatus = try await control.request("status")
    #expect(finalStatus["deviceCount"] as? Int == 0)
  }
}

/// Calls the loopback-only fixture's explicit host controls.
///
/// - Remark: The bearer credential and origin are generated by the owning runner, never user config.
/// - SideEffects: none
struct LocalInteropControl: Sendable {
  let origin: URL
  let token: String

  /// Validates runner configuration before permitting any request.
  ///
  /// - Remark: Rejects non-loopback origins even if someone sets the opt-in variable manually.
  /// - SideEffects: Reads process environment.
  init() throws {
    let environment = ProcessInfo.processInfo.environment
    let text = try #require(environment["ATRIUM_LOCAL_INTEROP_CONTROL"])
    origin = try #require(URL(string: text))
    try #require(origin.scheme == "http" && origin.host() == "127.0.0.1" && origin.port != nil)
    token = try #require(environment["ATRIUM_LOCAL_INTEROP_TOKEN"])
  }

  /// Performs a bounded fixture control call and requires an object response.
  ///
  /// - Remark: This out-of-band test API confirms or revokes; all protocol assertions use WebSockets.
  /// - SideEffects: Sends an authenticated loopback HTTP request; invalidates the ephemeral session.
  /// - Parameters:
  ///   - action: Fixture action.
  ///   - body: JSON arguments, empty for reads.
  /// - Returns: The decoded object.
  /// - Throws: Network, encoding or failed test-requirement errors.
  func request(_ action: String, body: [String: String] = [:]) async throws -> [String: Any] {
    var request = URLRequest(url: origin.appendingPathComponent(action))
    request.httpMethod = "POST"
    request.timeoutInterval = 10
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(body)
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let (data, response) = try await session.data(for: request)
    try #require((response as? HTTPURLResponse)?.statusCode == 200)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
}
