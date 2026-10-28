import AtriumProtocol
import Foundation

/// What the home screen lists, worked out from the list.
///
/// - Remark: The paper redesign (SPEC-0005 "界面", 2026-10-28; design-language "手机端 · 首页"):
///   "等你处理" is a strip of notes, one a thing, stuck before waiting; each project lists one line a
///   worktree, led by its most urgent session, the merged ones folded into a count. Before it,
///   SPEC-0005 "MP4a 定的细节 · 界面": "等你处理" first, then each project's workspaces
///   with their sessions, then the sessions of chats. The rules follow the desktop's sidebar
///   (`packages/ui/src/sidebar/names.ts`, `status.ts`): the inbox picks and orders as `inboxOf`,
///   workspaces are named and ordered as `workspaceName` and `sortWorkspaces`, sessions are titled
///   as `sessionTitle`. Archived sessions, archived workspaces and chats, and child conversations
///   are left out of the groups. MP6 (SPEC-0005 "MP6 定的细节 · MP6b") shows three sessions a
///   workspace, asking first, then errors, then running, then the newest, with "还有 N 个", and at
///   most five chats with "显示全部 N 个".
public struct HomeList: Sendable, Equatable {
  /// How a row is marked.
  ///
  /// - Remark: The marks of design-language "会话状态" the MP4a rows use.
  public enum Status: Sendable, Equatable {
    /// An agent's question or a dialog waits for an answer.
    case asking
    /// The last run failed, or a sign-in is needed.
    case error
    /// A run is in progress.
    case running
  }

  /// One session's row.
  ///
  /// - Remark: Identified by its session, so a row keeps its place as the list changes.
  public struct Row: Sendable, Equatable, Identifiable {
    /// The session.
    public let id: SessionId
    /// Its title.
    public let title: String
    /// The second line: "状态 · 项目 · 工作区" in the inbox, nothing elsewhere.
    public let detail: String?
    /// Its mark, if any.
    public let status: Status?
    /// When it last changed, for the time at the end of a worktree's line.
    public let updatedAt: Int
  }

  /// How urgent a note is, which its paper's colour shows (design-language "手机端 · 首页").
  public enum NoteLevel: Sendable, Equatable {
    /// Stuck: a run failed, or a sign-in is needed.
    case stuck
    /// Waiting on you: a question or a dialog.
    case waiting
    /// A reminder; nothing makes one yet (later: to-dos, the inbox).
    case reminder
  }

  /// One note in "等你处理": one thing waiting on you.
  ///
  /// - Remark: Named by the thing's own words where the host sends them (SPEC-0005 "协议改动" 6): a
  ///   failure's first line and the rest, or the question's title and detail; without them, the
  ///   session's title. Identified by its session, which also seeds the note's tilt.
  public struct Note: Sendable, Equatable, Identifiable {
    /// The session.
    public let id: SessionId
    /// How urgent it is.
    public let level: NoteLevel
    /// The bold lines.
    public let title: String
    /// The smaller lines under it, if any.
    public let body: String?
    /// Whether the body is pi's error text, set in mono.
    public let code: Bool
    /// "项目 · 分支", or "对话 · 名字".
    public let place: String
    /// Since when it waits, in milliseconds since the epoch.
    public let since: Int
  }

  /// One worktree's line under its project.
  ///
  /// - Remark: The branch and its tag, then the session that matters most in it (asking, errors,
  ///   running, then the newest), "等 N 个在跑" for the others running, and the time.
  public struct WorktreeLine: Sendable, Equatable, Identifiable {
    /// The workspace.
    public let id: WorkspaceId
    /// Its name: the alias, the branch, or the folder.
    public let name: String
    /// The local checkout or a worktree.
    public let kind: Workspace.Kind
    /// The session leading the line; `nil` for a workspace without one.
    public let lead: Row?
    /// How many other sessions in it run.
    public let alsoRunning: Int
  }

