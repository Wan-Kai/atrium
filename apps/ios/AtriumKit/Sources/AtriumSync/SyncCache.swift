import AtriumProtocol
import Foundation

/// The list as cached: what the home shows, with the cursor to continue from.
///
/// - Remark: The cursor lets the first `subscribe_index` continue with changes instead of a snapshot.
public struct CachedIndex: Codable, Sendable, Equatable {
  /// The host instance the list comes from.
  public var generation: String
  /// The list position.
  public var seq: Int
  /// The projects.
  public var projects: [Project]
  /// The workspaces.
  public var workspaces: [Workspace]
  /// The chats.
  public var chats: [Chat]
  /// The sessions.
  public var sessions: [SessionSummary]

  /// Makes a cached list.
  ///
  /// - Remark: From ``IndexState/cached``.
  /// - SideEffects: none
  /// - Parameters:
  ///   - generation: The host instance.
  ///   - seq: The list position.
  ///   - projects: The projects.
  ///   - workspaces: The workspaces.
  ///   - chats: The chats.
  ///   - sessions: The sessions.
  public init(
    generation: String, seq: Int, projects: [Project], workspaces: [Workspace], chats: [Chat],
    sessions: [SessionSummary]
  ) {
    self.generation = generation
    self.seq = seq
    self.projects = projects
    self.workspaces = workspaces
    self.chats = chats
    self.sessions = sessions
  }
}

/// A session as cached: its latest items with the position they stand at.
///
/// - Remark: The position becomes the session's ``ResumePoint`` when it is opened again.
public struct CachedSession: Codable, Sendable, Equatable {
  /// The session.
  public var sessionId: SessionId
  /// The stream the position belongs to.
  public var stream: String
  /// The epoch.
  public var epoch: Int
  /// The seq of the latest event in the items.
  public var seq: Int
  /// The items.
  public var items: [TranscriptItem]
  /// Whether older items exist on the host.
  public var hasOlder: Bool
  /// Whether pi had exited.
  public var exited: Bool

  /// Makes a cached session.
  ///
  /// - Remark: From ``SessionState/cached``.
  /// - SideEffects: none
  /// - Parameters:
  ///   - sessionId: The session.
  ///   - stream: The stream.
  ///   - epoch: The epoch.
  ///   - seq: The seq.
  ///   - items: The items.
  ///   - hasOlder: Whether older items exist.
  ///   - exited: Whether pi had exited.
  public init(
    sessionId: SessionId, stream: String, epoch: Int, seq: Int, items: [TranscriptItem], hasOlder: Bool,
    exited: Bool
  ) {
    self.sessionId = sessionId
    self.stream = stream
    self.epoch = epoch
    self.seq = seq
    self.items = items
    self.hasOlder = hasOlder
    self.exited = exited
  }
}

/// The phone's copy of one Mac's list, opened sessions and drafts, kept between launches.
///
/// - Remark: SPEC-0005 "iOS App · 存储" and "MP4c 定的细节": one directory per host and cache format
///   version; `index.json`, `sessions/<id>.json`, `drafts.json`, each written to a temporary file and
///   renamed, so a cursor read back always matches the content read with it. Files are completely
///   protected on iOS and the directory is excluded from backups. At most ``maxSessions`` sessions are
///   kept, the least recently written going first. A file that does not decode counts as missing.
public struct SyncCache: Sendable {
  /// The cache format version, part of the directory.
  public static let version = 1
  /// The most sessions kept.
  public static let maxSessions = 20

  /// The host's cache directory, versioned.
  public let directory: URL

  /// Points a cache at a host's directory under a root.
  ///
  /// - Remark: The root is the app's Application Support folder in the app, a temporary one in tests.
  /// - SideEffects: none
  /// - Parameters:
  ///   - root: Where every host's cache lives.
  ///   - hostId: The Mac.
  public init(root: URL, hostId: String) {
    directory = root.appendingPathComponent(hostId, isDirectory: true)
      .appendingPathComponent("v\(Self.version)", isDirectory: true)
  }

  /// The cached list, if any.
  ///
  /// - Remark: `nil` when missing or unreadable.
  /// - SideEffects: Reads a file.
  /// - Returns: The list.
  public func index() -> CachedIndex? {
    read(CachedIndex.self, at: directory.appendingPathComponent("index.json"))
  }

  /// A cached session, if any.
  ///
  /// - Remark: `nil` when missing or unreadable.
  /// - SideEffects: Reads a file.
  /// - Parameter sessionId: The session.
  /// - Returns: The session.
  public func session(_ sessionId: SessionId) -> CachedSession? {
    read(CachedSession.self, at: sessionURL(sessionId))
  }

