import AtriumProtocol
import AtriumSync
import Testing

/// A command step as JSON, cut to a preview or whole.
///
/// - Remark: Step `1` of turn `t1`.
/// - SideEffects: none
/// - Parameters:
///   - output: What it printed.
///   - partial: Whether this is a preview.
/// - Returns: The JSON.
func bashStepJSON(_ output: String, partial: Bool) -> String {
  #"{"kind":"tool","id":"1","callId":"c1","tool":"bash","args":{"command":"ls"},"status":"done","output":"\#(output)","details":{"tool":"bash","command":"ls"},"partial":\#(partial)}"#
}

/// A synced core whose open session `s1` has turn `t1` with a command step cut to a preview.
///
/// - Remark: The next request id is `r4`.
/// - SideEffects: none
/// - Returns: The core.
func partialCore() -> SyncCore {
  var sync = core()
  _ = sync.open("s1")
  _ = sync.connected(generation: 1)
  _ = receive(
    &sync, generation: 1, ok("r1"), indexSnapshotJSON(), ok("r2"), ok("r3"),
    snapshotJSON("s1", items: [turnJSON("t1", steps: [bashStepJSON("tail", partial: true)])]))
  return sync
}

/// The output of step `1` of turn `t1` of `s1`, and whether it is a preview.
///
/// - Remark: `nil` when the step is not there.
/// - SideEffects: none
/// - Parameter sync: The core.
/// - Returns: The output and the flag.
func stepOutput(_ sync: SyncCore) -> (String?, Bool)? {
  guard case .turn(let turn)? = sync.sessions["s1"]?.items.first, case .tool(let tool)? = turn.steps.first else {
    return nil
  }
  return (tool.output, tool.partial)
}

@Suite("Sync core: whole steps")
struct SyncStepTests {
  let ref = StepRef(sessionId: "s1", turnId: "t1", stepId: "1")

  @Test("fetches a step cut to a preview once, and puts the whole step in its place")
  func fetches() {
    var sync = partialCore()
    #expect(
      sync.fetchStep(ref) == [
        .send(
          .fetchStep(
            FetchStepCommand(
              requestId: "r4", traceparent: traceparent, sessionId: "s1", epoch: 1, turnId: "t1", stepId: "1")),
          generation: 1)
      ])
    #expect(sync.fetchingSteps == [ref])
    #expect(sync.fetchStep(ref) == [])
    _ = receive(
      &sync, generation: 1,
      #"{"type":"response","requestId":"r4","ok":true,"result":{"step":\#(bashStepJSON("whole", partial: false))}}"#)
    #expect(stepOutput(sync)?.0 == "whole")
    #expect(stepOutput(sync)?.1 == false)
    #expect(sync.fetchingSteps == [])
    #expect(sync.fetchStep(ref) == [])
  }

  @Test("a failure is remembered until the next try; a step from an older epoch is not put in")
  func failsAndDrops() {
    var sync = partialCore()
    _ = sync.fetchStep(ref)
    _ = receive(&sync, generation: 1, failed("r4", "transcript_changed"))
    #expect(sync.failedSteps == [ref])
    #expect(sync.fetchingSteps == [])
    #expect(sync.fetchStep(ref).count == 1)
    #expect(sync.failedSteps == [])
    _ = receive(
      &sync, generation: 1,
      snapshotJSON("s1", epoch: 2, items: [turnJSON("t1", steps: [bashStepJSON("tail", partial: true)])]))
    _ = receive(
      &sync, generation: 1,
      #"{"type":"response","requestId":"r5","ok":true,"result":{"step":\#(bashStepJSON("whole", partial: false))}}"#)
    #expect(stepOutput(sync)?.0 == "tail")
  }

  @Test("nothing goes for a whole step, an unknown one, or before the sync; a new connection or closing forgets")
  func guards() {
    var whole = core()
    _ = whole.open("s1")
    _ = whole.connected(generation: 1)
    _ = receive(
      &whole, generation: 1, ok("r1"), indexSnapshotJSON(), ok("r2"), ok("r3"),
      snapshotJSON("s1", items: [turnJSON("t1", steps: [bashStepJSON("all", partial: false)])]))
    #expect(whole.fetchStep(ref) == [])
    #expect(whole.fetchStep(StepRef(sessionId: "s1", turnId: "t9", stepId: "1")) == [])

    var notYet = core()
    _ = notYet.open("s1")
    #expect(notYet.fetchStep(ref) == [])

    var again = partialCore()
    _ = again.fetchStep(ref)
    _ = again.connected(generation: 2)
    #expect(again.fetchingSteps == [])

    var closed = partialCore()
    _ = closed.fetchStep(ref)
    _ = closed.close("s1")
    #expect(closed.fetchingSteps == [])
  }
}
