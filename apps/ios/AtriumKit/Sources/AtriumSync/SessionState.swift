import AtriumProtocol

/// One session as the phone holds it: the latest snapshot and the events after it.
///
/// - Remark: Mirrors `packages/client`'s `applySessionEvent` (SPEC-0005 "iOS App · 模块",
///   domain-model §7): a snapshot replaces everything; any other event must be the next one, from
///   the same epoch with the next seq, about a turn or step the state has; anything else means
///   something was missed, and the caller subscribes again for a fresh snapshot instead of
///   guessing. MP4a keeps only what the read-only page shows: the items, the run and whether pi
///   exited.
public struct SessionState: Sendable, Equatable {
  /// Where the state stands.
  ///
  /// - Remark: What the page's last line says.
  public enum Status: Sendable, Equatable {
    /// Waiting for a snapshot; what is shown, if anything, is from before.
    case loading
    /// Up to date with the host.
    case ready
    /// pi has exited; nothing more happens until it starts again.
    case exited
    /// The host refused to open or subscribe to the session.
    case failed(ErrorCode)
    /// Handed to pi in a terminal: the Mac starts no pi for it, so no snapshot comes until taken back.
    case handedOff
  }

  /// What applying an event did.
  ///
  /// - Remark: A resync is the caller's to start; the state does not know the connection.
  public enum Outcome: Sendable, Equatable {
    /// The state took it.
    case applied
    /// It changed nothing: it came before the first snapshot, or says the state is already current.
    case ignored
    /// It does not follow on; the state is unchanged and needs a fresh snapshot.
    case resync
  }

  /// The session.
  public let sessionId: SessionId
  /// Where the state stands.
  public private(set) var status = Status.loading
  /// The epoch of the latest snapshot.
  public private(set) var epoch = 0
  /// The seq of the latest event taken.
  public private(set) var seq = 0
  /// The latest snapshot's stream, for continuing later; `nil` before one.
  public private(set) var stream: String?
  /// The items, oldest first.
  public private(set) var items: [TranscriptItem] = []
  /// Whether older items exist on the host.
  public private(set) var hasOlder = false
  /// Whether a run is in progress.
  public private(set) var running = false
  /// Whether it asked to continue from its copy and waits for `session_resumed` or a snapshot.
  public private(set) var resuming = false

  /// Whether it is up to date as far as a sync can tell: settled, and not waiting to resume.
  public var settled: Bool { status != .loading && !resuming }

  /// Where its copy ends, to continue from; `nil` without a snapshot to continue.
  public var resumePoint: ResumePoint? {
    guard let stream, status == .ready || status == .exited else { return nil }
    return ResumePoint(sessionId: sessionId, stream: stream, epoch: epoch, seq: seq)
  }

  /// A session waiting for its first snapshot.
  ///
  /// - Remark: Shown as loading until the host sends one.
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  public init(sessionId: SessionId) {
    self.sessionId = sessionId
  }

  /// A session as last cached, at the position its items stand at.
  ///
  /// - Remark: Ready, or exited, with a resume point: the next sync continues from it.
  /// - SideEffects: none
  /// - Parameter cached: The cached session.
  public init(cached: CachedSession) {
    sessionId = cached.sessionId
    status = cached.exited ? .exited : .ready
    epoch = cached.epoch
    seq = cached.seq
    stream = cached.stream
    items = cached.items
    hasOlder = cached.hasOlder
  }

  /// The session to cache; `nil` without a snapshot.
  public var cached: CachedSession? {
    guard let point = resumePoint else { return nil }
    return CachedSession(
      sessionId: sessionId, stream: point.stream, epoch: point.epoch, seq: point.seq, items: items,
      hasOlder: hasOlder, exited: status == .exited)
  }

  /// Asks to continue from its copy: it keeps taking events, and waits for `session_resumed`.
  ///
  /// - Remark: SPEC-0005 "MP4c 定的细节"; only with a ``resumePoint``.
  /// - SideEffects: none
  public mutating func beginResume() {
    if resumePoint != nil { resuming = true }
  }

  /// Waits for a fresh snapshot again, keeping what is shown.
  ///
  /// - Remark: For a resync, or a new connection; events until the snapshot are part of it.
  /// - SideEffects: none
  public mutating func reload() {
    status = .loading
    resuming = false
  }