  /// The cached drafts.
  ///
  /// - Remark: Empty when missing or unreadable.
  /// - SideEffects: Reads a file.
  /// - Returns: Each session's input.
  public func drafts() -> [SessionId: String] {
    read([SessionId: String].self, at: directory.appendingPathComponent("drafts.json")) ?? [:]
  }

  /// Writes the list.
  ///
  /// - Remark: Atomically.
  /// - SideEffects: Writes a file; may create the directory.
  /// - Parameter index: The list.
  /// - Throws: When the file cannot be written.
  public func save(_ index: CachedIndex) throws {
    try write(index, to: directory.appendingPathComponent("index.json"))
  }

  /// Writes a session, then keeps at most ``maxSessions``.
  ///
  /// - Remark: Atomically; the session just written is the newest.
  /// - SideEffects: Writes a file; may delete older ones.
  /// - Parameter session: The session.
  /// - Throws: When the file cannot be written.
  public func save(_ session: CachedSession) throws {
    try write(session, to: sessionURL(session.sessionId))
    try prune()
  }

  /// Writes the drafts.
  ///
  /// - Remark: Atomically; small, so written on every change.
  /// - SideEffects: Writes a file.
  /// - Parameter drafts: Each session's input.
  /// - Throws: When the file cannot be written.
  public func save(drafts: [SessionId: String]) throws {
    try write(drafts, to: directory.appendingPathComponent("drafts.json"))
  }

  /// Deletes everything cached for the host.
  ///
  /// - Remark: When the phone was revoked or the Mac forgotten (SPEC-0005 "撤销").
  /// - SideEffects: Deletes the host's directory.
  /// - Throws: When it exists and cannot be deleted.
  public func removeAll() throws {
    let host = directory.deletingLastPathComponent()
    guard FileManager.default.fileExists(atPath: host.path) else { return }
    try FileManager.default.removeItem(at: host)
  }

  /// The file of a session.
  ///
  /// - Remark: Session ids are pi's, safe as file names; anything else is percent-encoded.
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  /// - Returns: The URL.
  private func sessionURL(_ sessionId: SessionId) -> URL {
    let name = sessionId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(["-", "_"])) ?? sessionId
    return directory.appendingPathComponent("sessions", isDirectory: true).appendingPathComponent("\(name).json")
  }

  /// Keeps the newest ``maxSessions`` session files.
  ///
  /// - Remark: By modification date.
  /// - SideEffects: Deletes files.
  /// - Throws: When the folder cannot be listed or a file deleted.
  private func prune() throws {
    let folder = directory.appendingPathComponent("sessions", isDirectory: true)
    let files = try FileManager.default.contentsOfDirectory(
      at: folder, includingPropertiesForKeys: [.contentModificationDateKey])
    guard files.count > Self.maxSessions else { return }
    let dated = files.map { file in
      (
        file,
        (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
      )
    }
    for (file, _) in dated.sorted(by: { $0.1 > $1.1 }).dropFirst(Self.maxSessions) {
      try FileManager.default.removeItem(at: file)
    }
  }

  /// Reads and decodes a file.
  ///
  /// - Remark: Missing and unreadable are alike.
  /// - SideEffects: Reads the file.
  /// - Parameters:
  ///   - type: What it holds.
  ///   - url: The file.
  /// - Returns: The value, or `nil`.
  private func read<Value: Decodable>(_ type: Value.Type, at url: URL) -> Value? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
  }

  /// Encodes and writes a file atomically.
  ///
  /// - Remark: Creates the directories, protected and excluded from backups.
  /// - SideEffects: Writes the file; may create directories.
  /// - Parameters:
  ///   - value: The value.
  ///   - url: The file.
  /// - Throws: When encoding or writing fails.
  private func write<Value: Encodable>(_ value: Value, to url: URL) throws {
    try prepare(url.deletingLastPathComponent())
    #if os(iOS)
      let options: Data.WritingOptions = [.atomic, .completeFileProtection]
    #else
      let options: Data.WritingOptions = [.atomic]
    #endif
    try JSONEncoder().encode(value).write(to: url, options: options)
  }

  /// Creates a directory if needed and excludes the host's from backups.
  ///
  /// - Remark: The exclusion is set on the host directory, which covers everything under it.
  /// - SideEffects: Creates directories; sets a resource value.
  /// - Parameter folder: The directory.
  /// - Throws: When it cannot be created.
  private func prepare(_ folder: URL) throws {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var host = directory.deletingLastPathComponent()
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try host.setResourceValues(values)
  }
}
