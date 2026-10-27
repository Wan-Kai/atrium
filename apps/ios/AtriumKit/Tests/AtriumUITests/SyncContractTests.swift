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
      } else: {
        let state = model.core.sessions[sessionId]
        return "outbox \(model.core.outbox) last \(String(describing: model.core.lastDelivered[sessionId])) "
          + "problems \(model.core.problems) running \(String(describing: state?.running)) status \(model.status) "
          + "turns \(state?.items.count ?? -1) seq \(state?.seq ?? -1) epoch \(state?.epoch ?? -1)"
      }
      #expect(model.core.drafts[sessionId] == nil)
      #expect(model.canSend(sessionId))

      // MP4c: the connection goes; a message sent on the Mac meanwhile arrives by resuming, not a snapshot.
      let before = try #require(model.core.sessions[sessionId])
      let turnsBefore = before.items.filter(isTurn).count
      _ = try await control.request("cut")
      _ = try await control.request("prompt", body: ["sessionId": sessionId, "text": "ping"])
      try await within(seconds: 30) {
        guard model.status == .connected, let state = model.core.sessions[sessionId] else { return false }
        return state.settled && !state.running && state.items.filter(isTurn).count == turnsBefore + 1
      } else: {
        let state = model.core.sessions[sessionId]
        return
          "status \(model.status) settled \(String(describing: state?.settled)) running \(String(describing: state?.running)) "
          + "turns \(state?.items.filter(isTurn).count ?? -1) before \(turnsBefore) seq \(state?.seq ?? -1) epoch \(state?.epoch ?? -1)"
      }
      let resumed = try #require(model.core.sessions[sessionId])
      #expect(resumed.stream == before.stream)
      #expect(resumed.epoch == before.epoch)
      #expect(resumed.seq > before.seq)

      // A message lost on its way up is sent again once with its own id after the reconnect, and runs once.
      _ = try await control.request("hold")
      model.setDraft("ping", for: sessionId)
      model.send(sessionId)
      let lost = try #require(model.core.outbox.first)
      _ = try await control.request("cut")
      _ = try await control.request("release")
      try await within(seconds: 30) {
        model.core.lastDelivered[sessionId] == lost.id && model.core.outbox.isEmpty
          && model.core.sessions[sessionId]?.running == false
      }
      let after = try #require(model.core.sessions[sessionId])
      #expect(after.items.filter(isTurn).count == turnsBefore + 2)
      #expect(
        after.items.filter {
          if case .turn(let turn) = $0 { return turn.user.clientMessageId == lost.id }
          return false
        }.count == 1)

      // A message the host ran whose answer is lost on the way down is not run again after the reconnect.
      _ = try await control.request("deafen")
      model.setDraft("ping", for: sessionId)
      model.send(sessionId)
      let unanswered = try #require(model.core.outbox.first)
      _ = try await control.request("executed", body: ["clientMessageId": unanswered.id])
      _ = try await control.request("cut")
      _ = try await control.request("hear")
      try await within(seconds: 30) {
        model.core.lastDelivered[sessionId] == unanswered.id && model.core.outbox.isEmpty
          && model.core.sessions[sessionId]?.running == false
      } else: {
        let state = model.core.sessions[sessionId]
        return "outbox \(model.core.outbox) last \(String(describing: model.core.lastDelivered[sessionId])) "
          + "running \(String(describing: state?.running)) status \(model.status) settled \(String(describing: state?.settled))"
      }
      let last = try #require(model.core.sessions[sessionId])
      #expect(last.items.filter(isTurn).count == turnsBefore + 3)
      #expect(
        last.items.filter {
          if case .turn(let turn) = $0 { return turn.user.clientMessageId == unanswered.id }
          return false
        }.count == 1)

      // MP5b: while a run goes on, a message waits in the host's queue and a steer goes to pi; a stop
      // holds the queue until "继续发送" lets it go.
      _ = try await control.request("prompt", body: ["sessionId": sessionId, "text": "ping"])
      try await within(seconds: 30) { model.core.sessions[sessionId]?.running == true && model.canSend(sessionId) }
      model.setDraft("排队的", for: sessionId)
      model.send(sessionId)
      try await within(seconds: 30) {
        model.core.outbox.isEmpty && model.core.sessions[sessionId]?.control?.queue.map(\.text) == ["排队的"]
      }
      model.setDraft("插话的", for: sessionId)
      model.send(sessionId, steer: true)
      try await within(seconds: 30) { model.core.outbox.isEmpty }
      model.perform(.stop, in: sessionId)
      try await within(seconds: 30) {
        let state = model.core.sessions[sessionId]
        return state?.running == false && state?.control?.paused == .stopped && state?.control?.queue.count == 1
      } else: {
        let state = model.core.sessions[sessionId]
        return "running \(String(describing: state?.running)) control \(String(describing: state?.control))"
      }
      let held = try #require(model.core.sessions[sessionId]).items.filter(isTurn).count
      model.perform(.resumeQueue, in: sessionId)
      try await within(seconds: 30) {
        let state = model.core.sessions[sessionId]
        return state?.control?.queue.isEmpty == true && state?.running == false
          && (state?.items.filter(isTurn).count ?? 0) == held + 1
      } else: {
        let state = model.core.sessions[sessionId]
        return
          "running \(String(describing: state?.running)) turns \(state?.items.filter(isTurn).count ?? -1) held \(held) "
          + "control \(String(describing: state?.control))"
      }
      #expect(model.core.actionProblems.isEmpty)

      // MP5c: a dialog the Mac answers first goes from the phone ("已在 Mac 上处理"); one the phone
      // answers is taken by the host.
      for (run, macAnswers) in [(8, true), (9, false)] {
        _ = try await control.request("prompt", body: ["sessionId": sessionId, "text": "ping"])
        try await within(seconds: 30) {
          model.core.sessions[sessionId]?.control?.interactions.map(\.id) == ["c\(run)"]
        } else: {
          "control \(String(describing: model.core.sessions[sessionId]?.control))"
        }
        if macAnswers {
          _ = try await control.request("answer", body: ["sessionId": sessionId, "interactionId": "c\(run)"])
        } else {
          model.perform(.answerInteraction("c\(run)", .confirmed(.init(confirmed: true))), in: sessionId)
        }
        try await within(seconds: 30) { model.core.sessions[sessionId]?.control?.interactions.isEmpty == true }
        #expect(model.core.actionProblems.isEmpty)
        model.perform(.stop, in: sessionId)
        try await within(seconds: 30) { model.core.sessions[sessionId]?.running == false }
      }

      // MP5c: a message with an image uploads it first, then goes with its id.
      let jpeg = try #require(ImageShrinker.jpeg(from: try noisyPNG(width: 64, height: 48)))
      let turnsBeforeImage = try #require(model.core.sessions[sessionId]).items.filter(isTurn).count
      model.setDraft("看图", for: sessionId)
      model.setDraftImages([OutgoingImage(mimeType: .imageJpeg, data: jpeg.base64EncodedString())], for: sessionId)
      model.send(sessionId)
      try await within(seconds: 30) {
        let items = model.core.sessions[sessionId]?.items ?? []
        return model.core.outbox.isEmpty && items.filter(isTurn).count == turnsBeforeImage + 1
      } else: {
        "outbox \(model.core.outbox) problems \(model.core.problems)"
      }
      // The host took the prompt with the attachment's id: an id it did not have would be refused
      // (`attachment_missing`) and come back as a problem. The scripted pi does not echo images, so
      // the turn itself does not count them.
      #expect(model.core.problems.isEmpty)
      #expect(model.core.draftImages.isEmpty)

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
  ///   - line: Where the wait is, for the report.
  ///   - condition: What to wait for.
  ///   - describe: What to report when it never holds.
  /// - Throws: When it never holds.
  private func within(
    seconds: Int, line: Int = #line, _ condition: () -> Bool, else describe: () -> String = { "" }
  ) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(seconds))
    while clock.now < deadline {
      if condition() { return }
      // Real time: the fixture's host answers on its own clock.
      try await Task.sleep(for: .milliseconds(20))
    }
    Issue.record("condition at line \(line) never held within \(seconds) s: \(describe())")
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