  /// A workspace and its sessions.
  ///
  /// - Remark: Shown under a small title, its name.
  public struct WorkspaceGroup: Sendable, Equatable, Identifiable {
    /// The workspace.
    public let id: WorkspaceId
    /// Its name.
    public let name: String
    /// Its sessions, newest first.
    public let rows: [Row]
    /// The local checkout or a worktree.
    public let kind: Workspace.Kind
    /// Whether its branch was merged.
    public let merged: Bool
    /// The sessions the home shows: at most three, the ones waiting for you first.
    public var shown: [Row] { Array(HomeList.byUrgency(rows).prefix(HomeList.perWorkspace)) }
    /// How many more it has, for "还有 N 个".
    public var more: Int { max(0, rows.count - HomeList.perWorkspace) }
  }

  /// The most sessions a workspace shows on the home.
  public static let perWorkspace = 3
  /// The most chats the home shows.
  public static let chatsShown = 5

  /// A project and its workspaces.
  ///
  /// - Remark: Shown under a serif chapter title, its name.
  public struct ProjectGroup: Sendable, Equatable, Identifiable {
    /// The project.
    public let id: ProjectId
    /// Its name.
    public let name: String
    /// How many of its listed sessions run, whatever else they wait for, for "N 在跑".
    public let running: Int
    /// Its workspaces, in the sidebar's order.
    public let workspaces: [WorkspaceGroup]
    /// One line a workspace not merged, in the same order.
    public var lines: [WorktreeLine] { workspaces.filter { !$0.merged }.map(HomeList.line) }
    /// The merged workspaces' lines, shown when "另外 N 个已合并" is opened.
    public var mergedLines: [WorktreeLine] { workspaces.filter(\.merged).map(HomeList.line) }
    /// How many of its workspaces were merged, for "另外 N 个已合并".
    public var merged: Int { workspaces.filter(\.merged).count }
  }

  /// A workspace's line: its most urgent session and how many others run.
  ///
  /// - Remark: See `WorktreeLine`.
  /// - SideEffects: none
  /// - Parameter group: The workspace and its sessions.
  /// - Returns: The line.
  static func line(_ group: WorkspaceGroup) -> WorktreeLine {
    let lead = byUrgency(group.rows).first
    let running = group.rows.filter { $0.status == .running && $0.id != lead?.id }.count
    return WorktreeLine(id: group.id, name: group.name, kind: group.kind, lead: lead, alsoRunning: running)
  }

  /// The most notes the strip shows before the pile.
  public static let notesShown = 8

  /// What waits on you, as notes, in order.
  public let notes: [Note]
  /// The notes the strip shows.
  public var shownNotes: [Note] { Array(notes.prefix(Self.notesShown)) }
  /// How many more there are, for the pile "还有 N 件"; 0 for no pile.
  public var pile: Int { max(0, notes.count - Self.notesShown) }
  /// The projects, in the host's order.
  public let projects: [ProjectGroup]
  /// The sessions of chats, newest first.
  public let chats: [Row]
  /// The chats the home shows, before "显示全部 N 个".
  public var shownChats: [Row] { Array(chats.prefix(Self.chatsShown)) }

  /// Whether there is nothing to list at all.
  public var isEmpty: Bool { notes.isEmpty && projects.isEmpty && chats.isEmpty }

  /// Works the home list out from the list.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter index: The list.
  public init(_ index: IndexState) {
    let listed = index.sessions.filter { !$0.archived && $0.parent == nil }
    let liveChats = Set(index.chats.filter { $0.archivedAt == nil }.map(\.id))
    notes = Self.notes(index)
    projects = index.projects.map { project in
      let workspaces = Self.sorted(index.workspaces.filter { $0.projectId == project.id && $0.archivedAt == nil })
      let sessions = workspaces.map { workspace in Self.newestFirst(listed.filter { $0.containerId == workspace.id }) }
      let groups = zip(workspaces, sessions).map { workspace, sessions in
        WorkspaceGroup(
          id: workspace.id, name: Self.name(of: workspace), rows: sessions.map(Self.row), kind: workspace.kind,
          merged: workspace.merge?.verdict == .merged)
      }
      return ProjectGroup(
        id: project.id, name: project.name, running: sessions.joined().filter(\.running).count, workspaces: groups)
    }
    chats = Self.newestFirst(listed.filter { liveChats.contains($0.containerId) }).map(Self.row)
  }

