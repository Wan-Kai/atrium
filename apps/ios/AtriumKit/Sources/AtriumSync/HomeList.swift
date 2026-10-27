import AtriumProtocol

/// What the home screen lists, worked out from the list.
///
/// - Remark: SPEC-0005 "MP4a 定的细节 · 界面": "等你处理" first, then each project's workspaces
///   with their sessions, then the sessions of chats. The rules follow the desktop's sidebar
///   (`packages/ui/src/sidebar/names.ts`, `status.ts`): the inbox picks and orders as `inboxOf`,
///   workspaces are named and ordered as `workspaceName` and `sortWorkspaces`, sessions are titled
///   as `sessionTitle`. Archived sessions, archived workspaces and chats, and child conversations
///   are left out of the groups. The full layout (three per workspace, "还有 N 个") comes in MP6.
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
  }

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
  }

  /// The sessions that wait for you.
  public let inbox: [Row]
  /// The projects, in the host's order.
  public let projects: [ProjectGroup]
  /// The sessions of chats, newest first.
  public let chats: [Row]

  /// Whether there is nothing to list at all.
  public var isEmpty: Bool { inbox.isEmpty && projects.isEmpty && chats.isEmpty }

  /// Works the home list out from the list.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter index: The list.
  public init(_ index: IndexState) {
    let listed = index.sessions.filter { !$0.archived && $0.parent == nil }
    let liveChats = Set(index.chats.filter { $0.archivedAt == nil }.map(\.id))
    inbox = Self.inbox(index)
    projects = index.projects.map { project in
      let workspaces = Self.sorted(index.workspaces.filter { $0.projectId == project.id && $0.archivedAt == nil })
      let sessions = workspaces.map { workspace in Self.newestFirst(listed.filter { $0.containerId == workspace.id }) }
      let groups = zip(workspaces, sessions).map { workspace, sessions in
        WorkspaceGroup(id: workspace.id, name: Self.name(of: workspace), rows: sessions.map(Self.row))
      }
      return ProjectGroup(
        id: project.id, name: project.name, running: sessions.joined().filter(\.running).count, workspaces: groups)
    }
    chats = Self.newestFirst(listed.filter { liveChats.contains($0.containerId) }).map(Self.row)
  }

  /// The sessions that wait for you, in order.
  ///
  /// - Remark: As the desktop's `inboxOf`: not archived; waiting for an answer, else with an
  ///   attention not seen yet (an error seen stays out, a sign-in stays in); asking, then sign-in,
  ///   then errors, each newest first.
  /// - SideEffects: none
  /// - Parameter index: The list.
  /// - Returns: The rows.
  private static func inbox(_ index: IndexState) -> [Row] {
    let waiting: [(session: SessionSummary, priority: Int, at: Int)] = index.sessions.compactMap { session in
      guard !session.archived else { return nil }
      if let asking = session.asking { return (session, 0, asking) }
      guard let attention = session.attention, !(attention.reason == .error && attention.cleared) else { return nil }
      return (session, attention.reason == .auth ? 1 : 2, attention.at)
    }
    return stable(waiting) { a, b in a.priority != b.priority ? a.priority < b.priority : a.at > b.at }
      .map { entry in
        let status: Status = entry.priority == 0 ? .asking : .error
        let word = status == .asking ? "在问你" : "出错"
        return Row(
          id: entry.session.sessionId, title: title(of: entry.session),
          detail: "\(word) · \(place(of: entry.session.containerId, in: index))", status: status)
      }
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
    return Row(id: session.sessionId, title: title(of: session), detail: nil, status: status)
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
