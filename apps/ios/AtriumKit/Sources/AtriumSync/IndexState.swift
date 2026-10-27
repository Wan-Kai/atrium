import AtriumProtocol

/// The list as the phone holds it: the latest snapshot and the changes after it.
///
/// - Remark: Mirrors `packages/client`'s `index-view` (SPEC-0005 "iOS App · 模块"): a snapshot
///   replaces everything, changes upsert in place and append new items, and changes before the
///   first snapshot or of another host instance have nothing to apply to. The layout and
///   preferences are left out: MP4a shows neither.
public struct IndexState: Sendable, Equatable {
  /// A snapshot has arrived.
  public private(set) var ready = false
  /// The host instance the list comes from.
  public private(set) var generation = ""
  /// The list position, the host's cursor.
  public private(set) var seq = 0
  /// The projects, in the host's order.
  public private(set) var projects: [Project] = []
  /// The workspaces, in the host's order.
  public private(set) var workspaces: [Workspace] = []
  /// The chats, in the host's order.
  public private(set) var chats: [Chat] = []
  /// The sessions, in the host's order.
  public private(set) var sessions: [SessionSummary] = []

  /// An empty list, before the first snapshot.
  ///
  /// - Remark: The home screen shows it until the host answers.
  /// - SideEffects: none
  public init() {}

  /// Takes in a snapshot.
  ///
  /// - Remark: A snapshot replaces everything (SPEC-0001 "项目、工作区与会话").
  /// - SideEffects: none
  /// - Parameter snapshot: The snapshot.
  public mutating func apply(_ snapshot: IndexSnapshotEvent) {
    ready = true
    generation = snapshot.generation
    seq = snapshot.seq
    projects = snapshot.projects
    workspaces = snapshot.workspaces
    chats = snapshot.chats
    sessions = snapshot.sessions
  }

  /// Applies a batch of changes.
  ///
  /// - Remark: Ignored before the first snapshot or from another host instance; the snapshot that
  ///   answers the next subscription sets things right (SPEC-0001 "列表的增量").
  /// - SideEffects: none
  /// - Parameter changes: The changes.
  public mutating func apply(_ changes: IndexChangesEvent) {
    guard ready, changes.generation == generation else { return }
    seq = changes.seq
    projects = Self.merged(projects, changes.projects.upsert, removing: changes.projects.remove, id: \.id)
    workspaces = Self.merged(workspaces, changes.workspaces.upsert, removing: changes.workspaces.remove, id: \.id)
    chats = Self.merged(chats, changes.chats.upsert, removing: changes.chats.remove, id: \.id)
    sessions = Self.merged(
      sessions, changes.sessions.upsert, removing: changes.sessions.remove, id: \.sessionId)
  }

  /// Applies one collection's changes.
  ///
  /// - Remark: A changed item stays where it is and a new one goes at the end, as on the host.
  /// - SideEffects: none
  /// - Parameters:
  ///   - items: The collection.
  ///   - upsert: Items that changed, whole.
  ///   - remove: Ids of items that went.
  ///   - id: An item's id.
  /// - Returns: The new collection.
  private static func merged<Item>(
    _ items: [Item], _ upsert: [Item], removing remove: [String], id: (Item) -> String
  ) -> [Item] {
    var changed = Dictionary(upsert.map { (id($0), $0) }, uniquingKeysWith: { _, last in last })
    let removed = Set(remove)
    var result: [Item] = []
    for item in items where !removed.contains(id(item)) {
      result.append(changed.removeValue(forKey: id(item)) ?? item)
    }
    result.append(contentsOf: upsert.compactMap { changed.removeValue(forKey: id($0)) })
    return result
  }
}