  /// The notes of what waits on you, in order.
  ///
  /// - Remark: Picked as the desktop's `inboxOf`: not archived; waiting for an answer, else with an
  ///   attention not seen yet (an error seen stays out, a sign-in stays in). Ordered by level (stuck,
  ///   then waiting), each newest first, as design-language "手机端 · 首页" orders the notes.
  /// - SideEffects: none
  /// - Parameter index: The list.
  /// - Returns: The notes.
  private static func notes(_ index: IndexState) -> [Note] {
    let waiting: [Note] = index.sessions.compactMap { session in
      guard !session.archived else { return nil }
      let place = place(of: session.containerId, in: index)
      if let asking = session.asking {
        return Note(
          id: session.sessionId, level: .waiting, title: session.question?.title ?? title(of: session),
          body: session.question?.detail, code: false, place: place, since: asking)
      }
      guard let attention = session.attention, !(attention.reason == .error && attention.cleared) else { return nil }
      let (first, rest) = split(attention.text)
      return Note(
        id: session.sessionId, level: .stuck, title: first ?? title(of: session), body: rest, code: rest != nil,
        place: place, since: attention.at)
    }
    let rank = { (note: Note) -> Int in note.level == .stuck ? 0 : note.level == .waiting ? 1 : 2 }
    return stable(waiting) { a, b in rank(a) != rank(b) ? rank(a) < rank(b) : a.since > b.since }
  }

  /// A text's first line and the rest.
  ///
  /// - Remark: A failure's note shows its first line large and the rest in mono under it; an empty
  ///   text or rest counts as none.
  /// - SideEffects: none
  /// - Parameter text: The text, if any.
  /// - Returns: The first line and the rest, each `nil` when empty.
  private static func split(_ text: String?) -> (String?, String?) {
    guard let text, !text.isEmpty else { return (nil, nil) }
    let parts = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
    let rest = parts.count > 1 ? parts[1] : ""
    return (parts[0].isEmpty ? nil : parts[0], rest.isEmpty ? nil : rest)
  }

  /// How long ago a moment was, in the phone's short words.
  ///
  /// - Remark: The prototype's times: "刚刚" under a minute, "N 分钟", "N 小时" the same day,
  ///   "昨天", the weekday within a week, else the date. The clock and calendar are passed in, so the
  ///   words do not depend on when or where the tests run.
  /// - SideEffects: none
  /// - Parameters:
  ///   - at: The moment, in milliseconds since the epoch.
  ///   - now: Now, in the same units.
  ///   - calendar: The calendar and time zone to count days in.
  /// - Returns: The words.
  public static func ago(_ at: Int, now: Int, calendar: Calendar = .current) -> String {
    let seconds = max(0, now - at) / 1000
    if seconds < 60 { return "刚刚" }
    if seconds < 3600 { return "\(seconds / 60) 分钟" }
    let then = Date(timeIntervalSince1970: Double(at) / 1000)
    let today = Date(timeIntervalSince1970: Double(now) / 1000)
    let days =
      calendar.dateComponents([.day], from: calendar.startOfDay(for: then), to: calendar.startOfDay(for: today)).day
      ?? 0
    if days == 0 { return "\(seconds / 3600) 小时" }
    if days == 1 { return "昨天" }
    if days < 7 {
      let weekday = calendar.component(.weekday, from: then)
      return "周" + ["日", "一", "二", "三", "四", "五", "六"][weekday - 1]
    }
    let parts = calendar.dateComponents([.month, .day], from: then)
    return "\(parts.month ?? 0)月\(parts.day ?? 0)日"
  }

