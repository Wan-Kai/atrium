import AtriumProtocol
import AtriumSync
import Testing

/// A text step, as JSON.
///
/// - Remark: For turns written as JSON.
/// - SideEffects: none
/// - Parameters:
///   - id: Its id.
///   - text: Its text.
/// - Returns: The JSON.
func textStepJSON(_ id: String, _ text: String) -> String {
  #"{"kind":"text","id":"\#(id)","text":"\#(text)"}"#
}

/// A running tool step, as JSON.
///
/// - Remark: A bash call without output yet.
/// - SideEffects: none
/// - Parameter id: Its id.
/// - Returns: The JSON.
func toolStepJSON(_ id: String) -> String {
  #"{"kind":"tool","id":"\#(id)","callId":"c\#(id)","tool":"bash","args":{"command":"ls"},"status":"running","output":null,"details":null,"partial":false}"#
}

/// A session state that took a snapshot with the given items.
///
/// - Remark: Epoch 1 at `seq`.
/// - SideEffects: none
/// - Parameters:
///   - seq: Where the snapshot stands.
///   - items: Its items, as JSON.
/// - Returns: The state.
func readyState(seq: Int, items: [String]) -> SessionState {
  var state = SessionState(sessionId: "s1")
  #expect(state.apply(event(snapshotJSON(seq: seq, items: items))) == .applied)
  return state
}

/// The ids of a state's items, in order.
///
/// - Remark: Turns and notices alike.
/// - SideEffects: none
/// - Parameter state: The state.
/// - Returns: The ids.
func ids(_ state: SessionState) -> [String] {
  state.items.map(\.id)
}

/// The text of a turn's step, if it is a text step.
///
/// - Remark: For checking streamed text.
/// - SideEffects: none
/// - Parameters:
///   - state: The state.
///   - turn: The turn's index among the items.
///   - step: The step's index.
/// - Returns: The text, or `nil`.
func stepText(_ state: SessionState, turn: Int, step: Int) -> String? {
  guard case .turn(let found) = state.items[turn], case .text(let text) = found.steps[step] else { return nil }
  return text.text
}

@Suite("Session state")
struct SessionStateTests {
  @Test("ignores events before the snapshot, then takes the snapshot whole")
  func snapshot() {
    var state = SessionState(sessionId: "s1")
    let early = #"{"type":"run_started","sessionId":"s1","epoch":1,"seq":9,"traceId":null,"runId":"r","startedAt":1}"#

    #expect(state.apply(event(early)) == .ignored)
    #expect(state.status == .loading)
    #expect(
      state.apply(event(snapshotJSON(epoch: 2, seq: 4, items: [noticeJSON("n1"), turnJSON("t1")], hasOlder: true)))
        == .applied)