  /// Marks a session still waiting for its snapshot, or to resume, as handed to a terminal.
  ///
  /// - Remark: It counts as settled for "已连接"; a snapshot, should one come, replaces it. The Mac
  ///   starts no pi for it, so neither a snapshot nor `session_resumed` would come.
  /// - SideEffects: none
  public mutating func markHandedOff() {
    guard status == .loading || resuming else { return }
    status = .handedOff
    resuming = false
  }

  /// Marks the session as one the host would not open or subscribe to.
  ///
  /// - Remark: It counts as settled for "已连接" (SPEC-0005 "MP4a 定的细节").
  /// - SideEffects: none
  /// - Parameter code: Why.
  public mutating func fail(_ code: ErrorCode) {
    status = .failed(code)
    resuming = false
  }

  /// Applies one event from the host.
  ///
  /// - Remark: See the type. A `session_resumed` at the state's own position changes nothing;
  ///   anywhere else it asks for a resync.
  /// - SideEffects: none
  /// - Parameter event: The event.
  /// - Returns: Whether it was applied, ignored, or needs a resync.
  public mutating func apply(_ event: SessionEvent) -> Outcome {
    if case .sessionSnapshot(let snapshot) = event {
      take(snapshot)
      return .applied
    }
    guard status == .ready || status == .exited else { return .ignored }
    if case .sessionResumed(let resumed) = event {
      guard resumed.epoch == epoch, resumed.seq == seq else { return .resync }
      guard resuming else { return .ignored }
      resuming = false
      return .applied
    }
    // A channel back from the background may still deliver events the resume point already holds.
    if resuming, event.position.epoch == epoch, event.position.seq <= seq { return .ignored }
    guard event.position.epoch == epoch, event.position.seq == seq + 1 else { return .resync }
    var next = self
    next.seq += 1
    guard next.take(event) else { return .resync }
    self = next
    return .applied
  }

  /// Takes a snapshot whole.
  ///
  /// - Remark: See ``apply(_:)``.
  /// - SideEffects: none
  /// - Parameter snapshot: The snapshot.
  private mutating func take(_ snapshot: SessionSnapshotEvent) {
    status = snapshot.exited ? .exited : .ready
    resuming = false
    epoch = snapshot.epoch
    seq = snapshot.seq
    stream = snapshot.stream
    items = snapshot.items
    hasOlder = snapshot.hasOlder
    running = snapshot.run != nil
  }

  /// Applies an event that follows on.
  ///
  /// - Remark: Events that change nothing shown only move the seq on.
  /// - SideEffects: none
  /// - Parameter event: The event.
  /// - Returns: Whether the turn, step or item it names was there.
  private mutating func take(_ event: SessionEvent) -> Bool {
    switch event {
    case .runStarted: running = true
    case .runSettled: running = false
    case .turnStarted(let started): items.append(.turn(started.turn))
    case .stepAdded(let added):
      return changeTurn(added.turnId) { $0.steps.append(added.step) }
    case .stepDelta(let delta):
      return updateTurn(delta.turnId) { turn in
        guard let index = turn.steps.firstIndex(where: { $0.id == delta.stepId }) else { return false }
        switch turn.steps[index] {
        case .text(var text):
          text.text += delta.delta
          turn.steps[index] = .text(text)
        case .thinking(var thinking):
          thinking.text += delta.delta
          turn.steps[index] = .thinking(thinking)
        default: return false
        }
        return true
      }
    case .stepUpdated(let updated):
      return updateTurn(updated.turnId) { turn in
        guard let index = turn.steps.firstIndex(where: { $0.id == updated.step.id }) else { return false }
        turn.steps[index] = updated.step
        return true
      }
    case .turnFinished(let finished):
      return changeTurn(finished.turnId) { turn in
        turn.outcome = Turn.Outcome(rawValue: finished.outcome.rawValue) ?? turn.outcome
        turn.error = finished.error
        turn.durationMs = finished.durationMs
        turn.usage = finished.usage.map { Turn.Usage(input: $0.input, output: $0.output) }
        turn.changes = finished.changes
      }
    case .noticeAdded(let added):
      guard let before = added.before else {
        items.append(.notice(added.notice))
        return true
      }
      guard let index = items.firstIndex(where: { $0.id == before }) else { return false }
      items.insert(.notice(added.notice), at: index)
    case .sessionExited:
      status = .exited
      running = false
    case .controlUpdated, .promptHandled, .modelUpdated, .fastUpdated, .metricsUpdated: break
    case .sessionSnapshot, .sessionResumed: return false
    }
    return true
  }

