import AtriumProtocol
import AtriumSync
import Foundation
import Testing

/// A cache in a new temporary folder, removed when the test ends.
///
/// - Remark: Each test gets its own folder.
/// - SideEffects: Creates a folder name; the cache creates the folder when it writes.
/// - Returns: The cache and the folder.
func temporaryCache() -> (cache: SyncCache, root: URL) {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("atrium-cache-\(UUID().uuidString)")
  return (SyncCache(root: root, hostId: "hst_0123456789abcdef"), root)
}

/// A cached session with one turn.
///
/// - Remark: At epoch 1.
/// - SideEffects: none
/// - Parameters:
///   - id: The session.
///   - seq: Its position.
/// - Returns: The cached session.
func cachedSession(_ id: String, seq: Int = 3) -> CachedSession {
  guard let item = try? JSONDecoder().decode(TranscriptItem.self, from: Data(turnJSON("t1").utf8)) else {
    fatalError("fixture does not decode")
  }
  return CachedSession(
    sessionId: id, stream: "st-1", epoch: 1, seq: seq, items: [item], hasOlder: true, exited: false, fast: false)
}

@Suite("Sync cache")
struct SyncCacheTests {
  @Test("reads back the list, a session and the drafts it wrote, under the host's versioned folder")
  func roundTrip() throws {
    let (cache, root) = temporaryCache()
    defer { try? FileManager.default.removeItem(at: root) }
    var state = IndexState()
    apply(&state, indexSnapshotJSON(generation: "h1", seq: 5, sessions: [summaryJSON("s1", in: "w1")]))
    let index = try #require(state.cached)

    try cache.save(index)
    try cache.save(cachedSession("s1"))
    try cache.save(drafts: ["s1": "half"])

    #expect(cache.index() == index)
    #expect(cache.session("s1") == cachedSession("s1"))
    #expect(cache.session("s2") == nil)
    #expect(cache.drafts() == ["s1": "half"])
    #expect(cache.directory.path.hasSuffix("hst_0123456789abcdef/v1"))
    let host = cache.directory.deletingLastPathComponent()
    #expect(try host.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
  }

  @Test("treats a file it cannot read as missing")
  func damaged() throws {
    let (cache, root) = temporaryCache()
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: cache.directory, withIntermediateDirectories: true)
    try Data("{ nope".utf8).write(to: cache.directory.appendingPathComponent("index.json"))
    #expect(cache.index() == nil)
    #expect(cache.drafts() == [:])
  }

  @Test("keeps at most twenty sessions, dropping the least recently written")
  func prune() throws {
    let (cache, root) = temporaryCache()
    defer { try? FileManager.default.removeItem(at: root) }
    for number in 0...SyncCache.maxSessions {
      try cache.save(cachedSession("s\(number)"))
      let file = cache.directory.appendingPathComponent("sessions/s\(number).json")
      try FileManager.default.setAttributes(
        [.modificationDate: Date(timeIntervalSince1970: TimeInterval(1_000 + number))], ofItemAtPath: file.path)
    }
    try cache.save(cachedSession("s\(SyncCache.maxSessions)"))
    #expect(cache.session("s0") == nil)
    #expect(cache.session("s1") != nil)
  }

  @Test("counts opening a session as using it, so the least recently opened goes first")
  func pruneByOpening() throws {
    let (cache, root) = temporaryCache()
    defer { try? FileManager.default.removeItem(at: root) }
    for number in 0..<SyncCache.maxSessions {
      try cache.save(cachedSession("s\(number)"))
      let file = cache.directory.appendingPathComponent("sessions/s\(number).json")
      try FileManager.default.setAttributes(
        [.modificationDate: Date(timeIntervalSince1970: TimeInterval(1_000 + number))], ofItemAtPath: file.path)
    }
    cache.markOpened("s0")
    try cache.save(cachedSession("new"))
    #expect(cache.session("s0") != nil)
    #expect(cache.session("s1") == nil)
    cache.markOpened("missing")
  }

  @Test("removes everything of the host")
  func removeAll() throws {
    let (cache, root) = temporaryCache()
    defer { try? FileManager.default.removeItem(at: root) }
    try cache.save(drafts: ["s1": "x"])
    try cache.removeAll()
    #expect(!FileManager.default.fileExists(atPath: cache.directory.deletingLastPathComponent().path))
    try cache.removeAll()
  }
}

@Suite("Sync core: from the cache")
struct SyncCoreCacheTests {
  @Test("shows the cached list and drafts as not up to date until the first sync, and lists by its cursor")
  func restores() {
    var state = IndexState()
    apply(&state, indexSnapshotJSON(generation: "h1", seq: 5, sessions: [summaryJSON("s1", in: "w1")]))
    var sync = core()
    sync.restore(index: state.cached, drafts: ["s1": "half"])
    #expect(sync.stale)
    #expect(sync.index.sessions.map(\.sessionId) == ["s1"])
    #expect(sync.drafts["s1"] == "half")

    #expect(
      sync.connected(generation: 1) == [
        .send(subscribeIndex("r1", cursor: .init(generation: "h1", seq: 5)), generation: 1)
      ])
    #expect(receive(&sync, generation: 1, ok("r1"), indexChangesJSON(seq: 5)) == [.markSynced(generation: 1)])
    #expect(!sync.stale)
  }

  @Test("opens a session from its cached copy and continues from it")
  func opensCached() {
    var sync = core()
    #expect(sync.open("s1", cached: cachedSession("s1")) == [])
    #expect(sync.sessions["s1"]?.items.count == 1)
    #expect(sync.sessions["s1"]?.cached == cachedSession("s1"))

    #expect(
      sync.connected(generation: 1) == [
        .send(subscribeIndex("r1"), generation: 1),
        .send(
          subscribeSessions("r2", ["s1"], resume: [ResumePoint(sessionId: "s1", stream: "st-1", epoch: 1, seq: 3)]),
          generation: 1),
        .send(openSession("r3", "s1"), generation: 1),
      ])

    var synced = syncedCore()
    #expect(
      synced.open("s2", cached: cachedSession("s2")) == [
        .send(
          subscribeSessions(
            "r4", ["s1", "s2"], resume: [ResumePoint(sessionId: "s2", stream: "st-1", epoch: 1, seq: 3)]),
          generation: 1),
        .send(openSession("r5", "s2"), generation: 1),
      ])
    #expect(synced.sessions["s2"]?.resuming == true)
  }
}
