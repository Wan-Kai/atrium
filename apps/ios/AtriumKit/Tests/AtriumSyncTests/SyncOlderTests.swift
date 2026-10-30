import AtriumProtocol
import AtriumSync
import Testing

/// A synced core whose open session `s1` holds turns `t3` and `t4` at epoch 1, with older ones on the Mac.
///
/// - Remark: The next request id is `r4`.
/// - SideEffects: none
/// - Returns: The core.
func olderCore() -> SyncCore {
  var sync = core()
  _ = sync.open("s1")
  _ = sync.connected(generation: 1)
  _ = receive(
    &sync, generation: 1, ok("r1"), indexSnapshotJSON(), ok("r2"), ok("r3"),
    snapshotJSON("s1", items: [turnJSON("t3"), turnJSON("t4")], hasOlder: true))
  return sync
}

/// A `fetch_transcript` answer, as JSON.
///
/// - Remark: Items oldest first.
/// - SideEffects: none
/// - Parameters:
///   - requestId: The request it answers.
///   - turns: The turns' ids.
///   - hasOlder: Whether still older ones exist.
/// - Returns: The JSON.
func olderOK(_ requestId: String, _ turns: [String], hasOlder: Bool) -> String {
  let items = turns.map { turnJSON($0) }.joined(separator: ",")
  return
    #"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{"items":[\#(items)],"hasOlder":\#(hasOlder)}}"#
}

/// The `fetch_transcript` the phone sends for older turns.
///
/// - Remark: 3 items and 256 KiB at most (SPEC-0005 "MP4a 定的细节" 9).
/// - SideEffects: none
/// - Parameters:
///   - requestId: Its request id.
///   - epoch: The epoch the phone's items come from.
///   - before: The earliest item the phone has.
/// - Returns: The output.
func fetchOlder(_ requestId: String, epoch: Int, before: String) -> SyncOutput {
  .send(
    .fetchTranscript(
      FetchTranscriptCommand(
        requestId: requestId, traceparent: traceparent, sessionId: "s1", epoch: epoch, before: before, limit: 3,
        maxBytes: 262_144)),
    generation: 1)
}

@Suite("Sync core: older turns")
struct SyncOlderTests {
  @Test("opens sessions with 3 turns and 256 KiB")
  func budget() {
    #expect(SyncCore.snapshotBudget == SnapshotBudget(turns: 3, bytes: 262_144))
  }

  @Test("asks once for the items before the earliest, and puts them first with the new hasOlder")
  func loads() {
    var sync = olderCore()
    #expect(sync.loadOlder("s1") == [fetchOlder("r4", epoch: 1, before: "t3")])
    #expect(sync.loadingOlder == ["s1"])
    #expect(sync.loadOlder("s1") == [])
    _ = receive(&sync, generation: 1, olderOK("r4", ["t1", "t2"], hasOlder: false))
    #expect(sync.sessions["s1"]?.items.map(\.id) == ["t1", "t2", "t3", "t4"])
    #expect(sync.sessions["s1"]?.hasOlder == false)
    #expect(sync.loadingOlder == [])
    #expect(sync.loadOlder("s1") == [])
  }

  @Test("drops an answer a new snapshot has overtaken, and a failure only ends the loading")
  func stale() {
    var sync = olderCore()
    _ = sync.loadOlder("s1")
    _ = receive(&sync, generation: 1, snapshotJSON("s1", epoch: 2, items: [turnJSON("t4")], hasOlder: true))
    _ = receive(&sync, generation: 1, olderOK("r4", ["t2"], hasOlder: true))
    #expect(sync.sessions["s1"]?.items.map(\.id) == ["t4"])
    #expect(sync.loadingOlder == [])
    #expect(sync.loadOlder("s1") == [fetchOlder("r5", epoch: 2, before: "t4")])
    _ = receive(&sync, generation: 1, failed("r5", "transcript_changed"))
    #expect(sync.loadingOlder == [])
    #expect(sync.sessions["s1"]?.items.map(\.id) == ["t4"])
    #expect(sync.sessions["s1"]?.hasOlder == true)
  }

  @Test("an answer for the same epoch whose earliest item moved is dropped")
  func moved() {
    var sync = olderCore()
    _ = sync.loadOlder("s1")
    _ = receive(&sync, generation: 1, snapshotJSON("s1", items: [turnJSON("t4")], hasOlder: true))
    _ = receive(&sync, generation: 1, olderOK("r4", ["t2"], hasOlder: true))
    #expect(sync.sessions["s1"]?.items.map(\.id) == ["t4"])
  }

  @Test("an answer from an older epoch is dropped even when the earliest item is the same")
  func rebuilt() {
    var sync = olderCore()
    _ = sync.loadOlder("s1")
    _ = receive(
      &sync, generation: 1, snapshotJSON("s1", epoch: 2, items: [turnJSON("t3"), turnJSON("t4")], hasOlder: true))
    _ = receive(&sync, generation: 1, olderOK("r4", ["t2"], hasOlder: false))
    #expect(sync.sessions["s1"]?.items.map(\.id) == ["t3", "t4"])
    #expect(sync.sessions["s1"]?.hasOlder == true)
  }

  @Test("a new connection voids the request; nothing goes before the sync or without older items")
  func voided() {
    var sync = olderCore()
    _ = sync.loadOlder("s1")
    _ = sync.connected(generation: 2)
    #expect(sync.loadingOlder == [])
    #expect(sync.loadOlder("s1") == [])
    _ = receive(&sync, generation: 2, olderOK("r4", ["t2"], hasOlder: true))
    #expect(sync.sessions["s1"]?.items.map(\.id) == ["t3", "t4"])
    var none = syncedCore()
    #expect(none.loadOlder("s1") == [])
    #expect(none.loadOlder("s9") == [])
  }

  @Test("closing the page forgets its loading")
  func closed() {
    var sync = olderCore()
    _ = sync.loadOlder("s1")
    _ = sync.close("s1")
    #expect(sync.loadingOlder == [])
  }
}