  /// Rows in the order the home shows a workspace's: asking, errors, running, then the rest.
  ///
  /// - Remark: Stable, so within each the newest stays first.
  /// - SideEffects: none
  /// - Parameter rows: The rows, newest first.
  /// - Returns: The rows.
  static func byUrgency(_ rows: [Row]) -> [Row] {
    let rank = { (row: Row) -> Int in
      switch row.status {
      case .asking?: 0
      case .error?: 1
      case .running?: 2
      case nil: 3
      }
    }
    return stable(rows) { rank($0) < rank($1) }
  }

  /// Where the latest updated session is, for a new session to start in.
  ///
  /// - Remark: SPEC-0005 "MP6 定的细节 · MP6d": the home's `+` starts there; archived sessions and
  ///   children are left out; `nil` with none.
  /// - SideEffects: none
  /// - Parameter index: The list.
  /// - Returns: The workspace or chat.
  public static func recentContainer(in index: IndexState) -> ContainerId? {
    index.sessions.filter { !$0.archived && $0.parent == nil }.max { $0.updatedAt < $1.updatedAt }?.containerId
  }

  /// Where the home's "+" starts a new session: the workspace of the latest session.
  ///
  /// - Remark: SPEC-0005 "MP6 定的细节 · MP6d": `nil`, a new chat, when that session is in a chat or
  ///   there is none; an archived or merged workspace is not a place either.
  /// - SideEffects: none
  /// - Parameter index: The list.
  /// - Returns: The workspace, or `nil`.
  public static func newSessionPlace(in index: IndexState) -> WorkspaceId? {
    recentContainer(in: index).flatMap { openWorkspaces(in: index).contains($0) ? $0 : nil }
  }

  /// The workspaces a new session can go in.
  ///
  /// - Remark: Not archived and not merged.
  /// - SideEffects: none
  /// - Parameter index: The list.
  /// - Returns: Their ids.
  private static func openWorkspaces(in index: IndexState) -> Set<WorkspaceId> {
    Set(index.workspaces.filter { $0.archivedAt == nil && $0.merge?.verdict != .merged }.map(\.id))
  }

  /// The workspaces worked in last, newest first, for the new session's place sheet.
  ///
  /// - Remark: SPEC-0005 "MP6 定的细节 · MP6d": "最近 3 个（按会话最近更新）"; chats, archived and
  ///   merged workspaces are not places to pick.
  /// - SideEffects: none
  /// - Parameters:
  ///   - index: The list.
  ///   - limit: How many.
  /// - Returns: The workspaces.
  public static func recentWorkspaces(in index: IndexState, limit: Int = 3) -> [WorkspaceId] {
    let open = openWorkspaces(in: index)
    var seen: [WorkspaceId] = []
    for session in index.sessions.filter({ !$0.archived && $0.parent == nil }).sorted(by: {
      $0.updatedAt > $1.updatedAt
    })
    where open.contains(session.containerId) && !seen.contains(session.containerId) {
      seen.append(session.containerId)
      if seen.count == limit { break }
    }
    return seen
  }

  /// A session's row in a group.
  ///
  /// - Remark: Asking before an error not seen before running, as the sidebar's row.
  /// - SideEffects: none
  /// - Parameter session: The session.
  /// - Returns: The row.
  private static func row(_ session: SessionSummary) -> Row {
    let failed = session.attention.map { !($0.reason == .error && $0.cleared) } ?? false
    let status: Status? =
      session.asking != nil ? .asking : failed ? .error : session.running ? .running : nil
    return Row(
      id: session.sessionId, title: title(of: session), detail: nil, status: status, updatedAt: session.updatedAt)
  }

  /// A session's title.
  ///
  /// - Remark: As the desktop's `sessionTitle`: pi's name, else the first prompt; with neither, a
  ///   draft is a new session, anything else held only images.
  /// - SideEffects: none
  /// - Parameter session: The session.
  /// - Returns: The title.
  public static func title(of session: SessionSummary) -> String {
    session.name ?? session.prompt ?? (session.state == .draft ? "新会话" : "图片")
  }

