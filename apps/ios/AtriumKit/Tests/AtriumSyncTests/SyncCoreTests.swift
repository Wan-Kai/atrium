import AtriumProtocol
import AtriumSync
import Testing

/// The traceparent every command in these tests carries.
let traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

/// A core whose request ids count r1, r2, ….
///
/// - Remark: Deterministic ids make the expected commands exact.
/// - SideEffects: none
/// - Parameter now: The time since some fixed origin; zero unless a test moves it.
/// - Returns: The core.
func core(now: @escaping () -> Duration = { .zero }) -> SyncCore {
  var next = 0
  return SyncCore(
    requestId: {
      next += 1
      return "r\(next)"
    },
    traceparent: { traceparent }, now: now)
}

/// A successful response, as JSON.
///
/// - Remark: With an empty result, as every command MP4a sends answers.
/// - SideEffects: none
/// - Parameter requestId: The request it answers.
/// - Returns: The JSON.
func ok(_ requestId: String) -> String {
  #"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{}}"#
}

/// A failed response, as JSON.
///
/// - Remark: Without parameters.
/// - SideEffects: none
/// - Parameters:
///   - requestId: The request it answers.
///   - code: The error code.
/// - Returns: The JSON.
func failed(_ requestId: String, _ code: String) -> String {
  #"{"type":"response","requestId":"\#(requestId)","ok":false,"error":{"code":"\#(code)"}}"#
}

/// `subscribe_index`.
///
/// - Remark: What every new connection sends first; with a cursor once the list has come.
/// - SideEffects: none
/// - Parameters:
///   - id: Its request id.
///   - cursor: Where the list the phone has ends.
/// - Returns: The command.
func subscribeIndex(_ id: String, cursor: SubscribeIndexCommand.Cursor? = nil) -> Command {
  .subscribeIndex(SubscribeIndexCommand(requestId: id, traceparent: traceparent, cursor: cursor))
}

/// `subscribe_sessions` with the phone's budget.
///
/// - Remark: The budget is the app's own, 6 turns and 512 KiB.
/// - SideEffects: none
/// - Parameters:
///   - id: Its request id.
///   - sessions: The sessions.
///   - resume: Where open sessions' copies end.
/// - Returns: The command.
func subscribeSessions(_ id: String, _ sessions: [String], resume: [ResumePoint]? = nil) -> Command {
  .subscribeSessions(
    SubscribeSessionsCommand(
      requestId: id, traceparent: traceparent, sessionIds: sessions,
      snapshot: SnapshotBudget(turns: 6, bytes: 524_288), resume: resume))
}

/// `open_session`.
///
/// - Remark: Starts the session's pi, so its snapshot follows.
/// - SideEffects: none
/// - Parameters:
///   - id: Its request id.
///   - session: The session.
/// - Returns: The command.
func openSession(_ id: String, _ session: String) -> Command {
  .openSession(OpenSessionCommand(requestId: id, traceparent: traceparent, sessionId: session))
}

/// Feeds the core messages of one generation, collecting what it asks for.
///
/// - Remark: Messages are JSON, as they come off the wire.
/// - SideEffects: none
/// - Parameters:
///   - core: The core, changed in place.
///   - generation: The connection they came on.
///   - messages: The messages.
/// - Returns: Every output, in order.
func receive(_ core: inout SyncCore, generation: Int, _ messages: String...) -> [SyncOutput] {
  messages.flatMap { core.receive(host($0), generation: generation) }
}

