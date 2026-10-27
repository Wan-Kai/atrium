import AtriumProtocol
import AtriumSync
import Testing

/// Applies one list message to a state.
///
/// - Remark: Only list messages; anything else is a broken test.
/// - SideEffects: none
/// - Parameters:
///   - state: The state, changed in place.
///   - json: An `index_snapshot` or `index_changes`.
func apply(_ state: inout IndexState, _ json: String) {
  switch host(json) {
  case .indexSnapshot(let snapshot): state.apply(snapshot)
  case .indexChanges(let changes): state.apply(changes)
  default: fatalError("not a list message: \(json)")
  }
}

@Suite("Index state")
struct IndexStateTests {
  @Test("has nothing until the first snapshot, then takes it whole")
  func snapshot() {
    var state = IndexState()
    #expect(!state.ready)

    apply(
      &state,
      indexSnapshotJSON(
        generation: "h1", seq: 4, projects: [projectJSON("p1", name: "app")],
        workspaces: [workspaceJSON("w1", project: "p1")], chats: [chatJSON("c1")],
        sessions: [summaryJSON("s1", in: "w1")]))

    #expect(state.ready)
    #expect(state.generation == "h1")
    #expect(state.seq == 4)
    #expect(state.projects.map(\.id) == ["p1"])
    #expect(state.workspaces.map(\.id) == ["w1"])
    #expect(state.chats.map(\.id) == ["c1"])
    #expect(state.sessions.map(\.sessionId) == ["s1"])

    apply(&state, indexSnapshotJSON(generation: "h2", seq: 0))
    #expect(state.generation == "h2")
    #expect(state.seq == 0)
    #expect(state.projects.isEmpty && state.workspaces.isEmpty && state.chats.isEmpty && state.sessions.isEmpty)
  }

  @Test("keeps a changed item where it is, puts a new one at the end and drops one that went")
  func changes() {
    var state = IndexState()
    apply(
      &state,
      indexSnapshotJSON(
        sessions: [summaryJSON("s1", in: "w1"), summaryJSON("s2", in: "w1"), summaryJSON("s3", in: "w1")]))

    apply(
      &state,
      indexChangesJSON(
        seq: 1, sessions: [summaryJSON("s4", in: "w1"), summaryJSON("s2", in: "w1", name: "改名")], removed: ["s3"],
        projects: [projectJSON("p1", name: "app")]))

    #expect(state.seq == 1)
    #expect(state.sessions.map(\.sessionId) == ["s1", "s2", "s4"])
    #expect(state.sessions[1].name == "改名")
    #expect(state.projects.map(\.id) == ["p1"])
  }

  @Test("ignores changes before the first snapshot, and changes of another host instance")
  func ignored() {
    var state = IndexState()
    apply(&state, indexChangesJSON(seq: 1, sessions: [summaryJSON("s1", in: "w1")]))
    #expect(state == IndexState())

    apply(&state, indexSnapshotJSON(generation: "h1", seq: 3))
    let before = state
    apply(&state, indexChangesJSON(generation: "h0", seq: 4, sessions: [summaryJSON("s1", in: "w1")]))
    #expect(state == before)
  }
}