  /// A workspace's name.
  ///
  /// - Remark: As the desktop's `workspaceName`: alias, else branch, else the directory's name.
  /// - SideEffects: none
  /// - Parameter workspace: The workspace.
  /// - Returns: The name.
  private static func name(of workspace: Workspace) -> String {
    workspace.alias ?? workspace.branch ?? workspace.dir.split(separator: "/").last.map(String.init) ?? workspace.dir
  }

  /// Where a session lives: "项目 · 工作区", or "对话 · 对话名".
  ///
  /// - Remark: As the desktop's `placeOf`; a chat is named as `chatName`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - containerId: The session's container.
  ///   - index: The list.
  /// - Returns: The place; empty for a container the list does not have.
  public static func place(of containerId: ContainerId, in index: IndexState) -> String {
    if let chat = index.chats.first(where: { $0.id == containerId }) {
      if let alias = chat.alias { return "对话 · \(alias)" }
      let first = index.sessions.first { $0.sessionId == chat.firstSessionId }
      guard let first, first.state != .draft else { return "对话 · 新对话" }
      return "对话 · \(title(of: first))"
    }
    guard let workspace = index.workspaces.first(where: { $0.id == containerId }) else { return "" }
    let project = index.projects.first { $0.id == workspace.projectId }
    return "\(project?.name ?? "") · \(name(of: workspace))"
  }

  /// A session's child conversations, the latest updated first.
  ///
  /// - Remark: SPEC-0005 "MP5 定的细节 · MP5c": the sessions whose `parent` is it, archived ones left
  ///   out, for the "子对话" pill and sheet.
  /// - SideEffects: none
  /// - Parameters:
  ///   - sessionId: The parent.
  ///   - index: The list.
  /// - Returns: The children.
  public static func children(of sessionId: SessionId, in index: IndexState) -> [SessionSummary] {
    newestFirst(index.sessions.filter { $0.parent?.sessionId == sessionId && !$0.archived })
  }

  /// A project's workspaces in the sidebar's order.
  ///
  /// - Remark: As the desktop's `sortWorkspaces`: the local one first, then worktrees newest first,
  ///   then the merged or removed ones, also newest first.
  /// - SideEffects: none
  /// - Parameter workspaces: The project's workspaces.
  /// - Returns: The sorted workspaces.
  private static func sorted(_ workspaces: [Workspace]) -> [Workspace] {
    let done: (Workspace) -> Bool = { $0.merge?.verdict == .merged || $0.merge?.verdict == .removed }
    let newest: (Workspace, Workspace) -> Bool = { ($0.createdAt ?? 0) > ($1.createdAt ?? 0) }
    return workspaces.filter { $0.kind == .local }
      + stable(workspaces.filter { $0.kind == .worktree && !done($0) }, by: newest)
      + stable(workspaces.filter { $0.kind == .worktree && done($0) }, by: newest)
  }

  /// Sessions newest first.
  ///
  /// - Remark: By when they last changed; ties keep the host's order.
  /// - SideEffects: none
  /// - Parameter sessions: The sessions.
  /// - Returns: The sorted sessions.
  private static func newestFirst(_ sessions: [SessionSummary]) -> [SessionSummary] {
    stable(sessions) { $0.updatedAt > $1.updatedAt }
  }

  /// Sorts, keeping equal elements in their order.
  ///
  /// - Remark: Swift's own sort is not stable.
  /// - SideEffects: none
  /// - Parameters:
  ///   - items: The items.
  ///   - before: Whether one goes before another.
  /// - Returns: The sorted items.
  private static func stable<Item>(_ items: [Item], by before: (Item, Item) -> Bool) -> [Item] {
    items.enumerated()
      .sorted { a, b in before(a.element, b.element) || (!before(b.element, a.element) && a.offset < b.offset) }
      .map(\.element)
  }
}