@Suite("Sync core")
struct SyncCoreTests {
  @Test("subscribes to the list, then the open sessions with the phone's budget, and opens them")
  func subscribes() {
    var sync = core()
    _ = sync.open("s1")

    #expect(
      sync.connected(generation: 3) == [
        .send(subscribeIndex("r1"), generation: 3),
        .send(subscribeSessions("r2", ["s1"]), generation: 3),
        .send(openSession("r3", "s1"), generation: 3),
      ])
  }

  @Test("subscribes to nothing but the list when no session is open")
  func listOnly() {
    var sync = core()
    #expect(sync.connected(generation: 1) == [.send(subscribeIndex("r1"), generation: 1)])
  }

  @Test("is synced once the list answered and its snapshot came, and says so once")
  func listSynced() {
    var sync = core()
    _ = sync.connected(generation: 1)

    #expect(receive(&sync, generation: 1, indexSnapshotJSON(sessions: [summaryJSON("s1", in: "w1")])) == [])
    #expect(!sync.synced)
    #expect(receive(&sync, generation: 1, ok("r1")) == [.markSynced(generation: 1)])
    #expect(sync.synced)
    #expect(sync.index.sessions.map(\.sessionId) == ["s1"])
    #expect(receive(&sync, generation: 1, indexChangesJSON(seq: 1, sessions: [summaryJSON("s2", in: "w1")])) == [])
    #expect(sync.index.sessions.map(\.sessionId) == ["s1", "s2"])
  }

  @Test("waits for every open session's snapshot before it is synced")
  func sessionsSynced() {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.connected(generation: 1)

    #expect(receive(&sync, generation: 1, ok("r1"), indexSnapshotJSON(), ok("r2"), ok("r3")) == [])
    #expect(sync.sessions["s1"]?.status == .loading)
    #expect(receive(&sync, generation: 1, snapshotJSON("s1", items: [turnJSON("t1")])) == [.markSynced(generation: 1)])
    #expect(sync.sessions["s1"]?.status == .ready)
    #expect(sync.sessions["s1"]?.items.map(\.id) == ["t1"])
  }

  @Test(
    "counts a session the host would not open or subscribe to as settled, showing the failure",
    arguments: [("r2", "session_not_found"), ("r3", "session_cwd_missing")])
  func sessionFailed(request: String, code: String) {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.connected(generation: 1)
    let rest = ["r2", "r3"].filter { $0 != request }.map(ok)

    _ = receive(&sync, generation: 1, ok("r1"), indexSnapshotJSON())
    for answer in rest { #expect(sync.receive(host(answer), generation: 1) == []) }
    #expect(receive(&sync, generation: 1, failed(request, code)) == [.markSynced(generation: 1)])
    #expect(sync.sessions["s1"]?.status == .failed(ErrorCode(rawValue: code)!))
  }

  @Test("stays syncing when the list subscription fails")
  func listFailed() {
    var sync = core()
    _ = sync.connected(generation: 1)
    #expect(receive(&sync, generation: 1, failed("r1", "internal_error"), indexSnapshotJSON()) == [])
    #expect(!sync.synced)
  }

  @Test("drops messages of an older connection, answers it never asked for, and lists of another instance")
  func oldGeneration() {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.connected(generation: 1)
    _ = sync.connected(generation: 2)

    #expect(
      receive(&sync, generation: 1, ok("r1"), indexSnapshotJSON(), ok("r2"), ok("r3"), snapshotJSON("s1")) == [])
    #expect(!sync.index.ready)
    #expect(sync.sessions["s1"]?.status == .loading)
    // r1–r3 belonged to the first connection; the second asked r4–r6.
    #expect(receive(&sync, generation: 2, ok("r1"), ok("r99"), indexSnapshotJSON()) == [])
    #expect(!sync.synced)
    #expect(receive(&sync, generation: 2, ok("r4"), ok("r5"), ok("r6")) == [])
    #expect(receive(&sync, generation: 2, snapshotJSON("s1")) == [.markSynced(generation: 2)])
  }

  @Test("continues on a new connection from what it has: the list from its cursor, the session from its copy")
  func reconnect() {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.connected(generation: 1)
    _ = receive(
      &sync, generation: 1, ok("r1"), indexSnapshotJSON(seq: 3, sessions: [summaryJSON("s1", in: "w1")]), ok("r2"),
      ok("r3"), snapshotJSON("s1", seq: 2, items: [turnJSON("t1")]))
    #expect(sync.synced)

    #expect(
      sync.connected(generation: 2) == [
        .send(subscribeIndex("r4", cursor: .init(generation: "h1", seq: 3)), generation: 2),
        .send(
          subscribeSessions("r5", ["s1"], resume: [ResumePoint(sessionId: "s1", stream: "st-1", epoch: 1, seq: 2)]),
          generation: 2),
        .send(openSession("r6", "s1"), generation: 2),
      ])
    #expect(!sync.synced)
    #expect(sync.sessions["s1"]?.status == .ready)
    #expect(sync.sessions["s1"]?.resuming == true)
    #expect(sync.sessions["s1"]?.items.map(\.id) == ["t1"])
    let missed = #"{"type":"fast_updated","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"fast":true}"#
    #expect(receive(&sync, generation: 2, ok("r4"), indexChangesJSON(seq: 3), ok("r5"), ok("r6"), missed) == [])
    #expect(
      receive(&sync, generation: 2, #"{"type":"session_resumed","sessionId":"s1","epoch":1,"seq":3}"#)
        == [.markSynced(generation: 2)])
    #expect(sync.sessions["s1"]?.resuming == false)
    #expect(sync.sessions["s1"]?.seq == 3)
    #expect(sync.connected(generation: 1) == [])
  }

  @Test("opens a session once synced on its own, without going back to syncing")
  func openLater() {
    var sync = core()
    _ = sync.connected(generation: 1)
    _ = receive(&sync, generation: 1, ok("r1"), indexSnapshotJSON())

    #expect(
      sync.open("s2") == [
        .send(subscribeSessions("r2", ["s2"]), generation: 1),
        .send(openSession("r3", "s2"), generation: 1),
      ])
    #expect(sync.open("s2") == [])
    #expect(receive(&sync, generation: 1, ok("r2"), ok("r3"), snapshotJSON("s2")) == [])
    #expect(sync.sessions["s2"]?.status == .ready)
  }

  @Test("only records a session opened before any connection, and sends nothing")
  func openOffline() {
    var sync = core()
    #expect(sync.open("s1") == [])
    #expect(sync.openSessions == ["s1"])
    #expect(sync.sessions["s1"]?.status == .loading)
  }

  @Test("resubscribes for a fresh snapshot when an event does not follow on")
  func resync() {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.connected(generation: 1)
    _ = receive(&sync, generation: 1, ok("r1"), indexSnapshotJSON(), ok("r2"), ok("r3"), snapshotJSON("s1"))

    let gap = #"{"type":"fast_updated","sessionId":"s1","epoch":1,"seq":5,"traceId":null,"fast":true}"#
    #expect(
      receive(&sync, generation: 1, gap) == [
        .send(subscribeSessions("r4", []), generation: 1),
        .send(subscribeSessions("r5", ["s1"]), generation: 1),
      ])
    #expect(sync.sessions["s1"]?.status == .loading)
    #expect(receive(&sync, generation: 1, ok("r4"), ok("r5"), snapshotJSON("s1", seq: 7)) == [])
    #expect(sync.sessions["s1"]?.seq == 7)
  }

  @Test("closes a session: stops watching it and forgets it, and drops its later events")
  func close() {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.open("s2")
    _ = sync.connected(generation: 1)

    #expect(
      sync.close("s1") == [
        .send(subscribeSessions("r5", ["s2"]), generation: 1), .send(closeTab("r6", "s1"), generation: 1),
      ])
    #expect(sync.openSessions == ["s2"])
    #expect(sync.sessions["s1"] == nil)
    #expect(receive(&sync, generation: 1, snapshotJSON("s1")) == [])
    #expect(sync.sessions["s1"] == nil)
    #expect(sync.close("s1") == [])
  }

  @Test("does not count a closed session against being synced")
  func closeWhileSyncing() {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.connected(generation: 1)
    _ = receive(&sync, generation: 1, ok("r1"), indexSnapshotJSON())

    #expect(
      sync.close("s1") == [
        .send(subscribeSessions("r4", []), generation: 1), .send(closeTab("r5", "s1"), generation: 1),
        .markSynced(generation: 1),
      ])
  }
}

