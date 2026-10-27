import AtriumProtocol
import AtriumRemote
import AtriumSync
import AtriumTestSupport
import Foundation
import Testing

@testable import AtriumUI

/// The MP4a sync contract: the shipping Swift sync against the real host, a scripted pi and the real relay.
///
/// - Remark: Opt-in through `node apps/ios/Integration/run.mjs --sync-contract` (SPEC-0005 "验证 · App ·
///   契约测试"); ordinary `swift test` skips it. Everything the phone sees goes over loopback
///   WebSockets through the relay and Noise; the fixture's control endpoint only does what the Mac's
///   user would. No keychain, deployed relay or model is used.
/// - SideEffects: Opens loopback connections; changes an in-memory store.
struct SyncContractTests {
  /// Pairs, syncs the list and an open session within the budget, then follows a reply as it comes.
  ///
  /// - Remark: "已连接" must come only after the list and the open session's snapshot.
  /// - SideEffects: Opens and closes loopback connections.
  @Test(.enabled(if: ProcessInfo.processInfo.environment["ATRIUM_LOCAL_INTEROP_SCENARIO"] == "sync"))
  func listOpenSessionAndLiveReply() async throws {
    let control = try ContractControl()
    let setup = try await control.request("setup")
    let link = try PairingLink(try #require(setup["link"] as? String))
    try #require(link.relay.scheme == "ws" && link.relay.host() == "127.0.0.1")
    let store = HostStore(MemorySecretStore())
    let pending = HostRecord(pending: link)
    try store.savePending(pending)
    let key = try store.deviceKey()
    // Real time: the fixture's host and relay run on the system clock.
    let stopwatch = Stopwatch(ContinuousClock())
    let endpoint = try #require(clientEndpoint(relay: link.relay, hostId: link.hostId))
    let transport = WebSocketTransport(url: endpoint)
    defer { transport.close() }
    let pairing = try await RemoteHandshake.pair(
      link: link, deviceKey: key,
      info: DeviceInfo(deviceName: "Swift sync contract", model: "macOS test", appVersion: "0.1.0"),
      transport: transport, stopwatch: stopwatch)
    defer { pairing.channel.abort() }
    _ = try await control.request("confirm", body: ["sas": pairing.code])
    let paired = try await RemoteHandshake.awaitPaired(pairing.channel)
    let record = try store.confirm(pending, deviceId: paired.deviceId, hostName: paired.hostName)
    let chat = try await control.request("chat")
    let sessionId = try #require(chat["sessionId"] as? String)
    #expect(chat["historyTurns"] as? Int == 8)

    let connection = RemoteConnection(
      host: record, deviceKey: key, store: store, environment: .live(appVersion: "0.1.0"), handover: pairing.channel)
    let model = SyncModel(
      connection: connection, hostName: record.hostName, traceparent: makeTraceparent, now: { stopwatch.now.offset },
      requestId: { UUID().uuidString.lowercased() })
    model.open(sessionId)
    let running = Task { await model.run() }
    let following = Task { for await status in connection.statuses { await model.statusChanged(status) } }
    /// Stops the model's tasks and the connection, after a failure as after success.
    ///
    /// - Remark: A failing expectation must not leave tasks holding the connection.
    /// - SideEffects: Cancels tasks; stops the connection.
    func cleanUp() async {
      following.cancel()
      running.cancel()
      await running.value
      await following.value
      await connection.stop()
    }
    await connection.start()
    do {
      try await within(seconds: 30) { model.status == .connected }

      #expect(model.home.chats.map(\.id).contains(sessionId))
      let opened = try #require(model.core.sessions[sessionId])
      #expect(opened.status == .ready)
      #expect(opened.items.filter(isTurn).count == SyncCore.snapshotBudget.turns)
      #expect(opened.hasOlder)
      #expect(opened.stream != nil)

      _ = try await control.request("prompt", body: ["sessionId": sessionId, "text": "ping"])
      try await within(seconds: 30) {
        guard let state = model.core.sessions[sessionId], case .turn(let last)? = state.items.last else { return false }
        return !state.running && last.outcome == .done
          && last.steps.contains { $0 == .text(.init(id: "0", text: "pong")) }
      }
      let replied = try #require(model.core.sessions[sessionId])
      #expect(replied.items.filter(isTurn).count == SyncCore.snapshotBudget.turns + 1)
      #expect(replied.seq > opened.seq)
      #expect(model.status == .connected)

      // The phone's own message (MP4b): sent with its receipt, settled once its turn shows.
      #expect(model.canSend(sessionId))
      model.setDraft("ping", for: sessionId)
      model.send(sessionId)
      let sent = try #require(model.core.outbox.first)
      #expect(sent.state == .sending)
      #expect(!model.canSend(sessionId))
      // The fixture's pi always reports the same entries, so the host's rebuild after the run puts a
      // new epoch over the live turns; the core remembers the turn it saw stream in.
      try await within(seconds: 30) {
        model.core.lastDelivered[sessionId] == sent.id && model.core.outbox.isEmpty
          && model.core.sessions[sessionId]?.running == false
      }
      #expect(model.core.drafts[sessionId] == nil)
      #expect(model.canSend(sessionId))

    } catch {
      await cleanUp()
      throw error
    }
    await cleanUp()
  }

  /// Whether an item is a turn.
  ///
  /// - Remark: Turns are what the budget counts.
  /// - SideEffects: none
  /// - Parameter item: The item.
  /// - Returns: Whether it is a turn.
  private func isTurn(_ item: TranscriptItem) -> Bool {
    if case .turn = item { return true }
    return false
  }

  /// Waits until a condition on the main actor holds, or fails after a real-time bound.
  ///
  /// - Remark: The fixture runs on real time, so this waits on it, polling every 20 ms.
  /// - SideEffects: Sleeps.
  /// - Parameters:
  ///   - seconds: The bound.
  ///   - condition: What to wait for.
  /// - Throws: When it never holds.
  private func within(seconds: Int, _ condition: () -> Bool) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(seconds))
    while clock.now < deadline {
      if condition() { return }
      // Real time: the fixture's host answers on its own clock.
      try await Task.sleep(for: .milliseconds(20))
    }
    Issue.record("condition never held within \(seconds) s")
    throw CancellationError()
  }
}

/// Calls the loopback-only contract fixture's host controls.
///
/// - Remark: The bearer credential and origin come from the owning runner, never user config.
/// - SideEffects: none
struct ContractControl: Sendable {
  /// The fixture's control origin.
  let origin: URL
  /// Its bearer credential.
  let token: String

  /// Reads the runner's configuration, refusing anything but loopback.
  ///
  /// - Remark: Guards against someone setting the opt-in variables by hand.
  /// - SideEffects: Reads the process environment.
  /// - Throws: When the configuration is missing or not loopback.
  init() throws {
    let environment = ProcessInfo.processInfo.environment
    let text = try #require(environment["ATRIUM_LOCAL_INTEROP_CONTROL"])
    origin = try #require(URL(string: text))
    try #require(origin.scheme == "http" && origin.host() == "127.0.0.1" && origin.port != nil)
    token = try #require(environment["ATRIUM_LOCAL_INTEROP_TOKEN"])
  }

  /// Performs one bounded control call and requires an object back.
  ///
  /// - Remark: Only Mac-side actions; every protocol assertion uses the real connection.
  /// - SideEffects: Sends an authenticated loopback HTTP request.
  /// - Parameters:
  ///   - action: The fixture action.
  ///   - body: JSON arguments.
  /// - Returns: The decoded object.
  /// - Throws: Network, encoding or requirement failures.
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
