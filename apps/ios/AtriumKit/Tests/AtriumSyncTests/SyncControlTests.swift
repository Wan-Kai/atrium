import AtriumProtocol
import AtriumSync
import Foundation
import Testing

/// A `steer` as the core sends it.
///
/// - Remark: Text only.
/// - SideEffects: none
/// - Parameters:
///   - id: Its request id.
///   - text: The text.
/// - Returns: The command.
func steerCommand(_ id: String, _ text: String) -> Command {
  .steer(SteerCommand(requestId: id, traceparent: traceparent, sessionId: "s1", text: text))
}

/// A synced core whose open session `s1` is listed with an attention of the given kind.
///
/// - Remark: Requests r1–r3 were the sync's own.
/// - SideEffects: none
/// - Parameter attention: The attention, as JSON.
/// - Returns: The core.
func attentiveCore(_ attention: String) -> SyncCore {
  var sync = core()
  _ = sync.open("s1")
  _ = sync.connected(generation: 1)
  let summary = summaryJSON("s1", in: "w1", extra: ["attention": attention])
  _ = receive(
    &sync, generation: 1, ok("r1"), indexSnapshotJSON(sessions: [summary]), ok("r2"), ok("r3"), snapshotJSON("s1"))
  return sync
}

@Suite("Sync core: steering and run control")
struct SyncControlTests {
  @Test("sends a steer with its receipt, and lets it go once the host took it")
  func steer() {
    var sync = syncedCore()
    sync.setDraft("看看测试", for: "s1")
    #expect(sync.send("s1", steer: true) == [.send(steerCommand("r4", "看看测试"), generation: 1)])
    #expect(sync.outbox == [Outgoing(id: "r4", sessionId: "s1", text: "看看测试", state: .sending, kind: .steer)])
    _ = receive(&sync, generation: 1, promptOK("r4", "started"))
    #expect(sync.outbox.isEmpty)
  }

  @Test("retries an unanswered steer as a steer, with its own id, after a reconnect")
  func steerRetry() {
    var sync = syncedCore()
    sync.setDraft("看看测试", for: "s1")
    _ = sync.send("s1", steer: true)
    _ = sync.connected(generation: 2)
    #expect(
      receive(&sync, generation: 2, ok("r5"), indexSnapshotJSON(), ok("r6"), ok("r7"), snapshotJSON("s1")) == [
        .markSynced(generation: 2), .send(steerCommand("r4", "看看测试"), generation: 2),
      ])
  }

  @Test(
    "sends each run-control action for the session",
    arguments: [
      (SessionAction.stop, "stop"), (.resumeQueue, "resume_queue"), (.clearQueue, "clear_queue"),
      (.removeQueued("q1"), "remove_queued"), (.steerQueued("q1"), "steer_queued"),
      (.updateQueued("q1", "改过的"), "update_queued"), (.retryRun, "retry_run"), (.resumeDeliveries, "resume_deliveries"),
    ])
  func actions(action: SessionAction, type: String) throws {
    var sync = syncedCore()
    let outputs = sync.perform(action, in: "s1")
    guard case .send(let command, let generation)? = outputs.first, outputs.count == 1 else {
      Issue.record("expected one command, got \(outputs)")
      return
    }
    #expect(generation == 1)
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any]
    #expect(json?["type"] as? String == type)
    #expect(json?["requestId"] as? String == "r4")
    #expect(json?["sessionId"] as? String == "s1")
  }

  @Test("carries the item and text of a queued message's action")
  func actionFields() {
    var sync = syncedCore()
    #expect(
      sync.perform(.updateQueued("q1", "改过的"), in: "s1") == [
        .send(
          .updateQueued(
            UpdateQueuedCommand(requestId: "r4", traceparent: traceparent, sessionId: "s1", itemId: "q1", text: "改过的")),
          generation: 1)
      ])
    #expect(
      sync.perform(.resumeDeliveries, in: "s1") == [
        .send(
          .resumeDeliveries(
            ResumeDeliveriesCommand(requestId: "r5", traceparent: traceparent, sessionId: "s1", tree: false)),
          generation: 1)
      ])
  }

  @Test("answers a question and a dialog with what the sheet made")
  func answers() {
    var sync = syncedCore()
    let reply = QuestionReply.answers(.init(answers: [QuestionAnswer(selected: [1], other: nil)]))
    #expect(
      sync.perform(.answerQuestion("qq", reply), in: "s1") == [
        .send(
          .answerQuestion(
            AnswerQuestionCommand(
              requestId: "r4", traceparent: traceparent, sessionId: "s1", questionId: "qq", answer: reply)),
          generation: 1)
      ])
    #expect(
      sync.perform(.answerInteraction("i1", .cancelled), in: "s1") == [
        .send(
          .answerInteraction(
            AnswerInteractionCommand(
              requestId: "r5", traceparent: traceparent, sessionId: "s1", interactionId: "i1", answer: .cancelled)),
          generation: 1)
      ])
  }

  @Test("does nothing before the connection is synced or for a session not open")
  func noAction() {
    var sync = core()
    _ = sync.open("s1")
    #expect(sync.perform(.stop, in: "s1") == [])
    var synced = syncedCore()
    #expect(synced.perform(.stop, in: "s2") == [])
  }

  @Test("remembers why an action failed until it is dismissed or the action is taken again")
  func actionProblem() {
    var sync = syncedCore()
    _ = sync.perform(.stop, in: "s1")
    _ = receive(&sync, generation: 1, failed("r4", "session_busy"))
    #expect(sync.actionProblems["s1"] == ActionProblem(action: .stop, code: .sessionBusy))
    _ = sync.perform(.stop, in: "s1")
    #expect(sync.actionProblems["s1"] == nil)
    _ = receive(&sync, generation: 1, failed("r5", "session_busy"))
    sync.dismissActionProblem(in: "s1")
    #expect(sync.actionProblems["s1"] == nil)
  }

  @Test("clears an error the page shows once, and not an auth one, nor one already cleared")
  func clearAttention() {
    var sync = attentiveCore(#"{"reason":"error","at":1,"cleared":false,"text":null}"#)
    #expect(
      sync.clearAttention("s1") == [
        .send(
          .clearAttention(ClearAttentionCommand(requestId: "r4", traceparent: traceparent, sessionId: "s1")),
          generation: 1)
      ])
    #expect(sync.clearAttention("s1") == [])

    var auth = attentiveCore(#"{"reason":"auth","at":1,"cleared":false,"text":null}"#)
    #expect(auth.clearAttention("s1") == [])
    var cleared = attentiveCore(#"{"reason":"error","at":1,"cleared":true,"text":null}"#)
    #expect(cleared.clearAttention("s1") == [])
  }
}
