import AtriumProtocol
import AtriumRemote
import AtriumRender
import AtriumSync
import AtriumTestSupport
import Foundation
import Testing

@testable import AtriumUI

/// The traceparent of the commands in these tests.
nonisolated private let traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

/// An empty list snapshot, as the host sends it.
nonisolated private let emptyList = """
  {"type":"index_snapshot","generation":"h1","seq":0,"reason":"no_cursor","projects":[],"workspaces":[],\
  "chats":[],"sessions":[],"layout":{"container":null,"tabs":{}},"preferences":{"setupDone":true,\
  "appearance":"system","lastModel":null,"thinkingByModel":{},"lastFast":false,"statusBar":{},\
  "titleModel":null,"proxy":null,"inbox":true,"translationLanguage":"简体中文"},"resets":[]}
  """

/// An empty snapshot of session `s1`, as the host sends it.
nonisolated private let sessionSnapshot = """
  {"type":"session_snapshot","sessionId":"s1","epoch":1,"seq":0,"traceId":null,"stream":"st","items":[],\
  "hasOlder":false,"run":null,"exited":false,"control":{"queue":[],"deliveries":[],"deliveriesHeld":null,\
  "paused":null,"steers":[],"stopping":false,"restarting":false,"compacting":false,"interactions":[],\
  "question":null,"failure":null},"model":null,"fast":false,"metrics":{"turns":null,"steps":null,\
  "tokens":null,"cost":null,"reasoning":null,"branchTokens":0,"context":null,"timing":null,"children":null}}
  """