@Suite("Sync core: back in front")
struct SyncCoreResumeTests {
  @Test("syncs the same connection again from the start when it says it is syncing after being synced")
  func againOnSameConnection() {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.connected(generation: 1)
    _ = receive(&sync, generation: 1, ok("r1"), indexSnapshotJSON(), ok("r2"), ok("r3"), snapshotJSON("s1"))
    #expect(sync.synced)

    #expect(
      sync.connected(generation: 1) == [
        .send(subscribeIndex("r4", cursor: .init(generation: "h1", seq: 0)), generation: 1),
        .send(subscribeSessions("r5", []), generation: 1),
        .send(
          subscribeSessions("r6", ["s1"], resume: [ResumePoint(sessionId: "s1", stream: "st-1", epoch: 1, seq: 0)]),
          generation: 1),
        .send(openSession("r7", "s1"), generation: 1),
      ])
    #expect(!sync.synced)
    #expect(sync.sessions["s1"]?.resuming == true)
    #expect(receive(&sync, generation: 1, ok("r1"), ok("r2"), indexChangesJSON(seq: 0), snapshotJSON("s1")) == [])
    #expect(receive(&sync, generation: 1, ok("r4")) == [.markSynced(generation: 1)])
  }

  @Test("does not start over while the first sync of the connection is still under way")
  func notWhileSyncing() {
    var sync = core()
    _ = sync.connected(generation: 1)
    #expect(sync.connected(generation: 1) == [])
  }
}

