import AtriumProtocol
import AtriumSync
import Testing

/// A `prompt` as the core sends it.
///
/// - Remark: Text only; images come in MP5.
/// - SideEffects: none
/// - Parameters:
///   - id: Its request id.
///   - text: The text.
///   - session: The session.
/// - Returns: The command.
func promptCommand(_ id: String, _ text: String, session: String = "s1") -> Command {
  .prompt(PromptCommand(requestId: id, traceparent: traceparent, sessionId: session, text: text))
}

/// A successful `prompt` answer, as JSON.
///
/// - Remark: `started`, `handled` or `queued`.
/// - SideEffects: none
/// - Parameters:
///   - requestId: The request it answers.
///   - disposition: What the host did.
/// - Returns: The JSON.
func promptOK(_ requestId: String, _ disposition: String = "started") -> String {
  let item = disposition == "queued" ? #","itemId":"q1""# : ""
  return
    #"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{"disposition":"\#(disposition)"\#(item)}}"#
}

/// A turn the host started for a message, as a `turn_started` event.
///
/// - Remark: Its `clientMessageId` is the message's request id.
/// - SideEffects: none
/// - Parameters:
///   - seq: The event's seq.
///   - clientMessageId: The message's request id.
/// - Returns: The JSON.
func turnStartedJSON(seq: Int, clientMessageId: String) -> String {
  let turn = turnJSON("t\(seq)", outcome: "running")
    .replacingOccurrences(of: #""clientMessageId":null"#, with: #""clientMessageId":"\#(clientMessageId)""#)
  return #"{"type":"turn_started","sessionId":"s1","epoch":1,"seq":\#(seq),"traceId":null,"turn":\#(turn)}"#
}

/// A synced core with session `s1` open and up to date at seq 0, on connection 1.
///
/// - Remark: Requests r1–r3 were the sync's own.
/// - SideEffects: none
/// - Parameter now: The clock.
/// - Returns: The core.
func syncedCore(now: @escaping () -> Duration = { .zero }) -> SyncCore {
  var sync = core(now: now)
  _ = sync.open("s1")
  _ = sync.connected(generation: 1)
  _ = receive(&sync, generation: 1, ok("r1"), indexSnapshotJSON(), ok("r2"), ok("r3"), snapshotJSON("s1"))
  #expect(sync.synced)
  return sync
}

/// A mutable time for a test's clock.
///
/// - Remark: Moved by the test between steps of the core.
// Unchecked: only the test's own task reads and moves it.
final class TestTime: @unchecked Sendable {
  /// The time now.
  var now = Duration.zero
}

@Suite("Sync core: sending")
struct SyncOutboxTests {
  @Test("sends the draft as a prompt with a new request id, and shows it as sending until answered")
  func sends() {
    var sync = syncedCore()
    #expect(sync.canSend("s1"))
    sync.setDraft("你好", for: "s1")

    #expect(sync.send("s1") == [.send(promptCommand("r4", "你好"), generation: 1)])
    #expect(sync.drafts["s1"] == nil)
    #expect(sync.outbox == [Outgoing(id: "r4", sessionId: "s1", text: "你好", state: .sending)])
    #expect(!sync.canSend("s1"))
    #expect(sync.send("s1") == [])
  }

  @Test("does not send before the connection is synced, to a session not up to date, or nothing at all")
  func cannotSend() {
    var sync = core()
    _ = sync.open("s1")
    sync.setDraft("x", for: "s1")
    #expect(!sync.canSend("s1"))
    #expect(sync.send("s1") == [])

    var synced = syncedCore()
    synced.setDraft(" \n ", for: "s1")
    #expect(synced.send("s1") == [])
    #expect(synced.outbox.isEmpty)
    synced.setDraft("x", for: "s2")
    #expect(!synced.canSend("s2"))
    #expect(synced.send("s2") == [])
  }

  @Test("puts the text back when it never left, saying it was not sent")
  func notWritten() {
    var sync = syncedCore()
    sync.setDraft("first", for: "s1")
    _ = sync.send("s1")
    sync.setDraft("second", for: "s1")

    sync.notWritten("r4")
    #expect(sync.outbox.isEmpty)
    #expect(sync.drafts["s1"] == "first\nsecond")
    #expect(sync.problems["s1"] == .notSent)
    #expect(sync.canSend("s1"))
    sync.setDraft("again", for: "s1")
    #expect(sync.problems["s1"] == nil)
  }

  @Test("keeps an accepted message until its turn shows, and lets a new one go meanwhile")
  func accepted() {
    var sync = syncedCore()
    sync.setDraft("go", for: "s1")
    _ = sync.send("s1")

    #expect(receive(&sync, generation: 1, promptOK("r4")) == [])
    #expect(sync.outbox.map(\.state) == [.accepted])
    #expect(sync.canSend("s1"))
    #expect(sync.lastDelivered["s1"] == nil)
    _ = receive(&sync, generation: 1, turnStartedJSON(seq: 1, clientMessageId: "r4"))
    #expect(sync.outbox.isEmpty)
    #expect(sync.lastDelivered["s1"] == "r4")
  }

  @Test("lets go of a message pi handled or queued at once", arguments: ["handled", "queued"])
  func handledOrQueued(disposition: String) {
    var sync = syncedCore()
    sync.setDraft("go", for: "s1")
    _ = sync.send("s1")
    _ = receive(&sync, generation: 1, promptOK("r4", disposition))
    #expect(sync.outbox.isEmpty)
  }

  @Test("puts the text back with the host's reason when it refused the message")
  func refused() {
    var sync = syncedCore()
    sync.setDraft("go", for: "s1")
    _ = sync.send("s1")
    _ = receive(&sync, generation: 1, failed("r4", "session_busy"))
    #expect(sync.outbox.isEmpty)
    #expect(sync.drafts["s1"] == "go")
    #expect(sync.problems["s1"] == .refused(.sessionBusy))
  }

  @Test("cannot tell after outcome_unknown unless the transcript has it, and sends it again under a new id")
  func unknown() {
    var sync = syncedCore()
    sync.setDraft("go", for: "s1")
    _ = sync.send("s1")
    _ = receive(&sync, generation: 1, failed("r4", "outcome_unknown"))
    #expect(sync.outbox.map(\.state) == [.uncertain])
    #expect(!sync.canSend("s1"))

    #expect(sync.resend("r4") == [.send(promptCommand("r5", "go"), generation: 1)])
    #expect(sync.outbox == [Outgoing(id: "r5", sessionId: "s1", text: "go", state: .sending)])
    #expect(sync.resend("r5") == [])
  }

  @Test("counts a message as delivered when the transcript has it, whatever the answer said")
  func unknownButThere() {
    var sync = syncedCore()
    sync.setDraft("go", for: "s1")
    _ = sync.send("s1")
    _ = receive(&sync, generation: 1, turnStartedJSON(seq: 1, clientMessageId: "r4"))
    _ = receive(&sync, generation: 1, failed("r4", "outcome_unknown"))
    #expect(sync.outbox.isEmpty)
    #expect(sync.lastDelivered["s1"] == "r4")
  }

  @Test("retries a message left unanswered by a dropped connection once, with its own id, after the next sync")
  func retryOnce() {
    var sync = syncedCore()
    sync.setDraft("go", for: "s1")
    _ = sync.send("s1")

    _ = sync.connected(generation: 2)
    #expect(
      receive(&sync, generation: 2, ok("r5"), indexSnapshotJSON(), ok("r6"), ok("r7"), snapshotJSON("s1")) == [
        .markSynced(generation: 2), .send(promptCommand("r4", "go"), generation: 2),
      ])
    #expect(sync.outbox.map(\.state) == [.sending])

    _ = sync.connected(generation: 3)
    _ = receive(&sync, generation: 3, ok("r8"), indexSnapshotJSON(), ok("r9"), ok("r10"), snapshotJSON("s1"))
    #expect(sync.outbox.map(\.state) == [.uncertain])
  }

  @Test("finds a message the dropped connection delivered in the next snapshot, and does not retry it")
  func deliveredMeanwhile() {
    var sync = syncedCore()
    sync.setDraft("go", for: "s1")
    _ = sync.send("s1")
    let turn = turnJSON("t9").replacingOccurrences(of: #""clientMessageId":null"#, with: #""clientMessageId":"r4""#)

    _ = sync.connected(generation: 2)
    #expect(
      receive(
        &sync, generation: 2, ok("r5"), indexSnapshotJSON(), ok("r6"), ok("r7"), snapshotJSON("s1", items: [turn]))
        == [.markSynced(generation: 2)])
    #expect(sync.outbox.isEmpty)
    #expect(sync.lastDelivered["s1"] == "r4")
  }

  @Test("does not retry a message sent ten minutes or more before the sync; it is uncertain")
  func tooOld() {
    let time = TestTime()
    var sync = syncedCore { time.now }
    sync.setDraft("go", for: "s1")
    _ = sync.send("s1")
    time.now = .seconds(600)

    _ = sync.connected(generation: 2)
    #expect(
      receive(&sync, generation: 2, ok("r5"), indexSnapshotJSON(), ok("r6"), ok("r7"), snapshotJSON("s1"))
        == [.markSynced(generation: 2)])
    #expect(sync.outbox.map(\.state) == [.uncertain])
  }

  @Test("lets go of accepted messages at the next sync, and of a closed session's messages at once")
  func letGo() {
    var sync = syncedCore()
    sync.setDraft("one", for: "s1")
    _ = sync.send("s1")
    _ = receive(&sync, generation: 1, promptOK("r4"))
    _ = sync.connected(generation: 2)
    _ = receive(&sync, generation: 2, ok("r5"), indexSnapshotJSON(), ok("r6"), ok("r7"), snapshotJSON("s1"))
    #expect(sync.outbox.isEmpty)

    sync.setDraft("two", for: "s1")
    _ = sync.send("s1")
    _ = sync.close("s1")
    #expect(sync.outbox.isEmpty)
  }
}