@Suite("Sync model", PairingResourceScope())
struct SyncModelTests {
  @Test("subscribes once the channel is up and turns the connection connected only when the list has come")
  func syncsThenConnected() async throws {
    let host = TestHost()
    let store = HostStore(MemorySecretStore())
    try store.confirm(host.record, deviceId: host.deviceId)
    let relay = MemoryRelay()
    let manualClock = ManualClock()
    let clock = Stopwatch(manualClock)
    let environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1")
    let connection = RemoteConnection(
      host: host.record, deviceKey: try store.deviceKey(), store: store, environment: environment)
    PairingTestResources.current?.register(connection, clock: manualClock)
    let model = SyncModel(
      connection: connection, hostName: host.hostName, traceparent: { traceparent }, now: { .zero },
      requestId: { UUID().uuidString.lowercased() })
    let running = Task { await model.run() }
    let following = Task { for await status in connection.statuses { await model.statusChanged(status) } }

    await connection.start()
    let side = try await host.accept((await relay.next()).host, stopwatch: clock)
    PairingTestResources.current?.register(side.channel)
    _ = try await side.answerHello(protocolVersion: protocolVersion)
    let first = try await firstMessage(of: side)
    let subscribe = try JSONSerialization.jsonObject(with: first) as? [String: Any]
    #expect(subscribe?["type"] as? String == "subscribe_index")
    #expect(subscribe?["cursor"] == nil)
    #expect(subscribe?["traceparent"] as? String == traceparent)
    let requestId = try #require(subscribe?["requestId"] as? String)
    #expect(UUID(uuidString: requestId) != nil)

    try await side.send(Data(emptyList.utf8))
    try await waitUntil { model.core.index.ready }
    #expect(await connection.status == .syncing)
    try await side.send(Data(#"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{}}"#.utf8))
    try await waitUntil { model.status == .connected }
    #expect(await connection.status == .connected)

    following.cancel()
    running.cancel()
    await running.value
    await following.value
    await connection.stop()
  }

  @Test("syncs again once a connection opened after coming back to the foreground is up, not before")
  func foregroundReconnect() async throws {
    let host = TestHost()
    let store = HostStore(MemorySecretStore())
    try store.confirm(host.record, deviceId: host.deviceId)
    let relay = MemoryRelay()
    let manualClock = ManualClock()
    let clock = Stopwatch(manualClock)
    let environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1")
    let connection = RemoteConnection(
      host: host.record, deviceKey: try store.deviceKey(), store: store, environment: environment)
    PairingTestResources.current?.register(connection, clock: manualClock)
    let model = SyncModel(
      connection: connection, hostName: host.hostName, traceparent: { traceparent }, now: { .zero },
      requestId: { UUID().uuidString.lowercased() })
    let running = Task { await model.run() }
    let following = Task { for await status in connection.statuses { await model.statusChanged(status) } }
    await connection.start()
    let first = try await host.accept((await relay.next()).host, stopwatch: clock)
    PairingTestResources.current?.register(first.channel)
    _ = try await first.answerHello(protocolVersion: protocolVersion)
    try await answerList(first)
    try await waitUntil { model.status == .connected }

    await connection.setAppPhase(.background)
    await connection.closeForBackground()
    await connection.setAppPhase(.active)
    try await waitUntil { model.status == .syncing }
    // The new connection's handshake comes only now, after "正在同步" was shown.
    let second = try await host.accept((await relay.next()).host, stopwatch: clock)
    PairingTestResources.current?.register(second.channel)
    _ = try await second.answerHello(protocolVersion: protocolVersion)
    try await answerList(second)
    try await waitUntil { model.status == .connected }

    following.cancel()
    running.cancel()
    await running.value
    await following.value
    await connection.stop()
  }

  @Test("puts a message back in its input when the connection is gone before it is written")
  func notWritten() async throws {
    let host = TestHost()
    let store = HostStore(MemorySecretStore())
    try store.confirm(host.record, deviceId: host.deviceId)
    let relay = MemoryRelay()
    let manualClock = ManualClock()
    let clock = Stopwatch(manualClock)
    let environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1")
    let connection = RemoteConnection(
      host: host.record, deviceKey: try store.deviceKey(), store: store, environment: environment)
    PairingTestResources.current?.register(connection, clock: manualClock)
    let model = SyncModel(
      connection: connection, hostName: host.hostName, traceparent: { traceparent }, now: { .zero },
      requestId: { UUID().uuidString.lowercased() })
    model.open("s1")
    let running = Task { await model.run() }
    let following = Task { for await status in connection.statuses { await model.statusChanged(status) } }
    await connection.start()
    let side = try await host.accept((await relay.next()).host, stopwatch: clock)
    PairingTestResources.current?.register(side.channel)
    _ = try await side.answerHello(protocolVersion: protocolVersion)
    var answered: [String] = []
    for _ in 0..<3 {
      let message = try JSONSerialization.jsonObject(with: try await firstMessage(of: side)) as? [String: Any]
      answered.append(try #require(message?["requestId"] as? String))
    }
    try await side.send(Data(emptyList.utf8))
    for requestId in answered {
      try await side.send(Data(#"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{}}"#.utf8))
    }
    try await side.send(Data(sessionSnapshot.utf8))
    try await waitUntil { model.status == .connected && model.canSend("s1") }

    // The connection goes before the message is written; the model still shows it connected.
    following.cancel()
    await following.value
    await connection.stop()
    model.setDraft("hello", for: "s1")
    model.send("s1")
    try await waitUntil { model.core.problems["s1"] == .notSent }
    #expect(model.core.drafts["s1"] == "hello")
    #expect(model.core.outbox.isEmpty)

    running.cancel()
    await running.value
  }

  @Test("parses a snapshot's replies before it goes in; puts older turns in only once the scroll rests, or after 3 s")
  func olderWaitsForRest() async throws {
    let host = TestHost()
    let store = HostStore(MemorySecretStore())
    try store.confirm(host.record, deviceId: host.deviceId)
    let relay = MemoryRelay()
    let manualClock = ManualClock()
    let clock = Stopwatch(manualClock)
    let environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1")
    let connection = RemoteConnection(
      host: host.record, deviceKey: try store.deviceKey(), store: store, environment: environment)
    PairingTestResources.current?.register(connection, clock: manualClock)
    let restClock = ManualClock()
    let model = SyncModel(
      connection: connection, hostName: host.hostName, traceparent: { traceparent }, now: { .zero },
      requestId: { UUID().uuidString.lowercased() }, clock: restClock)
    model.open("s1")
    let running = Task { await model.run() }
    let following = Task { for await status in connection.statuses { await model.statusChanged(status) } }
    await connection.start()
    let side = try await host.accept((await relay.next()).host, stopwatch: clock)
    PairingTestResources.current?.register(side.channel)
    _ = try await side.answerHello(protocolVersion: protocolVersion)
    var answered: [String] = []
    for _ in 0..<3 {
      let message = try JSONSerialization.jsonObject(with: try await firstMessage(of: side)) as? [String: Any]
      answered.append(try #require(message?["requestId"] as? String))
    }
    try await side.send(Data(emptyList.utf8))
    for requestId in answered {
      try await side.send(Data(#"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{}}"#.utf8))
    }
    let reply = "已读 \(UUID().uuidString)"
    let older = sessionSnapshot.replacingOccurrences(
      of: #""items":[]"#, with: #""items":[\#(turn("t9", reply: reply))]"#
    )
    .replacingOccurrences(of: #""hasOlder":false"#, with: #""hasOlder":true"#)
    try await side.send(Data(older.utf8))
    try await waitUntil { model.status == .connected && model.core.sessions["s1"]?.hasOlder == true }
    // So a reply shows whole the first time it comes on screen.
    #expect(MarkdownCache.shared.blocks(for: reply) != nil)

    // Scrolling: the page comes back but waits, and so does what comes after it.
    model.rest.moving = true
    try await answerOlder(side, model: model, with: "t8", hasOlder: true)
    try await side.send(Data(#"{"type":"response","requestId":"none","ok":true,"result":{}}"#.utf8))
    try await waitUntil { restClock.sleeperCount == 1 }
    #expect(model.core.sessions["s1"]?.items.map(\.id) == ["t9"])
    model.rest.moving = false
    restClock.advance(by: ScrollRest.step)
    try await waitUntil { model.core.sessions["s1"]?.items.map(\.id) == ["t8", "t9"] }

    // Still scrolling after three seconds: it goes in anyway.
    model.rest.moving = true
    try await answerOlder(side, model: model, with: "t7", hasOlder: false)
    var waited = Duration.zero
    while waited < ScrollRest.longest {
      try await waitUntil { restClock.sleeperCount == 1 }
      #expect(model.core.sessions["s1"]?.items.count == 2)
      restClock.advance(by: ScrollRest.step)
      waited += ScrollRest.step
    }
    try await waitUntil { model.core.sessions["s1"]?.items.map(\.id) == ["t7", "t8", "t9"] }

    following.cancel()
    running.cancel()
    await running.value
    await following.value
    await connection.stop()
  }

  /// Asks for older turns and answers with one.
  ///
  /// - Remark: For ``olderWaitsForRest()``.
  /// - SideEffects: Queues a fetch; reads from and writes to the host side.
  /// - Parameters:
  ///   - side: The host's side.
  ///   - model: The model.
  ///   - id: The older turn's id.
  ///   - hasOlder: Whether more are left.
  /// - Throws: When the phone sends no fetch.
  private func answerOlder(_ side: HostSide, model: SyncModel, with id: String, hasOlder: Bool) async throws {
    model.loadOlder("s1")
    let fetch = try JSONSerialization.jsonObject(with: try await firstMessage(of: side)) as? [String: Any]
    #expect(fetch?["type"] as? String == "fetch_transcript")
    let requestId = try #require(fetch?["requestId"] as? String)
    try await side.send(
      Data(
        #"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{"items":[\#(turn(id))],"hasOlder":\#(hasOlder)}}"#
          .utf8))
  }

  /// A finished turn, as the host sends it: no steps, or one reply.
  ///
  /// - Remark: For the older-turns test.
  /// - SideEffects: none
  /// - Parameters:
  ///   - id: The turn's id.
  ///   - reply: Its reply, if any.
  /// - Returns: The JSON.
  private func turn(_ id: String, reply: String? = nil) -> String {
    let steps = reply.map { #"{"kind":"text","id":"\#(id)-r","text":"\#($0)"}"# } ?? ""
    return
      #"{"kind":"turn","id":"\#(id)","source":null,"user":{"text":"hi","images":0,"clientMessageId":null,"auto":false,"command":null,"timestamp":0},"steps":[\#(steps)],"outcome":"done","error":null,"startedAt":0,"durationMs":1,"usage":null,"changes":[]}"#
  }

  @Test("writes the list, open sessions and drafts to the cache, and starts the next launch from them")
  func cache() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("atrium-model-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let host = TestHost()
    let cache = SyncCache(root: root, hostId: host.hostId)
    let store = HostStore(MemorySecretStore())
    try store.confirm(host.record, deviceId: host.deviceId)
    let relay = MemoryRelay()
    let manualClock = ManualClock()
    let clock = Stopwatch(manualClock)
    let environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: clock, jitter: { 0 }, appVersion: "1")
    let connection = RemoteConnection(
      host: host.record, deviceKey: try store.deviceKey(), store: store, environment: environment)
    PairingTestResources.current?.register(connection, clock: manualClock)
    let model = SyncModel(
      connection: connection, hostName: host.hostName, traceparent: { traceparent }, now: { .zero },
      requestId: { UUID().uuidString.lowercased() }, cache: cache, clock: manualClock)
    model.open("s1")
    let running = Task { await model.run() }
    let following = Task { for await status in connection.statuses { await model.statusChanged(status) } }
    await connection.start()
    let side = try await host.accept((await relay.next()).host, stopwatch: clock)
    PairingTestResources.current?.register(side.channel)
    _ = try await side.answerHello(protocolVersion: protocolVersion)
    var asked: [String] = []
    for _ in 0..<3 {
      let message = try JSONSerialization.jsonObject(with: try await firstMessage(of: side)) as? [String: Any]
      asked.append(try #require(message?["requestId"] as? String))
    }
    try await side.send(Data(emptyList.utf8))
    for requestId in asked {
      try await side.send(Data(#"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{}}"#.utf8))
    }
    try await side.send(Data(sessionSnapshot.utf8))
    try await waitUntil { model.status == .connected }
    // The throttled write lands a second after the messages, encoded away from the main actor.
    manualClock.advance(by: .seconds(1))
    try await waitUntil { cache.index() != nil && cache.session("s1") != nil }
    try cache.removeAll()
    // Sending clears the draft on disk too, not only in memory.
    model.setDraft("go", for: "s1")
    model.send("s1")
    #expect(cache.drafts() == [:])
    model.setDraft("half", for: "s1")

    following.cancel()
    running.cancel()
    await running.value
    await following.value
    await connection.stop()
    // A write still waiting when the run ended is dropped: a newer owner may have written since.
    try cache.save(drafts: ["s1": "half"])
    manualClock.advance(by: .seconds(2))
    // Gives a woken write every chance to run before checking it did not.
    for _ in 0..<100 { await Task.yield() }
    #expect(cache.index() == nil)
    model.saveNow()

    let next = SyncModel(
      connection: connection, hostName: host.hostName, traceparent: { traceparent }, now: { .zero },
      requestId: { UUID().uuidString.lowercased() }, cache: cache, clock: manualClock)
    #expect(next.core.stale)
    #expect(next.core.drafts["s1"] == "half")
    next.open("s1")
    #expect(next.core.sessions["s1"]?.status == .ready)
    #expect(next.core.sessions["s1"]?.resumePoint?.stream == "st")

    await next.statusChanged(.revoked)
    #expect(cache.index() == nil)
    // Nothing of the revoked host is written again: not the drafts, a page left, nor going to the background.
    next.setDraft("more", for: "s1")
    next.close("s1")
    next.saveNow()
    #expect(!FileManager.default.fileExists(atPath: cache.directory.deletingLastPathComponent().path))
  }

  /// Answers the phone's `subscribe_index` on a channel with an empty list.
  ///
  /// - Remark: The first thing a phone sends on a new connection.
  /// - SideEffects: Reads from and writes to the host side.
  /// - Parameter side: The host's side.
  /// - Throws: When the phone sends something else.
  private func answerList(_ side: HostSide) async throws {
    let subscribe = try JSONSerialization.jsonObject(with: try await firstMessage(of: side)) as? [String: Any]
    #expect(subscribe?["type"] as? String == "subscribe_index")
    let requestId = try #require(subscribe?["requestId"] as? String)
    try await side.send(Data(emptyList.utf8))
    try await side.send(Data(#"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{}}"#.utf8))
  }

  /// The phone's first message, or a failure when none comes within a bounded number of yields.
  ///
  /// - Remark: Without a bound, a phone that never subscribes would hang the test.
  /// - SideEffects: Reads from the host side; yields.
  /// - Parameter side: The host's side of the channel.
  /// - Returns: The message.
  /// - Throws: When nothing comes.
  private func firstMessage(of side: HostSide) async throws -> Data {
    var received: Data?
    let reading = Task { received = try? await side.nextMessage() }
    defer { reading.cancel() }
    try await waitUntil { received != nil }
    return try #require(received)
  }

  /// Waits for the model on the main actor, with a finite yield budget.
  ///
  /// - Remark: No wall clock is involved.
  /// - SideEffects: Yields the main actor.
  /// - Parameter condition: What to wait for.
  /// - Throws: When it never holds.
  private func waitUntil(_ condition: () async -> Bool) async throws {
    for _ in 0..<100_000 {
      if await condition() { return }
      await Task.yield()
    }
    Issue.record("the model did not get there")
    throw CancellationError()
  }
}