  /// Changes the latest turn with an id.
  ///
  /// - Remark: The latest, since a rebuilt id could repeat (as `packages/client` does).
  /// - SideEffects: none
  /// - Parameters:
  ///   - id: The turn's id.
  ///   - change: Changes it; returns whether it could.
  /// - Returns: Whether there was such a turn and the change could be made.
  private mutating func updateTurn(_ id: String, _ change: (inout Turn) -> Bool) -> Bool {
    guard let index = items.lastIndex(where: { $0.id == id }), case .turn(var turn) = items[index] else {
      return false
    }
    guard change(&turn) else { return false }
    items[index] = .turn(turn)
    return true
  }

  /// Changes the latest turn with an id, in a way that always succeeds.
  ///
  /// - Remark: For events whose only failure is a missing turn.
  /// - SideEffects: none
  /// - Parameters:
  ///   - id: The turn's id.
  ///   - change: Changes it.
  /// - Returns: Whether there was such a turn.
  private mutating func changeTurn(_ id: String, _ change: (inout Turn) -> Void) -> Bool {
    updateTurn(id) { (turn: inout Turn) -> Bool in
      change(&turn)
      return true
    }
  }
}

extension SessionEvent {
  /// Where the event sits in its session's stream.
  ///
  /// - Remark: Every session event carries its epoch and seq.
  public var position: (epoch: Int, seq: Int) {
    switch self {
    case .sessionSnapshot(let event): (event.epoch, event.seq)
    case .sessionResumed(let event): (event.epoch, event.seq)
    case .runStarted(let event): (event.epoch, event.seq)
    case .runSettled(let event): (event.epoch, event.seq)
    case .turnStarted(let event): (event.epoch, event.seq)
    case .stepAdded(let event): (event.epoch, event.seq)
    case .stepDelta(let event): (event.epoch, event.seq)
    case .stepUpdated(let event): (event.epoch, event.seq)
    case .turnFinished(let event): (event.epoch, event.seq)
    case .noticeAdded(let event): (event.epoch, event.seq)
    case .sessionExited(let event): (event.epoch, event.seq)
    case .controlUpdated(let event): (event.epoch, event.seq)
    case .promptHandled(let event): (event.epoch, event.seq)
    case .modelUpdated(let event): (event.epoch, event.seq)
    case .fastUpdated(let event): (event.epoch, event.seq)
    case .metricsUpdated(let event): (event.epoch, event.seq)
    }
  }

  /// The session the event is about.
  ///
  /// - Remark: Every session event names one.
  public var sessionId: SessionId {
    switch self {
    case .sessionSnapshot(let event): event.sessionId
    case .sessionResumed(let event): event.sessionId
    case .runStarted(let event): event.sessionId
    case .runSettled(let event): event.sessionId
    case .turnStarted(let event): event.sessionId
    case .stepAdded(let event): event.sessionId
    case .stepDelta(let event): event.sessionId
    case .stepUpdated(let event): event.sessionId
    case .turnFinished(let event): event.sessionId
    case .noticeAdded(let event): event.sessionId
    case .sessionExited(let event): event.sessionId
    case .controlUpdated(let event): event.sessionId
    case .promptHandled(let event): event.sessionId
    case .modelUpdated(let event): event.sessionId
    case .fastUpdated(let event): event.sessionId
    case .metricsUpdated(let event): event.sessionId
    }
  }
}

extension TranscriptItem {
  /// The item's id, a turn's or a notice's.
  ///
  /// - Remark: Unique within a session's items, as the host keeps them.
  public var id: String {
    switch self {
    case .turn(let turn): turn.id
    case .notice(let notice): notice.id
    }
  }
}

extension Notice {
  /// The notice's id.
  ///
  /// - Remark: Every kind of notice has one.
  public var id: String {
    switch self {
    case .compacted(let notice): notice.id
    case .restarted(let notice): notice.id
    case .interaction(let notice): notice.id
    case .note(let notice): notice.id
    }
  }
}

extension Step {
  /// The step's id within its turn.
  ///
  /// - Remark: Every kind of step has one.
  public var id: String {
    switch self {
    case .thinking(let step): step.id
    case .text(let step): step.id
    case .tool(let step): step.id
    case .steer(let step): step.id
    case .agent(let step): step.id
    case .retry(let step): step.id
    case .compaction(let step): step.id
    }
  }
}
