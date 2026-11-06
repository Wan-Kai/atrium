import AtriumProtocol
import AtriumSync
import Testing

/// A core synced on connection 1 whose open session `s1` has a copy at seq 2, now resuming on connection 2.
///
/// - Remark: Requests r4–r6 are connection 2's subscribe, subscribe_sessions and open_session.
/// - SideEffects: none
/// - Returns: The core.
func resumingCore() -> SyncCore {
  var sync = core()
  _ = sync.open("s1")
  _ = sync.connected(generation: 1)
  _ = receive(
    &sync, generation: 1, ok("r1"), indexSnapshotJSON(seq: 3, sessions: [summaryJSON("s1", in: "w1")]), ok("r2"),
    ok("r3"), snapshotJSON("s1", seq: 2, items: [turnJSON("t1")]))
  _ = sync.connected(generation: 2)
  #expect(sync.sessions["s1"]?.resuming == true)
  return sync
}

@Suite("Sync core: MP4 review")
struct SyncMP4ReviewTests {
  @Test("settles a resuming session the host refuses to open, so the connection is synced")
  func refusedWhileResuming() {
    var sync = resumingCore()
    let outputs = receive(&sync, generation: 2, ok("r4"), indexChangesJSON(seq: 3), failed("r6", "session_not_found"))
    #expect(outputs == [.markSynced(generation: 2)])
    #expect(sync.sessions["s1"]?.status == .failed(.sessionNotFound))
    #expect(sync.sessions["s1"]?.resuming == false)
  }

  @Test("takes events it already holds as nothing new while resuming, and still resumes")
  func overlapWhileResuming() {
    var sync = resumingCore()
    let held = #"{"type":"fast_updated","sessionId":"s1","epoch":1,"seq":2,"traceId":null,"fast":true}"#
    let missed = #"{"type":"fast_updated","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"fast":true}"#
    #expect(receive(&sync, generation: 2, ok("r4"), indexChangesJSON(seq: 3), ok("r5"), ok("r6"), held, missed) == [])
    #expect(sync.sessions["s1"]?.seq == 3)
    #expect(
      receive(&sync, generation: 2, #"{"type":"session_resumed","sessionId":"s1","epoch":1,"seq":3}"#)
        == [.markSynced(generation: 2)])
  }

  @Test("does not send to a session still resuming from its copy")
  func noSendWhileResuming() {
    var sync = syncedCore()
    _ = sync.open("s2", cached: cachedSession("s2"))
    sync.setDraft("x", for: "s2")
    #expect(sync.sessions["s2"]?.status == .ready)
    #expect(!sync.canSend("s2"))
    #expect(sync.send("s2") == [])
  }

  @Test("makes a retried message that could not be written again uncertain, not unsent")
  func retryNotWritten() {
    var sync = syncedCore()
    sync.setDraft("go", for: "s1")
    _ = sync.send("s1")
    _ = sync.connected(generation: 2)
    _ = receive(&sync, generation: 2, ok("r5"), indexSnapshotJSON(), ok("r6"), ok("r7"), snapshotJSON("s1"))

    sync.notWritten("r4")
    #expect(sync.outbox.map(\.state) == [.uncertain])
    #expect(sync.drafts["s1"] == nil)
    #expect(sync.problems["s1"] == nil)
  }

  @Test("keeps a page's unsettled messages when it is left, and shows them when it is opened again")
  func keepsOutboxOnClose() {
    var sync = syncedCore()
    sync.setDraft("go", for: "s1")
    _ = sync.send("s1")
    _ = sync.close("s1")
    #expect(sync.outbox.map(\.id) == ["r4"])

    _ = sync.open("s1")
    #expect(!sync.canSend("s1"))
    _ = receive(&sync, generation: 1, promptOK("r4"))
    #expect(sync.outbox.map(\.state) == [.accepted])
  }
}
