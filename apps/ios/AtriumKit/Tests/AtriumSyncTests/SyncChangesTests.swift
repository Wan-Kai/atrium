import AtriumProtocol
import AtriumSync
import Testing

/// A `changes_updated` of a workspace, as JSON.
///
/// - Remark: Two files' worth of lines.
/// - SideEffects: none
/// - Parameters:
///   - workspace: The workspace.
///   - added: Lines added.
/// - Returns: The JSON.
func changesJSON(_ workspace: String, added: Int = 9) -> String {
  #"{"type":"changes_updated","workspaceId":"\#(workspace)","stat":{"added":\#(added),"removed":4},"dirty":true,"ahead":3,"branch":"fix","base":"origin/main"}"#
}

/// A `diff_updated` with one modified file, as JSON.
///
/// - Remark: One hunk of one added line.
/// - SideEffects: none
/// - Parameters:
///   - workspace: The workspace.
///   - mode: `uncommitted` or `base`.
/// - Returns: The JSON.
func diffJSON(_ workspace: String, mode: String = "uncommitted") -> String {
  let hunk =
    #"{"oldStart":1,"oldCount":1,"newStart":1,"newCount":2,"lines":[{"kind":"add","oldNumber":null,"newNumber":2,"text":"x"}]}"#
  return
    #"{"type":"diff_updated","workspaceId":"\#(workspace)","mode":"\#(mode)","files":[{"path":"a.ts","oldPath":null,"status":"modified","added":1,"removed":0,"content":"text","hunks":[\#(hunk)]}],"tooLarge":false,"error":null}"#
}

/// `watch_changes` as the core sends it.
///
/// - Remark: The whole set each time.
/// - SideEffects: none
/// - Parameters:
///   - id: Its request id.
///   - workspaces: The workspaces.
/// - Returns: The command.
func watchChanges(_ id: String, _ workspaces: [String]) -> Command {
  .watchChanges(WatchChangesCommand(requestId: id, traceparent: traceparent, workspaceIds: workspaces))
}

/// `watch_diff` as the core sends it.
///
/// - Remark: `nil` closes it.
/// - SideEffects: none
/// - Parameters:
///   - id: Its request id.
///   - workspace: The workspace, or `nil`.
///   - mode: The mode.
/// - Returns: The command.
func watchDiff(_ id: String, _ workspace: String?, mode: DiffMode = .uncommitted) -> Command {
  .watchDiff(
    WatchDiffCommand(
      requestId: id, traceparent: traceparent, target: workspace.map { DiffTarget(workspaceId: $0, mode: mode) }))
}

@Suite("Sync core: changes and diffs")
struct SyncChangesTests {
  @Test("watches the changes of the workspaces shown, keeps what comes for them, and watches again after a reconnect")
  func changes() {
    var sync = syncedCore()
    #expect(sync.watchChanges(["w1", "w2"]) == [.send(watchChanges("r4", ["w1", "w2"]), generation: 1)])
    #expect(sync.watchChanges(["w2", "w1"]) == [])
    _ = receive(&sync, generation: 1, changesJSON("w1"), changesJSON("w9"))
    #expect(sync.changes["w1"]?.stat?.added == 9)
    #expect(sync.changes["w9"] == nil)
    let outputs = sync.connected(generation: 2)
    #expect(outputs.contains(.send(watchChanges("r8", ["w1", "w2"]), generation: 2)))
  }

  @Test("watches one diff at a time, keeps only the one asked for, and closes it")
  func diff() {
    var sync = syncedCore()
    #expect(
      sync.watchDiff(DiffTarget(workspaceId: "w1", mode: .uncommitted)) == [.send(watchDiff("r4", "w1"), generation: 1)]
    )
    _ = receive(&sync, generation: 1, diffJSON("w1", mode: "base"), diffJSON("w2"))
    #expect(sync.diff == nil)
    _ = receive(&sync, generation: 1, diffJSON("w1"))
    #expect(sync.diff?.files.map(\.path) == ["a.ts"])
    #expect(
      sync.watchDiff(DiffTarget(workspaceId: "w1", mode: .base)) == [
        .send(watchDiff("r5", "w1", mode: .base), generation: 1)
      ])
    #expect(sync.diff == nil)
    #expect(sync.watchDiff(nil) == [.send(watchDiff("r6", nil), generation: 1)])
    #expect(sync.diffTarget == nil)
  }

  @Test("opens the diff again on a new connection, and sends nothing without one")
  func diffReconnect() {
    var sync = core()
    #expect(sync.watchDiff(DiffTarget(workspaceId: "w1", mode: .uncommitted)) == [])
    #expect(sync.watchChanges(["w1"]) == [])
    let outputs = sync.connected(generation: 1)
    #expect(outputs.contains(.send(watchDiff("r2", "w1"), generation: 1)))
    #expect(outputs.contains(.send(watchChanges("r3", ["w1"]), generation: 1)))
  }
}
