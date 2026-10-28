import AtriumProtocol
import AtriumSync
import Testing

/// The home list of a list snapshot.
///
/// - Remark: Built the way the app builds it, from an ``IndexState``.
/// - SideEffects: none
/// - Parameter json: An `index_snapshot`.
/// - Returns: The home list.
func home(_ json: String) -> HomeList {
  var state = IndexState()
  apply(&state, json)
  return HomeList(state)
}

@Suite("Home list")
struct HomeListTests {
  @Test("groups sessions by project and workspace, local workspace first, then worktrees newest first")
  func groups() {
    let list = home(
      indexSnapshotJSON(
        projects: [projectJSON("p1", name: "app"), projectJSON("p2", name: "site")],
        workspaces: [
          workspaceJSON("w-old", project: "p1", branch: "old"),
          workspaceJSON("w-local", project: "p1"),
          workspaceJSON("w-new", project: "p1", branch: "feature", alias: "侧栏"),
        ].map { $0.replacingOccurrences(of: #""createdAt":null"#, with: createdAt(of: $0)) },
        sessions: [
          summaryJSON("s1", in: "w-local", name: "旧的", extra: ["updatedAt": "1"]),
          summaryJSON("s2", in: "w-local", prompt: "新的", extra: ["updatedAt": "5"]),
          summaryJSON("s3", in: "w-new", extra: ["state": "\"draft\""]),
          summaryJSON("s4", in: "w-old", extra: ["state": "\"persisted\""]),
          summaryJSON("s5", in: "w-local", name: "归档", extra: ["archived": "true"]),
          summaryJSON("s6", in: "w-local", name: "子对话", extra: ["parent": #"{"sessionId":"s1","by":"user"}"#]),
        ]))

    #expect(list.projects.map(\.name) == ["app", "site"])
    let app = list.projects[0]
    #expect(app.workspaces.map(\.name) == ["w-local", "侧栏", "old"])
    #expect(app.workspaces[0].rows.map(\.id) == ["s2", "s1"])
    #expect(app.workspaces[0].rows.map(\.title) == ["新的", "旧的"])
    #expect(app.workspaces[1].rows.map(\.title) == ["新会话"])
    #expect(app.workspaces[2].rows.map(\.title) == ["图片"])
    #expect(list.projects[1].workspaces.isEmpty)
  }

  @Test("marks rows asking, failed or running, counts a project's runs, and leaves archived workspaces out")
  func statuses() {
    let list = home(
      indexSnapshotJSON(
        projects: [projectJSON("p1", name: "app")],
        workspaces: [
          workspaceJSON("w1", project: "p1"),
          workspaceJSON("w2", project: "p1", branch: "gone").replacingOccurrences(
            of: #""archivedAt":null"#, with: #""archivedAt":3"#),
        ],
        sessions: [
          summaryJSON("s1", in: "w1", name: "a", extra: ["asking": "4", "running": "true"]),
          summaryJSON("s2", in: "w1", name: "b", extra: ["attention": #"{"reason":"error","at":2,"cleared":false,"text":null}"#]),
          summaryJSON("s3", in: "w1", name: "c", extra: ["attention": #"{"reason":"error","at":2,"cleared":true,"text":null}"#]),
          summaryJSON("s4", in: "w1", name: "d", extra: ["running": "true"]),
          summaryJSON("s5", in: "w2", name: "e", extra: ["running": "true"]),
        ]))

    let rows = list.projects[0].workspaces.flatMap(\.rows)
    #expect(list.projects[0].workspaces.map(\.id) == ["w1"])
    #expect(rows.map(\.id) == ["s1", "s2", "s3", "s4"])
    #expect(rows.map(\.status) == [.asking, .error, nil, .running])
    #expect(list.projects[0].running == 2)
  }

  @Test("puts what waits for you first, asking before signing in before errors, newest first, with where it is")
  func inbox() {
    let list = home(
      indexSnapshotJSON(
        projects: [projectJSON("p1", name: "app")], workspaces: [workspaceJSON("w1", project: "p1", branch: "main")],
        chats: [chatJSON("cht_1")],
        sessions: [
          summaryJSON("s1", in: "w1", name: "旧错", extra: ["attention": #"{"reason":"error","at":1,"cleared":false,"text":null}"#]),
          summaryJSON("s2", in: "w1", name: "新错", extra: ["attention": #"{"reason":"error","at":9,"cleared":false,"text":null}"#]),
          summaryJSON("s3", in: "w1", name: "登录", extra: ["attention": #"{"reason":"auth","at":1,"cleared":true,"text":null}"#]),
          summaryJSON("s4", in: "cht_1", name: "问", extra: ["asking": "2"]),
          summaryJSON("s5", in: "w1", name: "看过", extra: ["attention": #"{"reason":"error","at":5,"cleared":true,"text":null}"#]),
          summaryJSON("s6", in: "w1", name: "归档", extra: ["asking": "3", "archived": "true"]),
        ]))

    #expect(list.inbox.map(\.id) == ["s4", "s3", "s2", "s1"])
    #expect(list.inbox.map(\.detail) == ["在问你 · 对话 · 新对话", "出错 · app · main", "出错 · app · main", "出错 · app · main"])
    #expect(list.inbox.map(\.status) == [.asking, .error, .error, .error])
  }

  @Test("lists the sessions of chats last, newest first, without archived chats")
  func chats() {
    let list = home(
      indexSnapshotJSON(
        chats: [
          chatJSON("cht_1"),
          chatJSON("cht_2").replacingOccurrences(of: #""archivedAt":null"#, with: #""archivedAt":3"#),
        ],
        sessions: [
          summaryJSON("s1", in: "cht_1", name: "早", extra: ["updatedAt": "1"]),
          summaryJSON("s2", in: "cht_1", name: "晚", extra: ["updatedAt": "2"]),
          summaryJSON("s3", in: "cht_2", name: "归档的对话"),
        ]))

    #expect(list.chats.map(\.id) == ["s2", "s1"])
    #expect(list.projects.isEmpty)
    #expect(list.isEmpty == false)
    #expect(home(indexSnapshotJSON()).isEmpty)
  }
}

/// A creation time for a workspace by its branch, so the test's order is clear.
///
/// - Remark: "old" is older than "feature".
/// - SideEffects: none
/// - Parameter json: The workspace.
/// - Returns: The `createdAt` field.
private func createdAt(of json: String) -> String {
  json.contains(#""branch":"old""#) ? #""createdAt":1"# : #""createdAt":2"#
}

@Suite("Home list: children")
struct HomeChildrenTests {
  @Test("lists a session's child conversations, the latest updated first, and not archived ones")
  func children() {
    var state = IndexState()
    let parent = #"{"sessionId":"p","by":"agent"}"#
    apply(
      &state,
      indexSnapshotJSON(sessions: [
        summaryJSON("p", in: "w1"),
        summaryJSON("c1", in: "w1", extra: ["parent": parent, "updatedAt": "2"]),
        summaryJSON("c2", in: "w1", extra: ["parent": parent, "updatedAt": "9"]),
        summaryJSON("c3", in: "w1", extra: ["parent": parent, "archived": "true"]),
        summaryJSON("x", in: "w1", extra: ["parent": #"{"sessionId":"other","by":"user"}"#]),
      ]))
    #expect(HomeList.children(of: "p", in: state).map(\.sessionId) == ["c2", "c1"])
    #expect(HomeList.children(of: "c1", in: state).isEmpty)
  }
}

@Suite("Home list: full layout")
struct HomeLayoutTests {
  /// A list with one workspace of five sessions in different states.
  static let busy = indexSnapshotJSON(
    projects: [projectJSON("p1", name: "weather-app")],
    workspaces: [workspaceJSON("w1", project: "p1", branch: "fix/cache")],
    sessions: [
      summaryJSON("s1", in: "w1", name: "old", extra: ["updatedAt": "1"]),
      summaryJSON("s2", in: "w1", name: "new", extra: ["updatedAt": "9"]),
      summaryJSON("s3", in: "w1", name: "run", extra: ["updatedAt": "2", "running": "true"]),
      summaryJSON("s4", in: "w1", name: "ask", extra: ["updatedAt": "3", "asking": "5"]),
      summaryJSON(
        "s5", in: "w1", name: "err",
        extra: ["updatedAt": "4", "attention": #"{"reason":"error","at":1,"cleared":false,"text":null}"#]),
    ])

  @Test("shows three sessions a workspace, asking before errors before running before the rest, and how many more")
  func three() {
    let workspace = home(Self.busy).projects[0].workspaces[0]
    #expect(workspace.shown.map(\.id) == ["s4", "s5", "s3"])
    #expect(workspace.more == 2)
    #expect(workspace.rows.count == 5)
    #expect(workspace.kind == .worktree)
    #expect(!workspace.merged)
  }

  @Test("marks a merged workspace")
  func merged() {
    let json = indexSnapshotJSON(
      projects: [projectJSON("p1", name: "p")],
      workspaces: [
        workspaceJSON("w1", project: "p1", branch: "done").replacingOccurrences(
          of: #""merge":null"#, with: #""merge":{"dirty":false,"ahead":0,"verdict":"merged","reason":null}"#)
      ])
    #expect(home(json).projects[0].workspaces[0].merged)
  }

  @Test("shows at most five chats and how many there are")
  func chats() {
    let chats = (0..<7).map { chatJSON("c\($0)") }
    let sessions = (0..<7).map { summaryJSON("t\($0)", in: "c\($0)", extra: ["updatedAt": "\($0)"]) }
    let list = home(indexSnapshotJSON(chats: chats, sessions: sessions))
    #expect(list.chats.count == 7)
    #expect(list.shownChats.map(\.id) == ["t6", "t5", "t4", "t3", "t2"])
  }

  @Test("knows where the latest session is, for a new session to start there")
  func recent() {
    var state = IndexState()
    apply(&state, Self.busy)
    #expect(HomeList.recentContainer(in: state) == "w1")
    #expect(HomeList.recentContainer(in: IndexState()) == nil)
    var two = IndexState()
    apply(
      &two,
      indexSnapshotJSON(
        workspaces: [workspaceJSON("w1", project: "p1"), workspaceJSON("w2", project: "p1", branch: "b")],
        sessions: [
          summaryJSON("a", in: "w2", extra: ["updatedAt": "1"]), summaryJSON("b", in: "w1", extra: ["updatedAt": "9"]),
          summaryJSON("c", in: "w2", extra: ["updatedAt": "20", "archived": "true"]),
        ]))
    #expect(HomeList.recentContainer(in: two) == "w1")
  }

  @Test("lists the three workspaces worked in last, each once, leaving chats and merged ones out")
  func recentWorkspaces() {
    var state = IndexState()
    apply(
      &state,
      indexSnapshotJSON(
        workspaces: (1...5).map { workspaceJSON("w\($0)", project: "p1", branch: "b\($0)") }
          + [
            workspaceJSON("w6", project: "p1", branch: "done").replacingOccurrences(
              of: #""merge":null"#, with: #""merge":{"dirty":false,"ahead":0,"verdict":"merged","reason":null}"#)
          ],
        chats: [chatJSON("c1")],
        sessions: [
          summaryJSON("a", in: "w1", extra: ["updatedAt": "1"]), summaryJSON("b", in: "w2", extra: ["updatedAt": "5"]),
          summaryJSON("c", in: "w2", extra: ["updatedAt": "6"]), summaryJSON("d", in: "c1", extra: ["updatedAt": "9"]),
          summaryJSON("e", in: "w6", extra: ["updatedAt": "8"]), summaryJSON("f", in: "w3", extra: ["updatedAt": "4"]),
          summaryJSON("g", in: "w4", extra: ["updatedAt": "3"]), summaryJSON("h", in: "w5", extra: ["updatedAt": "2"]),
          summaryJSON("i", in: "w5", extra: ["updatedAt": "7", "archived": "true"]),
        ]))
    #expect(HomeList.recentWorkspaces(in: state) == ["w2", "w3", "w4"])
    #expect(HomeList.recentWorkspaces(in: IndexState()).isEmpty)
    // The latest session is in a chat, so the home's "+" starts a new chat.
    #expect(HomeList.newSessionPlace(in: state) == nil)
    var worked = IndexState()
    apply(
      &worked,
      indexSnapshotJSON(
        workspaces: [workspaceJSON("w1", project: "p1"), workspaceJSON("w2", project: "p1", branch: "b")],
        chats: [chatJSON("c1")],
        sessions: [
          summaryJSON("a", in: "c1", extra: ["updatedAt": "1"]), summaryJSON("b", in: "w2", extra: ["updatedAt": "5"]),
          summaryJSON("c", in: "w1", extra: ["updatedAt": "9", "archived": "true"]),
        ]))
    #expect(HomeList.newSessionPlace(in: worked) == "w2")
    #expect(HomeList.newSessionPlace(in: IndexState()) == nil)
  }
}