    #expect(state.status == .ready)
    #expect(state.epoch == 2)
    #expect(state.seq == 4)
    #expect(state.stream == "st-1")
    #expect(state.hasOlder)
    #expect(ids(state) == ["n1", "t1"])
  }

  @Test("takes a snapshot of a session whose pi has exited as exited")
  func exited() {
    var state = SessionState(sessionId: "s1")
    _ = state.apply(event(snapshotJSON(exited: true)))
    #expect(state.status == .exited)
  }

  @Test("follows a run: a turn opens, text grows, a tool is updated, the turn ends, a notice follows")
  func run() {
    var state = readyState(seq: 0, items: [turnJSON("t0")])
    let events = [
      #"{"type":"run_started","sessionId":"s1","epoch":1,"seq":1,"traceId":null,"runId":"r","startedAt":1}"#,
      #"{"type":"turn_started","sessionId":"s1","epoch":1,"seq":2,"traceId":null,"turn":\#(turnJSON("t1", outcome: "running"))}"#,
      #"{"type":"step_added","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"turnId":"t1","step":\#(textStepJSON("0", "Hel"))}"#,
      #"{"type":"step_delta","sessionId":"s1","epoch":1,"seq":4,"traceId":null,"turnId":"t1","stepId":"0","delta":"lo"}"#,
      #"{"type":"step_added","sessionId":"s1","epoch":1,"seq":5,"traceId":null,"turnId":"t1","step":\#(toolStepJSON("1"))}"#,
      #"{"type":"step_updated","sessionId":"s1","epoch":1,"seq":6,"traceId":null,"turnId":"t1","step":\#(textStepJSON("1", "replaced"))}"#,
      #"{"type":"turn_finished","sessionId":"s1","epoch":1,"seq":7,"traceId":null,"turnId":"t1","outcome":"done","error":null,"durationMs":5,"usage":null,"changes":[]}"#,
      #"{"type":"run_settled","sessionId":"s1","epoch":1,"seq":8,"traceId":null,"runId":"r","outcome":"completed","settledAt":2}"#,
      #"{"type":"notice_added","sessionId":"s1","epoch":1,"seq":9,"traceId":null,"notice":\#(noticeJSON("n9")),"before":null}"#,
      #"{"type":"notice_added","sessionId":"s1","epoch":1,"seq":10,"traceId":null,"notice":\#(noticeJSON("n0")),"before":"t0"}"#,
    ]
    for (index, json) in events.enumerated() {
      #expect(state.apply(event(json)) == .applied, "event \(index + 1)")
      if index == 0 { #expect(state.running) }
    }

    #expect(state.seq == 10)
    #expect(!state.running)
    #expect(ids(state) == ["n0", "t0", "t1", "n9"])
    #expect(stepText(state, turn: 2, step: 0) == "Hello")
    #expect(stepText(state, turn: 2, step: 1) == "replaced")
    guard case .turn(let finished) = state.items[2] else {
      Issue.record("not a turn")
      return
    }
    #expect(finished.outcome == .done)
    #expect(finished.durationMs == 5)
  }

  @Test("marks the session exited when pi goes")
  func sessionExited() {
    var state = readyState(seq: 0, items: [])
    let exit =
      #"{"type":"session_exited","sessionId":"s1","epoch":1,"seq":1,"traceId":null,"reason":"crashed","code":1,"signal":null}"#
    #expect(state.apply(event(exit)) == .applied)
    #expect(state.status == .exited)
  }

  @Test("moves on past events that change nothing it shows")
  func others() {
    var state = readyState(seq: 0, items: [])
    let control =
      #"{"type":"control_updated","sessionId":"s1","epoch":1,"seq":1,"traceId":null,"control":\#(controlJSON)}"#
    let fast = #"{"type":"fast_updated","sessionId":"s1","epoch":1,"seq":2,"traceId":null,"fast":true}"#
    #expect(state.apply(event(control)) == .applied)
    #expect(state.apply(event(fast)) == .applied)
    #expect(state.seq == 2)
  }

  @Test(
    "asks for a resync on an event that does not follow on",
    arguments: [
      #"{"type":"fast_updated","sessionId":"s1","epoch":1,"seq":4,"traceId":null,"fast":true}"#,
      #"{"type":"fast_updated","sessionId":"s1","epoch":1,"seq":1,"traceId":null,"fast":true}"#,
      #"{"type":"fast_updated","sessionId":"s1","epoch":2,"seq":3,"traceId":null,"fast":true}"#,
      #"{"type":"step_added","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"turnId":"nope","step":{"kind":"text","id":"9","text":""}}"#,
      #"{"type":"step_added","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"turnId":"n1","step":{"kind":"text","id":"9","text":""}}"#,
      #"{"type":"step_delta","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"turnId":"t1","stepId":"9","delta":"x"}"#,
      #"{"type":"step_delta","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"turnId":"t1","stepId":"1","delta":"x"}"#,
      #"{"type":"step_updated","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"turnId":"t1","step":{"kind":"text","id":"9","text":""}}"#,
      #"{"type":"turn_finished","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"turnId":"nope","outcome":"done","error":null,"durationMs":1,"usage":null,"changes":[]}"#,
      #"{"type":"notice_added","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"notice":{"kind":"notice","id":"n","notice":"compacted","tokensBefore":1,"tokensAfter":null,"summary":"","timestamp":0},"before":"nope"}"#,
      #"{"type":"session_resumed","sessionId":"s1","epoch":1,"seq":3}"#,
      #"{"type":"session_resumed","sessionId":"s1","epoch":1,"seq":1}"#,
      #"{"type":"session_resumed","sessionId":"s1","epoch":2,"seq":2}"#,
    ])
  func resync(_ json: String) {
    var state = readyState(
      seq: 2, items: [noticeJSON("n1"), turnJSON("t1", steps: [textStepJSON("0", ""), toolStepJSON("1")])])
    let before = state
    #expect(state.apply(event(json)) == .resync)
    #expect(state == before)
  }

  @Test("takes a resumption at the position it has as nothing new, and ignores one before the first snapshot")
  func resumed() {
    var state = readyState(seq: 4, items: [turnJSON("t1")])
    let before = state
    #expect(state.apply(event(#"{"type":"session_resumed","sessionId":"s1","epoch":1,"seq":4}"#)) == .ignored)
    #expect(state == before)

    var loading = SessionState(sessionId: "s1")
    #expect(loading.apply(event(#"{"type":"session_resumed","sessionId":"s1","epoch":1,"seq":4}"#)) == .ignored)
    #expect(loading.status == .loading)
  }

  @Test("goes back to loading for a resync, keeping what it showed, and can fail with a code")
  func loadingAgain() {
    var state = readyState(seq: 2, items: [turnJSON("t1")])
    state.reload()
    #expect(state.status == .loading)
    #expect(ids(state) == ["t1"])
    #expect(
      state.apply(event(#"{"type":"fast_updated","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"fast":true}"#))
        == .ignored)

    state.fail(.sessionNotFound)
    #expect(state.status == .failed(.sessionNotFound))
  }
}

@Suite("Session state: resuming")
struct SessionStateResumeTests {
  @Test("has a resume point once it has a snapshot, and none before")
  func point() {
    #expect(SessionState(sessionId: "s1").resumePoint == nil)
    var state = readyState(seq: 4, items: [])
    #expect(state.resumePoint == ResumePoint(sessionId: "s1", stream: "st-1", epoch: 1, seq: 4))
    state.reload()
    #expect(state.resumePoint == nil)
  }

  @Test("keeps taking events while it resumes, and is settled at session_resumed of its position")
  func resumes() {
    var state = readyState(seq: 4, items: [])
    state.beginResume()
    #expect(!state.settled)
    let missed = #"{"type":"fast_updated","sessionId":"s1","epoch":1,"seq":5,"traceId":null,"fast":true}"#
    #expect(state.apply(event(missed)) == .applied)
    #expect(state.apply(event(#"{"type":"session_resumed","sessionId":"s1","epoch":1,"seq":5}"#)) == .applied)
    #expect(state.settled)
  }

  @Test("is settled by a snapshot instead, and cannot resume without a copy")
  func snapshotInstead() {
    var state = readyState(seq: 4, items: [])
    state.beginResume()
    _ = state.apply(event(snapshotJSON(epoch: 2, seq: 0)))
    #expect(state.settled)

    var empty = SessionState(sessionId: "s1")
    empty.beginResume()
    #expect(!empty.resuming)
  }
}

@Suite("Session state: run control")
struct SessionStateControlTests {
  /// The run control with one queued message, as JSON.
  static let queuedControlJSON = controlJSON.replacingOccurrences(
    of: #""queue":[]"#, with: #""queue":[{"id":"q1","text":"next","createdAt":5,"images":0}]"#)

  @Test("takes control, model, fast, metrics and the run from a snapshot")
  func fromSnapshot() {
    let json = snapshotJSON(seq: 2)
      .replacingOccurrences(of: controlJSON, with: Self.queuedControlJSON)
      .replacingOccurrences(of: #""run":null"#, with: #""run":{"runId":"run1","startedAt":40}"#)
      .replacingOccurrences(
        of: #""model":null,"fast":false"#,
        with: #""model":{"providerId":"openai","modelId":"gpt-6","thinkingLevel":"high"},"fast":true"#)
    var state = SessionState(sessionId: "s1")
    #expect(state.control == nil)
    #expect(state.apply(event(json)) == .applied)
    #expect(state.control?.queue.map(\.id) == ["q1"])
    #expect(state.model?.modelId == "gpt-6")
    #expect(state.fast)
    #expect(state.metrics?.branchTokens == 0)
    #expect(state.runStartedAt == 40)
    #expect(state.running)
  }

  @Test("follows control, model, fast, metrics and runs as they change")
  func updates() {
    var state = readyState(seq: 0, items: [])
    let control =
      #"{"type":"control_updated","sessionId":"s1","epoch":1,"seq":1,"traceId":null,"control":\#(Self.queuedControlJSON)}"#
    #expect(state.apply(event(control)) == .applied)
    #expect(state.control?.queue.count == 1)
    let model =
      #"{"type":"model_updated","sessionId":"s1","epoch":1,"seq":2,"traceId":null,"model":{"providerId":"openai","modelId":"gpt-6","thinkingLevel":"low"}}"#
    #expect(state.apply(event(model)) == .applied)
    #expect(state.model?.thinkingLevel == .low)
    #expect(
      state.apply(event(#"{"type":"fast_updated","sessionId":"s1","epoch":1,"seq":3,"traceId":null,"fast":true}"#))
        == .applied)
    #expect(state.fast)
    let metrics =
      #"{"type":"metrics_updated","sessionId":"s1","epoch":1,"seq":4,"traceId":null,"metrics":\#(metricsJSON.replacingOccurrences(of: #""branchTokens":0"#, with: #""branchTokens":7"#))}"#
    #expect(state.apply(event(metrics)) == .applied)
    #expect(state.metrics?.branchTokens == 7)
    #expect(
      state.apply(
        event(#"{"type":"run_started","sessionId":"s1","epoch":1,"seq":5,"traceId":null,"runId":"r","startedAt":90}"#))
        == .applied)
    #expect(state.runStartedAt == 90)
    #expect(
      state.apply(
        event(
          #"{"type":"run_settled","sessionId":"s1","epoch":1,"seq":6,"traceId":null,"runId":"r","outcome":"completed","settledAt":99}"#
        )) == .applied)
    #expect(state.runStartedAt == nil)
    #expect(!state.running)
  }

  @Test("keeps control, model, fast, metrics and the run in its cached copy")
  func cached() throws {
    let json = snapshotJSON(seq: 2).replacingOccurrences(of: controlJSON, with: Self.queuedControlJSON)
      .replacingOccurrences(of: #""run":null"#, with: #""run":{"runId":"run1","startedAt":40}"#)
    var state = SessionState(sessionId: "s1")
    _ = state.apply(event(json))
    let copy = try #require(state.cached)
    let restored = SessionState(cached: copy)
    #expect(restored.control == state.control)
    #expect(restored.metrics == state.metrics)
    #expect(restored.runStartedAt == 40)
    #expect(restored.running)
  }
}