@Suite("Sync core: requests of a replaced connection")
struct SyncCoreVoidTests {
  @Test("does not count an answer to the replaced connection's list request on the new one")
  func voided() {
    var sync = core()
    _ = sync.connected(generation: 1)
    _ = sync.connected(generation: 2)
    // r1 was the first connection's subscribe_index; the second asked r2.
    #expect(receive(&sync, generation: 2, ok("r1"), indexSnapshotJSON()) == [])
    #expect(receive(&sync, generation: 2, ok("r2")) == [.markSynced(generation: 2)])
  }
}

/// `close_tab`.
///
/// - Remark: Lets go of the phone's tab, so the Mac may reclaim the session.
/// - SideEffects: none
/// - Parameters:
///   - id: Its request id.
///   - session: The session.
/// - Returns: The command.
func closeTab(_ id: String, _ session: String) -> Command {
  .closeTab(CloseTabCommand(requestId: id, traceparent: traceparent, sessionId: session))
}

@Suite("Sync core: review fixes")
struct SyncCoreReviewTests {
  @Test("closes the phone's tab of a page it leaves, so the Mac can let the session go")
  func closesTab() {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.connected(generation: 1)
    #expect(
      sync.close("s1") == [
        .send(subscribeSessions("r4", []), generation: 1), .send(closeTab("r5", "s1"), generation: 1),
      ])
  }

  @Test("does not let a closed page's late failure mark the page opened again")
  func lateFailureAfterReopen() {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.connected(generation: 1)
    _ = receive(&sync, generation: 1, ok("r1"), indexSnapshotJSON())
    _ = sync.close("s1")
    #expect(sync.synced)
    _ = sync.open("s1")
    // r2/r3 belonged to the first opening; the reopening asked r6/r7.
    #expect(receive(&sync, generation: 1, failed("r3", "session_not_found"), failed("r2", "internal_error")) == [])
    #expect(sync.sessions["s1"]?.status == .loading)
    _ = receive(&sync, generation: 1, snapshotJSON("s1"))
    #expect(sync.sessions["s1"]?.status == .ready)
  }

  @Test("counts a session handed to a terminal as settled, saying so, until its snapshot comes")
  func handedOff() {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.connected(generation: 1)
    let handed = summaryJSON("s1", in: "w1", extra: ["handedOff": "true"])
    #expect(
      receive(&sync, generation: 1, ok("r1"), indexSnapshotJSON(sessions: [handed]), ok("r2"), ok("r3"))
        == [.markSynced(generation: 1)])
    #expect(sync.sessions["s1"]?.status == .handedOff)
    _ = receive(&sync, generation: 1, snapshotJSON("s1"))
    #expect(sync.sessions["s1"]?.status == .ready)
    _ = receive(&sync, generation: 1, indexChangesJSON(seq: 1, sessions: [handed]))
    #expect(sync.sessions["s1"]?.status == .ready)
  }
}
