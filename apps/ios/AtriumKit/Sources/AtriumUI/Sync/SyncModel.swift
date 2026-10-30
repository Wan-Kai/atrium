import AtriumProtocol
import AtriumRemote
import AtriumRender
import AtriumSync
import Foundation
import Observation

/// Drives one connection's sync and holds what the screens show.
///
/// - Remark: The assembly between ``RemoteConnection`` and ``SyncCore`` (overview.md "iOS 工程":
///   AtriumSync does not know connections). Messages are decoded and handed to the core with their
///   generation; what the core asks for goes through one queue, so commands leave in the order the
///   core produced them, and `markSynced` follows the commands before it. A send refused because the
///   connection was replaced is dropped: the next generation subscribes again (SPEC-0005 "MP4a 定的
///   细节" 4). One model per ``RemoteConnection``: a new connection object starts its generations
///   again, so it gets a new model.
@MainActor
@Observable
public final class SyncModel {
  /// The list and the open sessions.
  public private(set) var core: SyncCore {
    didSet { mirror(from: oldValue) }
  }
  /// What the home screen lists, rebuilt only when the list changes.
  ///
  /// - Remark: The home stays under every pushed page; read from `core`, each streamed fragment
  ///   rebuilt its list (~10% of the main thread in the phone's trace, 2026-10-29).
  public private(set) var home: HomeList
  /// Whether what is shown is what the Mac last said, not live; see ``SyncCore/stale``.
  public private(set) var stale = false
  /// Whether the first list has come.
  public private(set) var indexReady = false
  /// The workspaces' uncommitted changes; see ``SyncCore/changes``.
  public private(set) var changes: [WorkspaceId: ChangesUpdatedEvent] = [:]
  #if DEBUG
    /// How many times the home list was built, for the tests.
    @ObservationIgnored private(set) var homeBuilds = 0
  #endif
  /// How the connection stands, as it last said.
  public private(set) var status = ConnectionStatus.connecting
  /// The Mac's name, for the connection pill.
  public let hostName: String

  @ObservationIgnored private let connection: RemoteConnection
  @ObservationIgnored private let cache: SyncCache?
  /// Whether the host revoked this phone: its copy is deleted and never written again.
  @ObservationIgnored private var revoked = false
  /// The drafts as last written to the cache.
  @ObservationIgnored private var savedDrafts: [SessionId: String] = [:]
  @ObservationIgnored private let clock: any Clock<Duration>
  /// Whether the open page is scrolling; older turns wait for it (see ``ScrollRest``).
  @ObservationIgnored public let rest = ScrollRest()
  /// The pending throttled write of the cache, if any.
  @ObservationIgnored private var saving: Task<Void, Never>?
  @ObservationIgnored private let outputs: AsyncStream<SyncOutput>
  @ObservationIgnored private let queue: AsyncStream<SyncOutput>.Continuation

  /// Makes the model for a connection.
  ///
  /// - Remark: Ids, traces and time come from the assembly.
  /// - SideEffects: none
  /// - Parameters:
  ///   - connection: The connection, started or not.
  ///   - hostName: The Mac's name.
  ///   - traceparent: Makes a command's traceparent.
  ///   - now: The time since some fixed origin, for the retry window.
  ///   - requestId: Makes a request id; random UUIDs in the app (SPEC-0005 "协议改动" 4).
  ///   - cache: The host's cache, read now and written as things change; `nil` keeps nothing.
  ///   - clock: The clock the cache's writes are throttled on, and older turns wait on.
  public init(
    connection: RemoteConnection, hostName: String, traceparent: @escaping @Sendable () -> String,
    now: @escaping @Sendable () -> Duration, requestId: @escaping () -> String, cache: SyncCache? = nil,
    clock: any Clock<Duration> = ContinuousClock()
  ) {
    self.connection = connection
    self.hostName = hostName
    self.cache = cache
    self.clock = clock
    (outputs, queue) = AsyncStream.makeStream(of: SyncOutput.self)
    let drafts = cache?.drafts() ?? [:]
    var restored = SyncCore(requestId: requestId, traceparent: traceparent, now: now)
    restored.restore(index: cache?.index(), drafts: drafts)
    home = HomeList(restored.index)
    core = restored
    savedDrafts = drafts
    stale = restored.stale
    indexReady = restored.index.ready
    changes = restored.changes
  }

