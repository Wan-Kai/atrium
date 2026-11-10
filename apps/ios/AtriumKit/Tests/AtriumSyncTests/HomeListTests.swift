import AtriumProtocol
import AtriumSync
import Foundation
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
          summaryJSON(
            "s2", in: "w1", name: "b", extra: ["attention": #"{"reason":"error","at":2,"cleared":false,"text":null}"#]),
          summaryJSON(
            "s3", in: "w1", name: "c", extra: ["attention": #"{"reason":"error","at":2,"cleared":true,"text":null}"#]),
          summaryJSON("s4", in: "w1", name: "d", extra: ["running": "true"]),
          summaryJSON("s5", in: "w2", name: "e", extra: ["running": "true"]),
        ]))

    let rows = list.projects[0].workspaces.flatMap(\.rows)
    #expect(list.projects[0].workspaces.map(\.id) == ["w1"])
    #expect(rows.map(\.id) == ["s1", "s2", "s3", "s4"])
    #expect(rows.map(\.status) == [.asking, .error, nil, .running])
    #expect(list.projects[0].running == 2)
  }

  @Test("makes a note of each thing waiting on you: stuck before waiting, newest first, named by its own words")
  func notes() {
    let list = home(
      indexSnapshotJSON(
        projects: [projectJSON("p1", name: "app")], workspaces: [workspaceJSON("w1", project: "p1", branch: "main")],
        chats: [chatJSON("cht_1")],
        sessions: [
          summaryJSON(
            "s1", in: "w1", name: "旧错",
            extra: ["attention": #"{"reason":"error","at":1,"cleared":false,"text":"TypeError: x\nat y"}"#]),
          summaryJSON(
            "s2", in: "w1", name: "新错", extra: ["attention": #"{"reason":"error","at":9,"cleared":false,"text":null}"#]),
          summaryJSON(
            "s3", in: "w1", name: "登录", extra: ["attention": #"{"reason":"auth","at":1,"cleared":true,"text":null}"#]),
          summaryJSON(
            "s4", in: "cht_1", name: "问",
            extra: ["asking": "2", "question": #"{"title":"回调用哪个？","detail":"两个都能跑通"}"#]),
          summaryJSON(
            "s5", in: "w1", name: "看过", extra: ["attention": #"{"reason":"error","at":5,"cleared":true,"text":null}"#]),
          summaryJSON("s6", in: "w1", name: "归档", extra: ["asking": "3", "archived": "true"]),
          summaryJSON("s7", in: "w1", name: "没说问什么", extra: ["asking": "4"]),
        ]))

    #expect(list.notes.map(\.id) == ["s2", "s1", "s3", "s7", "s4"])
    #expect(list.notes.map(\.level) == [.stuck, .stuck, .stuck, .waiting, .waiting])
    #expect(list.notes.map(\.title) == ["新错", "TypeError: x", "登录", "没说问什么", "回调用哪个？"])
    #expect(list.notes.map(\.body) == [nil, "at y", nil, nil, "两个都能跑通"])
    #expect(list.notes.map(\.code) == [false, true, false, false, false])
    #expect(list.notes.map(\.place) == ["app · main", "app · main", "app · main", "app · main", "对话 · 新对话"])
    #expect(list.notes.map(\.since) == [9, 1, 1, 4, 2])
  }

  @Test("shows eight notes and counts the rest for the pile")
  func notePile() {
    let list = home(
      indexSnapshotJSON(
        chats: [chatJSON("cht_1")],
        sessions: (1...10).map { summaryJSON("s\($0)", in: "cht_1", name: "\($0)", extra: ["asking": "\($0)"]) }))

    #expect(list.shownNotes.map(\.id) == (3...10).reversed().map { "s\($0)" })
    #expect(list.pile == 2)
    #expect(home(indexSnapshotJSON()).pile == 0)
  }

  @Test("gives each open worktree one line, led by its most urgent session, and folds the merged ones")
  func worktreeLines() {
    let merged = workspaceJSON("w2", project: "p1", branch: "done").replacingOccurrences(
      of: #""merge":null"#, with: #""merge":{"dirty":false,"ahead":0,"verdict":"merged","reason":null}"#)
    let list = home(
      indexSnapshotJSON(
        projects: [projectJSON("p1", name: "app")],
        workspaces: [
          workspaceJSON("w1", project: "p1", branch: "radar"), merged,
          workspaceJSON("w3", project: "p1", branch: "empty"),
        ],
        sessions: [
          summaryJSON("s1", in: "w1", name: "雷达", extra: ["running": "true", "updatedAt": "5"]),
          summaryJSON("s2", in: "w1", name: "b", extra: ["running": "true", "updatedAt": "3"]),
          summaryJSON("s3", in: "w1", name: "c", extra: ["running": "true", "updatedAt": "1"]),
          summaryJSON("s4", in: "w1", name: "空闲", extra: ["updatedAt": "9"]),
          summaryJSON("s5", in: "w2", name: "合了"),
        ]))

    let project = list.projects[0]
    #expect(project.lines.map(\.id) == ["w1", "w3"])
    #expect(project.lines[0].lead?.id == "s1")
    #expect(project.lines[0].lead?.updatedAt == 5)
    #expect(project.lines[0].alsoRunning == 2)
    #expect(project.lines[1].lead == nil)
    #expect(project.lines[1].alsoRunning == 0)
    #expect(project.merged == 1)
  }

  @Test("orders open worktrees by their latest activity, shows eight and counts the rest")
  func worktreeOrder() {
    let created = { (id: String, at: Int) in
      workspaceJSON(id, project: "p1", branch: id).replacingOccurrences(
        of: #""createdAt":null"#, with: #""createdAt":\#(at)"#)
    }
    // w1…w10 created in order; w3 and w7 have sessions, w7's the latest; the local w0 has one too.
    let list = home(
      indexSnapshotJSON(
        projects: [projectJSON("p1", name: "app")],
        workspaces: [workspaceJSON("w0", project: "p1")] + (1...10).map { created("w\($0)", $0) },
        sessions: [
          summaryJSON("s1", in: "w3", name: "a", extra: ["updatedAt": "50"]),
          summaryJSON("s2", in: "w7", name: "b", extra: ["updatedAt": "90"]),
          summaryJSON("s3", in: "w0", name: "c", extra: ["updatedAt": "40"]),
        ]))

    let project = list.projects[0]
    #expect(project.lines.map(\.id) == ["w7", "w3", "w0", "w10", "w9", "w8", "w6", "w5", "w4", "w2", "w1"])
    #expect(project.shownLines.map(\.id) == ["w7", "w3", "w0", "w10", "w9", "w8", "w6", "w5"])
    #expect(project.moreLines == 3)
    #expect(home(indexSnapshotJSON(projects: [projectJSON("p1", name: "app")])).projects[0].moreLines == 0)
  }

  @Test("lists one ring place a project, at its latest open workspace, the latest project first")
  func ringPlaces() {
    let created = { (id: String, project: String, at: Int) in
      workspaceJSON(id, project: project, branch: id).replacingOccurrences(
        of: #""createdAt":null"#, with: #""createdAt":\#(at)"#)
    }
    // p1's latest open workspace is w2 (its session at 70); p2's is w3 (made at 80, no sessions);
    // p3 has only a merged workspace, so it is not a place.
    let merged = created("w4", "p3", 99).replacingOccurrences(
      of: #""merge":null"#, with: #""merge":{"dirty":false,"ahead":0,"verdict":"merged","reason":null}"#)
    let list = home(
      indexSnapshotJSON(
        projects: [projectJSON("p1", name: "app"), projectJSON("p2", name: "blog"), projectJSON("p3", name: "old")],
        workspaces: [created("w1", "p1", 10), created("w2", "p1", 20), created("w3", "p2", 80), merged],
        sessions: [summaryJSON("s1", in: "w2", name: "a", extra: ["updatedAt": "70", "running": "true"])]))

    let places = HomeList.ringPlaces(list.projects)
    #expect(places.map(\.name) == ["blog", "app"])
    #expect(places.map(\.workspace) == ["w3", "w2"])
    #expect(places.map(\.running) == [0, 1])
  }

  @Test(
    "says how long ago in the phone's short words",
    arguments: [
      (30_000, "刚刚"), (6 * 60_000, "6 分钟"), (2 * 3_600_000, "2 小时"), (20 * 3_600_000, "昨天"),
      (3 * 86_400_000, "周日"), (10 * 86_400_000, "10月18日"),
    ])
  func ago(_ back: Int, _ words: String) {
    // 2026-10-28 12:00 in Shanghai, a Wednesday.
    let now = 1_793_160_000_000
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
    #expect(HomeList.ago(now - back, now: now, calendar: calendar) == words)
  }

  @Test("lists a session's worktree's own conversations for settings, newest first, without children or archived ones")
  func siblings() {
    var state = IndexState()
    apply(
      &state,
      indexSnapshotJSON(
        projects: [projectJSON("p1", name: "app")],
        workspaces: [workspaceJSON("w1", project: "p1"), workspaceJSON("w2", project: "p1", branch: "b")],
        sessions: [
          summaryJSON("s1", in: "w1", name: "a", extra: ["updatedAt": "1"]),
          summaryJSON("s2", in: "w1", name: "b", extra: ["updatedAt": "5"]),
          summaryJSON("s3", in: "w1", name: "子", extra: ["parent": #"{"sessionId":"s1","by":"user"}"#]),
          summaryJSON("s4", in: "w1", name: "旧", extra: ["archived": "true"]),
          summaryJSON("s5", in: "w2", name: "别处"),
        ]))

    #expect(HomeList.siblings(of: "s1", in: state).map(\.sessionId) == ["s2", "s1"])
    #expect(HomeList.siblings(of: "s3", in: state).map(\.sessionId) == ["s2", "s1"])
    #expect(HomeList.siblings(of: "nope", in: state).isEmpty)
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

  @Test("puts a pinned chat's sessions first and marks them, then the ones a run marks, then the rest")
  func pinnedChats() {
    let list = home(
      indexSnapshotJSON(
        chats: [chatJSON("cht_pinned", pinnedAt: 9), chatJSON("cht_idle"), chatJSON("cht_busy")],
        sessions: [
          summaryJSON("s1", in: "cht_idle", name: "最新的", extra: ["updatedAt": "9"]),
          summaryJSON("s2", in: "cht_pinned", name: "钉住的", extra: ["updatedAt": "2"]),
          summaryJSON("s3", in: "cht_busy", name: "在跑", extra: ["updatedAt": "3", "running": "true"]),
        ]))

    #expect(list.chats.map(\.id) == ["s2", "s3", "s1"])
    #expect(list.chats.map(\.pinned) == [true, false, false])
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