  /// Updates what the home reads from the core, each only when it changed.
  ///
  /// - Remark: Building the list is the cost (sorting, grouping, placing the notes), so it is built
  ///   only when the list changed; the list compares cheaply when untouched, its arrays sharing
  ///   storage. The others are compared too, so an unchanged value is not even assigned.
  /// - SideEffects: May set `home`, `stale`, `indexReady` and `changes`.
  /// - Parameter old: The core before.
  private func mirror(from old: SyncCore) {
    if core.index != old.index {
      home = HomeList(core.index)
      #if DEBUG
        homeBuilds += 1
      #endif
    }
    if core.stale != stale { stale = core.stale }
    if core.index.ready != indexReady { indexReady = core.index.ready }
    if core.changes != changes { changes = core.changes }
  }

  /// Reads messages and carries out what the core asks, until cancelled.
  ///
  /// - Remark: The loops run side by side; cancelling the caller ends them. A cache write still
  ///   waiting then is dropped, so a model no longer run cannot overwrite a newer copy.
  /// - SideEffects: Sends on the connection; marks it synced; cancels a pending cache write.
  public func run() async {
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await self.carryOut() }
      group.addTask { await self.listen() }
      group.addTask { await self.followOpenings() }
    }
    saving?.cancel()
    saving = nil
  }

  /// Takes a status the connection reported.
  ///
  /// - Remark: "正在同步" on a channel already open is the foreground probe of that channel: the
  ///   core syncs it again. "正在同步" without an open channel waits for one: ``followOpenings()``
  ///   starts its sync once it is up, never before (SPEC-0005 "MP4a 定的细节" 5).
  /// - SideEffects: Reads the connection's open generation; queues commands; on revocation waits for a write in progress, then deletes the cache.
  /// - Parameter status: The status.
  public func statusChanged(_ status: ConnectionStatus) async {
    self.status = status
    // An authenticated revocation deletes the host's copy with its keys (SPEC-0005 "撤销").
    if status == .revoked {
      revoked = true
      let pending = saving
      pending?.cancel()
      saving = nil
      // A write already encoding off the main actor finishes first, so it cannot recreate the files.
      await pending?.value
      try? cache?.removeAll()
    }
    guard status == .syncing, let generation = await connection.openGeneration else { return }
    enqueue(core.connected(generation: generation))
  }

  /// Starts syncing each channel as it opens.
  ///
  /// - Remark: See ``statusChanged(_:)``; the core ignores a generation already being synced.
  /// - SideEffects: Queues commands.
  private func followOpenings() async {
    for await generation in connection.openings {
      enqueue(core.connected(generation: generation))
    }
  }

  /// Opens a session's page.
  ///
  /// - Remark: See ``SyncCore/open(_:)``.
  /// - SideEffects: Queues commands.
  /// - Parameter sessionId: The session.
  public func open(_ sessionId: SessionId) {
    writable?.markOpened(sessionId)
    enqueue(core.open(sessionId, cached: cache?.session(sessionId)))
  }

  /// Closes a session's page.
  ///
  /// - Remark: See ``SyncCore/close(_:)``.
  /// - SideEffects: Queues commands.
  /// - Parameter sessionId: The session.
  public func close(_ sessionId: SessionId) {
    if let session = core.sessions[sessionId]?.cached { try? writable?.save(session) }
    enqueue(core.close(sessionId))
  }

  /// Writes the cache now: the list and the open sessions.
  ///
  /// - Remark: When the app goes to the background, and at the end of each throttled wait. A write
  ///   that fails leaves the old copy, which the next launch still resumes from or replaces.
  /// - SideEffects: Writes files; cancels a pending write.
  public func saveNow() {
    saving?.cancel()
    saving = nil
    guard let cache = writable else { return }
    if let index = core.index.cached { try? cache.save(index) }
    for sessionId in core.openSessions {
      if let session = core.sessions[sessionId]?.cached { try? cache.save(session) }
    }
  }

  /// Writes the cache a second from now, unless a write is already waiting.
  ///
  /// - Remark: Streaming changes the open session many times a second; one write a second is enough
  ///   for a copy that only has to be close (SPEC-0005 "MP4c 定的细节").
  ///   The task holds the model weakly, so a model replaced meanwhile writes nothing stale. The
  ///   copies are taken on the main actor and encoded and written off it (the phone's trace,
  ///   2026-10-29); a ``saveNow()`` meanwhile may be overwritten by this older copy, which is
  ///   still a valid resume point.
  /// - SideEffects: Starts a task that sleeps on the injected clock, then writes files off the
  ///   main actor.
  private func scheduleSave() {
    guard writable != nil, saving == nil else { return }
    saving = Task { [weak self, clock] in
      do { try await clock.sleep(for: .seconds(1)) } catch { return }
      guard let self, let cache = self.writable else { return }
      // The copies share storage with the core, so taking them here is cheap; encoding a transcript
      // of up to 512 KiB and writing it is not, and blocked the main thread once a second.
      let index = self.core.index.cached
      let sessions = self.core.openSessions.compactMap { self.core.sessions[$0]?.cached }
      let write = Task.detached(priority: .utility) {
        if let index { try? cache.save(index) }
        for session in sessions { try? cache.save(session) }
      }
      await write.value
      // Kept until written, so a revocation waits for it; one cancelled was replaced or dropped.
      if !Task.isCancelled { self.saving = nil }
    }
  }

  /// The cache, while it may be written.
  ///
  /// - Remark: `nil` without one, or once the host revoked this phone (SPEC-0005 "MP4c 定的细节").
  private var writable: SyncCache? { revoked ? nil : cache }

  /// Whether a session's input may be sent now.
  ///
  /// - Remark: The connection says it is connected, and the core agrees (``SyncCore/canSend(_:)``).
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  /// - Returns: Whether the send button works.
  public func canSend(_ sessionId: SessionId) -> Bool {
    status == .connected && core.canSend(sessionId)
  }

  /// Changes what a session's input holds.
  ///
  /// - Remark: See ``SyncCore/setDraft(_:for:)``.
  /// - SideEffects: Updates the core.
  /// - Parameters:
  ///   - text: The input.
  ///   - sessionId: The session.
  public func setDraft(_ text: String, for sessionId: SessionId) {
    core.setDraft(text, for: sessionId)
    saveDrafts()
  }

  /// Writes the drafts if the core changed them since the last write.
  ///
  /// - Remark: Typing, sending and a message given back all change them; each is written at once
  ///   (SPEC-0005 "MP4c 定的细节").
  /// - SideEffects: May write a file.
  private func saveDrafts() {
    guard let cache = writable, core.drafts != savedDrafts else { return }
    do {
      try cache.save(drafts: core.drafts)
      savedDrafts = core.drafts
    } catch {
      // The old drafts stay on disk; the next change tries again.
    }
  }

  /// Changes the images a session's input holds.
  ///
  /// - Remark: See ``SyncCore/setDraftImages(_:for:)``. Kept in memory only.
  /// - SideEffects: Updates the core.
  /// - Parameters:
  ///   - images: The images.
  ///   - sessionId: The session.
  public func setDraftImages(_ images: [OutgoingImage], for sessionId: SessionId) {
    core.setDraftImages(images, for: sessionId)
  }

  /// Makes a new session and sends its first message.
  ///
  /// - Remark: See ``SyncCore/startSession(in:chat:text:images:)``.
  /// - SideEffects: Queues the command.
  /// - Parameters:
  ///   - container: The workspace, or `nil` for a chat.
  ///   - text: The first message.
  public func startSession(in container: ContainerId?, text: String) {
    enqueue(core.startSession(in: container, chat: container == nil, text: text, images: []))
  }

  /// Asks for the models a workspace's sessions can use.
  ///
  /// - Remark: See ``SyncCore/listModels(workspaceId:refresh:)``.
  /// - SideEffects: Queues the command.
  /// - Parameters:
  ///   - workspaceId: The workspace, or `nil` for a chat.
  ///   - refresh: Whether pi lists them again.
  public func listModels(workspaceId: WorkspaceId?, refresh: Bool) {
    enqueue(core.listModels(workspaceId: workspaceId, refresh: refresh))
  }

  /// Fetches the turns before the earliest an open session has.
  ///
  /// - Remark: See ``SyncCore/loadOlder(_:)``; the page calls it when its top row shows.
  /// - SideEffects: Queues the command.
  /// - Parameter sessionId: The session.
  public func loadOlder(_ sessionId: SessionId) {
    enqueue(core.loadOlder(sessionId))
  }

  /// Fetches a step whole that came cut to a preview.
  ///
  /// - Remark: See ``SyncCore/fetchStep(_:)``; a rail row calls it when opened.
  /// - SideEffects: Queues the command.
  /// - Parameter ref: The step.
  public func fetchStep(_ ref: StepRef) {
    enqueue(core.fetchStep(ref))
  }

  /// Watches the changes of the workspaces shown.
  ///
  /// - Remark: See ``SyncCore/watchChanges(_:)``.
  /// - SideEffects: Queues the command.
  /// - Parameter workspaceIds: The workspaces.
  public func watchChanges(_ workspaceIds: [WorkspaceId]) {
    enqueue(core.watchChanges(workspaceIds))
  }

  /// Opens the change list's diff, or closes it.
  ///
  /// - Remark: See ``SyncCore/watchDiff(_:)``.
  /// - SideEffects: Queues the command.
  /// - Parameter target: The workspace and mode, or `nil`.
  public func watchDiff(_ target: DiffTarget?) {
    enqueue(core.watchDiff(target))
  }

  /// Sends a session's input.
  ///
  /// - Remark: See ``SyncCore/send(_:steer:)``.
  /// - SideEffects: Queues the command.
  /// - Parameters:
  ///   - sessionId: The session.
  ///   - steer: Whether to send it as a steer ("立即插话").
  public func send(_ sessionId: SessionId, steer: Bool = false) {
    guard status == .connected else { return }
    enqueue(core.send(sessionId, steer: steer))
    saveDrafts()
  }

  /// Asks something of a session's run.
  ///
  /// - Remark: See ``SyncCore/perform(_:in:)``.
  /// - SideEffects: Queues the command.
  /// - Parameters:
  ///   - action: The action.
  ///   - sessionId: The session.
  /// - Returns: Whether it was sent: not while disconnected or before the sync.
  @discardableResult
  public func perform(_ action: SessionAction, in sessionId: SessionId) -> Bool {
    guard status == .connected else { return false }
    let outputs = core.perform(action, in: sessionId)
    enqueue(outputs)
    return !outputs.isEmpty
  }

  /// Forgets why the last action on a session failed.
  ///
  /// - Remark: See ``SyncCore/dismissActionProblem(in:)``.
  /// - SideEffects: Updates the core.
  /// - Parameter sessionId: The session.
  public func dismissActionProblem(in sessionId: SessionId) {
    core.dismissActionProblem(in: sessionId)
  }

  /// Clears a session's error once its page shows it.
  ///
  /// - Remark: See ``SyncCore/clearAttention(_:)``.
  /// - SideEffects: Queues the command.
  /// - Parameter sessionId: The session.
  public func clearAttention(_ sessionId: SessionId) {
    guard status == .connected else { return }
    enqueue(core.clearAttention(sessionId))
  }

  /// Sends an uncertain message again, as a new one.
  ///
  /// - Remark: See ``SyncCore/resend(_:)``.
  /// - SideEffects: Queues the command.
  /// - Parameter requestId: The message.
  public func resend(_ requestId: RequestId) {
    guard status == .connected else { return }
    enqueue(core.resend(requestId))
  }

  /// Hands each message to the core.
  ///
  /// - Remark: A message that does not decode is from a host this app cannot read; it is skipped,
  ///   and the session it was about resyncs at its next event.
  /// - SideEffects: Updates the core; queues commands.
  private func listen() async {
    let decoder = JSONDecoder()
    for await message in connection.messages {
      guard let decoded = try? decoder.decode(HostMessage.self, from: message.data) else { continue }
      // Older turns are parsed before they go in front, so they lay out whole and what you read stays put;
      // they go in once the page rests, as laying them out stalls a frame (what follows waits with them).
      if let older = core.olderItems(in: decoded) {
        await MarkdownCache.shared.warm(Self.replies(older))
        await rest.wait(on: clock)
      }
      // A snapshot's replies too, so each lays out whole the first time it comes on screen.
      if case .sessionEvent(.sessionSnapshot(let snapshot)) = decoded {
        await MarkdownCache.shared.warm(Self.replies(snapshot.items))
      }
      enqueue(core.receive(decoded, generation: message.generation))
      saveDrafts()
      scheduleSave()
    }
  }

  /// The reply texts of some items, as their turns show them.
  ///
  /// - Remark: See `TurnLayout.reply`.
  /// - SideEffects: none
  /// - Parameter items: Transcript items.
  /// - Returns: The replies.
  static func replies(_ items: [TranscriptItem]) -> [String] {
    items.compactMap { item in
      guard case .turn(let turn) = item else { return nil }
      return TurnLayout(turn).reply
    }
  }

  /// Carries out the queue in order.
  ///
  /// - Remark: See the type.
  /// - SideEffects: Sends on the connection; marks it synced.
  private func carryOut() async {
    let encoder = JSONEncoder()
    for await output in outputs {
      switch output {
      case .send(let command, let generation):
        guard let data = try? encoder.encode(command) else { continue }
        do {
          try await connection.send(data, generation: generation)
        } catch {
          // A message that never left goes back to its input (SPEC-0005 "MP4b 定的细节").
          if let message = Self.messageId(of: command) {
            core.notWritten(message)
            saveDrafts()
          }
        }
      case .markSynced(let generation):
        await connection.markSynced(generation: generation)
      }
    }
  }

  /// The message a command sends, if it sends one.
  ///
  /// - Remark: `prompt` and `steer` carry the message's request id; an upload its own, which the
  ///   core maps to its message.
  /// - SideEffects: none
  /// - Parameter command: The command.
  /// - Returns: The request id.
  private static func messageId(of command: Command) -> RequestId? {
    switch command {
    case .prompt(let prompt): prompt.requestId
    case .steer(let steer): steer.requestId
    case .uploadAttachment(let upload): upload.requestId
    default: nil
    }
  }

  #if DEBUG
    /// Replaces the core and the status with ready-made ones, for the design gallery.
    ///
    /// - Remark: Debug builds only. The gallery has no Mac to sync with, so it feeds a core the host
    ///   JSON itself and puts it here; the connection is never started, so nothing is sent.
    /// - SideEffects: Replaces the core and the status.
    /// - Parameters:
    ///   - core: The core, already synced.
    ///   - status: How the connection stands.
    func adopt(core: SyncCore, status: ConnectionStatus) {
      self.core = core
      self.status = status
    }
  #endif

  /// Queues outputs for ``carryOut()``.
  ///
  /// - Remark: The queue keeps every output; nothing is dropped.
  /// - SideEffects: Yields to the queue.
  /// - Parameter outputs: The outputs, in order.
  private func enqueue(_ outputs: [SyncOutput]) {
    for output in outputs { queue.yield(output) }
  }
}
