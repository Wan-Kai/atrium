import AtriumProtocol
import Foundation

/// What the sync asks of the connection it is driven by.
///
/// - Remark: Each carries the generation it is for, so a connection that has since been replaced
///   refuses it (``SyncCore``).
public enum SyncOutput: Sendable, Equatable {
  /// Send a command on that connection.
  case send(Command, generation: Int)
  /// The connection's first sync is complete: "正在同步" becomes "已连接".
  case markSynced(generation: Int)
}

/// The phone's list and open sessions, kept in step with the host over one connection after another.
///
/// - Remark: A value that takes what happens (a new connection, a message, a session opened or
///   closed) and says what to send, so the rules can be tested without a connection (overview.md
///   "iOS 工程": AtriumSync knows only protocol types). The rules are SPEC-0005 "MP4a 定的细节":
///   every new connection subscribes to the list without a cursor, then to the open sessions with
///   the phone's budget, and opens them so their pi start and their snapshots come. The connection
///   counts as synced once the list answered and its snapshot came, and every open session has a
///   snapshot or was refused. A new connection voids the requests of the one before; messages of
///   another connection, and answers to requests it does not know, are dropped. What is shown stays
///   until fresh snapshots replace it.
public struct SyncCore {
  /// The phone's snapshot budget: 6 turns, 512 KiB (SPEC-0005 "协议改动" 2).
  public static let snapshotBudget = SnapshotBudget(turns: 6, bytes: 512 * 1024)

  /// A request on its way, and what its answer settles.
  ///
  /// - Remark: Kept by request id until its answer comes or the connection is replaced.
  private enum Request {
    /// `subscribe_index`.
    case index
    /// `subscribe_sessions`; a failure fails these sessions.
    case sessions([SessionId])
    /// `open_session`; a failure fails the session.
    case open(SessionId)
    /// A message's `prompt`, by its own request id.
    case prompt
    /// A command whose answer settles nothing.
    case other
  }

  /// How long after it was sent a message unanswered by a dropped connection is retried, at most.
  public static let retryWindow = Duration.seconds(600)

  /// The list.
  public private(set) var index = IndexState()
  /// The open sessions' states.
  public private(set) var sessions: [SessionId: SessionState] = [:]
  /// The sessions whose pages are open, in the order they were opened.
  public private(set) var openSessions: [SessionId] = []
  /// The connection being synced; `nil` before the first.
  public private(set) var generation: Int?
  /// Whether this connection's first sync is complete.
  public private(set) var synced = false
  /// The messages sent and not yet settled, in the order sent.
  public private(set) var outbox: [Outgoing] = []
  /// What each session's input holds, kept here so a message that never left can come back to it.
  public private(set) var drafts: [SessionId: String] = [:]
  /// Why a session's last message did not go; cleared when its input changes.
  public private(set) var problems: [SessionId: SendProblem] = [:]
  /// The latest message of each session found in its transcript, by request id.
  public private(set) var lastDelivered: [SessionId: RequestId] = [:]

  private var requests: [RequestId: Request] = [:]
  private var listAnswered = false
  private var listSnapshot = false
  private let makeRequestId: () -> String
  private let makeTraceparent: () -> String
  private let now: () -> Duration
  /// When each message in the outbox was sent, and whether it was retried already.
  private var timing: [RequestId: (sentAt: Duration, retried: Bool)] = [:]

  /// Makes a sync with nothing yet.
  ///
  /// - Remark: Ids and traces come from outside: random and traced in the app, counted in tests.
  /// - SideEffects: none
  /// - Parameters:
  ///   - requestId: Makes a new request id, unique on a connection.
  ///   - traceparent: Makes the traceparent of a new command.
  ///   - now: The time since some fixed origin, for the retry window.
  public init(
    requestId: @escaping () -> String, traceparent: @escaping () -> String, now: @escaping () -> Duration
  ) {
    makeRequestId = requestId
    makeTraceparent = traceparent
    self.now = now
  }

  /// Starts syncing a connection that says it is syncing.
  ///
  /// - Remark: A new connection voids the requests of the one before. The same connection saying so
  ///   again after it was synced came back to the foreground; it is synced again from the start,
  ///   each open session dropped from the subscription and added back for a fresh snapshot
  ///   (SPEC-0005 "MP4a 定的细节" 5). An older connection, or the same one still in its first
  ///   sync, changes nothing.
  /// - SideEffects: none
  /// - Parameter generation: The connection.
  /// - Returns: The commands to send.
  public mutating func connected(generation: Int) -> [SyncOutput] {
    if let current = self.generation, generation < current || (generation == current && !synced) { return [] }
    let again = generation == self.generation
    self.generation = generation
    synced = false
    requests = [:]
    listAnswered = false
    listSnapshot = false
    // A session with a copy continues from it; one without waits for a snapshot (SPEC-0005 "MP4c 定的细节").
    var points: [ResumePoint] = []
    for sessionId in openSessions {
      if let point = sessions[sessionId]?.resumePoint {
        points.append(point)
        sessions[sessionId]?.beginResume()
      } else {
        sessions[sessionId]?.reload()
      }
    }
    let cursor = index.ready ? SubscribeIndexCommand.Cursor(generation: index.generation, seq: index.seq) : nil
    var outputs = [
      send(
        .subscribeIndex(
          SubscribeIndexCommand(requestId: track(.index), traceparent: makeTraceparent(), cursor: cursor)))
    ]
    if !openSessions.isEmpty {
      if again { outputs.append(subscribe([], failing: [])) }
      outputs.append(subscribe(openSessions, failing: openSessions, resume: points))
      for sessionId in openSessions { outputs.append(open(sessionId)) }
    }
    return outputs
  }

  /// Takes one message from the host.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - message: The message.
  ///   - generation: The connection it came on.
  /// - Returns: What to send, and whether the connection is now synced.
  public mutating func receive(_ message: HostMessage, generation: Int) -> [SyncOutput] {
    guard generation == self.generation else { return [] }
    var outputs: [SyncOutput] = []
    switch message {
    case .responseMessage(.success(let success)):
      switch requests.removeValue(forKey: success.requestId) {
      case .index?: listAnswered = true
      case .prompt?: answered(success.requestId, disposition: Self.disposition(success.result))
      default: break
      }
    case .responseMessage(.failure(let failure)):
      guard let requestId = failure.requestId, let request = requests.removeValue(forKey: requestId) else { break }
      switch request {
      case .index: break
      case .sessions(let failing):
        for sessionId in failing { fail(sessionId, failure.error.code) }
      case .open(let sessionId): fail(sessionId, failure.error.code)
      case .prompt: refused(requestId, failure.error.code)
      case .other: break
      }
    case .indexSnapshot(let snapshot):
      index.apply(snapshot)
      listSnapshot = true
      noteHandedOff()
    case .indexChanges(let changes):
      index.apply(changes)
      // With a cursor the host answers with changes, maybe none, instead of a snapshot.
      listSnapshot = true
      noteHandedOff()
    case .sessionEvent(let event):
      outputs += take(event)
    default: break
    }
    return outputs + checkSynced()
  }

  /// Opens a session's page.
  ///
  /// - Remark: It waits for its own snapshot, or, from a cached copy, resumes from it; a connection
  ///   already synced stays so (SPEC-0005 "MP4a 定的细节" 5, "MP4c 定的细节"). Without a connection
  ///   it is only recorded, and the next one opens it.
  /// - SideEffects: none
  /// - Parameters:
  ///   - sessionId: The session.
  ///   - cached: Its copy from the last launch, if any.
  /// - Returns: The commands to send.
  public mutating func open(_ sessionId: SessionId, cached: CachedSession? = nil) -> [SyncOutput] {
    guard !openSessions.contains(sessionId) else { return [] }
    openSessions.append(sessionId)
    var state = cached.map(SessionState.init(cached:)) ?? SessionState(sessionId: sessionId)
    guard generation != nil else {
      sessions[sessionId] = state
      return []
    }
    let points = state.resumePoint.map { [$0] } ?? []
    state.beginResume()
    sessions[sessionId] = state
    return [subscribe(openSessions, failing: [sessionId], resume: points), open(sessionId)]
  }

  /// Takes the list and drafts cached at the last launch.
  ///
  /// - Remark: Before any connection; the list shows as "不是最新" until synced.
  /// - SideEffects: none
  /// - Parameters:
  ///   - cached: The cached list, if any.
  ///   - drafts: The cached inputs.
  public mutating func restore(index cached: CachedIndex?, drafts: [SessionId: String]) {
    if let cached, !index.ready { index = IndexState(cached: cached) }
    for (sessionId, text) in drafts where self.drafts[sessionId] == nil { self.drafts[sessionId] = text }
  }

  /// Whether what is shown may be out of date: there is a list, and this connection has not synced.
  public var stale: Bool { index.ready && !synced }

  /// Closes a session's page: stops watching it, closes the phone's tab of it and forgets its state.
  ///
  /// - Remark: A connection still syncing may be synced once the session no longer counts. The
  ///   page's requests on their way no longer settle anything, so a late answer cannot touch the page
  ///   if it is opened again; closing the tab lets the Mac reclaim the session's controller. Its
  ///   unsettled messages stay in the outbox, still answered, retried and shown when it is opened again.
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  /// - Returns: The commands to send, and whether the connection is now synced.
  public mutating func close(_ sessionId: SessionId) -> [SyncOutput] {
    guard let position = openSessions.firstIndex(of: sessionId) else { return [] }
    openSessions.remove(at: position)
    sessions[sessionId] = nil
    for (requestId, request) in requests {
      switch request {
      case .open(let opened) where opened == sessionId: requests[requestId] = .other
      case .sessions(let failing) where failing.contains(sessionId):
        requests[requestId] = .sessions(failing.filter { $0 != sessionId })
      default: break
      }
    }
    guard generation != nil else { return [] }
    let watching = subscribe(openSessions, failing: [])
    let tab = send(
      .closeTab(CloseTabCommand(requestId: track(.other), traceparent: makeTraceparent(), sessionId: sessionId)))
    return [watching, tab] + checkSynced()
  }

  /// Whether a session's input may be sent now.
  ///
  /// - Remark: SPEC-0005 "MP4b 定的细节": the connection synced, the session up to date, and no
  ///   message of the session still sending or uncertain ("上一条还没确认"). An empty input is
  ///   ``send(_:)``'s to refuse.
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  /// - Returns: Whether the send button works.
  public func canSend(_ sessionId: SessionId) -> Bool {
    guard synced, let state = sessions[sessionId], state.status == .ready, state.settled else { return false }
    return !outbox.contains { $0.sessionId == sessionId && $0.state != .accepted }
  }

  /// Changes what a session's input holds.
  ///
  /// - Remark: Typing again clears why the last message did not go.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The input.
  ///   - sessionId: The session.
  public mutating func setDraft(_ text: String, for sessionId: SessionId) {
    drafts[sessionId] = text.isEmpty ? nil : text
    problems[sessionId] = nil
  }

  /// Sends a session's input as a message, if it may be sent.
  ///
  /// - Remark: A new random request id, which is also the message's `clientMessageId`; it shows as
  ///   sending until answered.
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  /// - Returns: The command to send.
  public mutating func send(_ sessionId: SessionId) -> [SyncOutput] {
    guard canSend(sessionId), let text = drafts[sessionId],
      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return [] }
    drafts[sessionId] = nil
    problems[sessionId] = nil
    return [post(text, to: sessionId)]
  }

  /// Sends an uncertain message again, as a new message.
  ///
  /// - Remark: "没能确认是否送到 · 重发": the user decided; a new request id, so the host runs it.
  /// - SideEffects: none
  /// - Parameter requestId: The uncertain message.
  /// - Returns: The command to send.
  public mutating func resend(_ requestId: RequestId) -> [SyncOutput] {
    guard synced, let message = outbox.first(where: { $0.id == requestId && $0.state == .uncertain }) else {
      return []
    }
    drop(requestId)
    return [post(message.text, to: message.sessionId)]
  }

  /// Takes back a message that never left: the connection was gone when it was to be written.
  ///
  /// - Remark: Its text goes back in front of what the input holds now; "没发出去". A retry that
  ///   could not be written leaves the first sending, which may have run: it is uncertain instead.
  /// - SideEffects: none
  /// - Parameter requestId: The message.
  public mutating func notWritten(_ requestId: RequestId) {
    guard let index = outbox.firstIndex(where: { $0.id == requestId }), outbox[index].state == .sending else {
      return
    }
    requests[requestId] = nil
    if timing[requestId]?.retried == true {
      outbox[index].state = .uncertain
      return
    }
    let message = outbox[index]
    drop(requestId)
    giveBack(message, .notSent)
  }

  /// Records a message and makes its `prompt`.
  ///
  /// - Remark: See ``send(_:)``.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The text.
  ///   - sessionId: The session.
  /// - Returns: The output.
  private mutating func post(_ text: String, to sessionId: SessionId) -> SyncOutput {
    let requestId = makeRequestId()
    outbox.append(Outgoing(id: requestId, sessionId: sessionId, text: text, state: .sending))
    timing[requestId] = (now(), false)
    return prompt(requestId)
  }

  /// The `prompt` of a message in the outbox, for its first sending or its one retry.
  ///
  /// - Remark: The same request id both times (SPEC-0005 "协议改动" 4).
  /// - SideEffects: none
  /// - Parameter requestId: The message.
  /// - Returns: The output.
  private mutating func prompt(_ requestId: RequestId) -> SyncOutput {
    let message = outbox.first { $0.id == requestId }
    requests[requestId] = .prompt
    return send(
      .prompt(
        PromptCommand(
          requestId: requestId, traceparent: makeTraceparent(), sessionId: message?.sessionId ?? "",
          text: message?.text ?? "")))
  }

  /// Takes the host's answer to a message.
  ///
  /// - Remark: Started: kept until its turn shows. Handled or queued: settled.
  /// - SideEffects: none
  /// - Parameters:
  ///   - requestId: The message.
  ///   - disposition: What the host did with it.
  private mutating func answered(_ requestId: RequestId, disposition: String?) {
    guard let index = outbox.firstIndex(where: { $0.id == requestId }) else { return }
    if disposition == "started" {
      outbox[index].state = .accepted
      settleDelivered(in: outbox[index].sessionId)
    } else {
      drop(requestId)
    }
  }

  /// Takes the host's refusal of a message.
  ///
  /// - Remark: `outcome_unknown` and `request_conflict` cannot say whether it went: the transcript
  ///   decides, else it is uncertain. Anything else did not run, so the text goes back.
  /// - SideEffects: none
  /// - Parameters:
  ///   - requestId: The message.
  ///   - code: Why.
  private mutating func refused(_ requestId: RequestId, _ code: ErrorCode) {
    guard let index = outbox.firstIndex(where: { $0.id == requestId }) else { return }
    let message = outbox[index]
    if code == .outcomeUnknown || code == .requestConflict {
      if delivered(message) { arrived(message) } else { outbox[index].state = .uncertain }
      return
    }
    drop(requestId)
    giveBack(message, .refused(code))
  }

  /// Settles a session's messages whose turns are in its transcript.
  ///
  /// - Remark: The turn's `clientMessageId` is the message's request id.
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  private mutating func settleDelivered(in sessionId: SessionId) {
    for message in outbox where message.sessionId == sessionId && delivered(message) { arrived(message) }
  }

  /// Settles the outbox after a connection's sync: retries once what the last one left unanswered.
  ///
  /// - Remark: SPEC-0005 "MP4b 定的细节": accepted messages are settled; one still sending is in the
  ///   new snapshot, or retried with its own id if it was sent less than ``retryWindow`` ago and
  ///   never retried, or uncertain.
  /// - SideEffects: none
  /// - Returns: The retries to send.
  private mutating func settleAfterSync() -> [SyncOutput] {
    var outputs: [SyncOutput] = []
    for message in outbox {
      if delivered(message) {
        arrived(message)
        continue
      }
      if message.state == .accepted {
        drop(message.id)
        continue
      }
      guard message.state == .sending, let sent = timing[message.id] else { continue }
      if !sent.retried, now() - sent.sentAt < Self.retryWindow {
        timing[message.id] = (sent.sentAt, true)
        outputs.append(prompt(message.id))
      } else if let index = outbox.firstIndex(where: { $0.id == message.id }) {
        outbox[index].state = .uncertain
      }
    }
    return outputs
  }

  /// Whether a message's turn is in its session's transcript.
  ///
  /// - Remark: Only what the phone holds: the latest snapshot and the events after it.
  /// - SideEffects: none
  /// - Parameter message: The message.
  /// - Returns: Whether it was delivered.
  private func delivered(_ message: Outgoing) -> Bool {
    sessions[message.sessionId]?.items.contains {
      if case .turn(let turn) = $0 { return turn.user.clientMessageId == message.id }
      return false
    } ?? false
  }

  /// Settles a message found in its session's transcript.
  ///
  /// - Remark: Remembered as the session's latest delivered message.
  /// - SideEffects: none
  /// - Parameter message: The message.
  private mutating func arrived(_ message: Outgoing) {
    lastDelivered[message.sessionId] = message.id
    drop(message.id)
  }

  /// Removes a message from the outbox.
  ///
  /// - Remark: With its timing.
  /// - SideEffects: none
  /// - Parameter requestId: The message.
  private mutating func drop(_ requestId: RequestId) {
    outbox.removeAll { $0.id == requestId }
    timing[requestId] = nil
  }

  /// Puts a message that did not go back in front of its session's input.
  ///
  /// - Remark: So nothing typed meanwhile is lost.
  /// - SideEffects: none
  /// - Parameters:
  ///   - message: The message.
  ///   - problem: Why it did not go.
  private mutating func giveBack(_ message: Outgoing, _ problem: SendProblem) {
    let typed = drafts[message.sessionId] ?? ""
    drafts[message.sessionId] = typed.isEmpty ? message.text : "\(message.text)\n\(typed)"
    problems[message.sessionId] = problem
  }

  /// The disposition in a `prompt` result.
  ///
  /// - Remark: `nil` for a result without one.
  /// - SideEffects: none
  /// - Parameter result: The result.
  /// - Returns: The disposition.
  private static func disposition(_ result: JSONValue?) -> String? {
    guard case .object(let fields)? = result, case .string(let value)? = fields["disposition"] else { return nil }
    return value
  }

  /// Applies a session event, resubscribing when it does not follow on.
  ///
  /// - Remark: The host sends snapshots only for sessions newly subscribed, so the session is
  ///   dropped from the set and added again, as `packages/client` does.
  /// - SideEffects: none
  /// - Parameter event: The event.
  /// - Returns: The commands to send.
  private mutating func take(_ event: SessionEvent) -> [SyncOutput] {
    let sessionId = event.sessionId
    guard var state = sessions[sessionId] else { return [] }
    let outcome = state.apply(event)
    guard outcome == .resync else {
      sessions[sessionId] = state
      settleDelivered(in: sessionId)
      return []
    }
    state.reload()
    sessions[sessionId] = state
    return [
      subscribe(openSessions.filter { $0 != sessionId }, failing: []),
      subscribe(openSessions, failing: [sessionId]),
    ]
  }

  /// Marks open sessions handed to a terminal as settled while they wait for a snapshot.
  ///
  /// - Remark: The Mac starts no pi for such a session, so no snapshot would come (SPEC-0005
  ///   "MP4a 定的细节" 3).
  /// - SideEffects: none
  private mutating func noteHandedOff() {
    for summary in index.sessions where summary.handedOff && openSessions.contains(summary.sessionId) {
      sessions[summary.sessionId]?.markHandedOff()
    }
  }

  /// Marks an open session as refused.
  ///
  /// - Remark: A session closed meanwhile is left alone.
  /// - SideEffects: none
  /// - Parameters:
  ///   - sessionId: The session.
  ///   - code: Why.
  private mutating func fail(_ sessionId: SessionId, _ code: ErrorCode) {
    sessions[sessionId]?.fail(code)
  }

  /// Says the connection is synced, the first time it is.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Returns: `markSynced` once, else nothing.
  private mutating func checkSynced() -> [SyncOutput] {
    guard let generation, !synced, listAnswered, listSnapshot else { return [] }
    guard openSessions.allSatisfy({ sessions[$0]?.settled == true }) else { return [] }
    synced = true
    return [.markSynced(generation: generation)] + settleAfterSync()
  }

  /// `subscribe_sessions` with the phone's budget.
  ///
  /// - Remark: The whole set every time, as the command replaces the previous one.
  /// - SideEffects: none
  /// - Parameters:
  ///   - sessionIds: Every session to watch.
  ///   - failing: The sessions a failure of it fails.
  ///   - resume: Where open sessions' copies end, to continue from.
  /// - Returns: The output.
  private mutating func subscribe(
    _ sessionIds: [SessionId], failing: [SessionId], resume: [ResumePoint] = []
  ) -> SyncOutput {
    send(
      .subscribeSessions(
        SubscribeSessionsCommand(
          requestId: track(.sessions(failing)), traceparent: makeTraceparent(), sessionIds: sessionIds,
          snapshot: Self.snapshotBudget, resume: resume.isEmpty ? nil : resume)))
  }

  /// `open_session`.
  ///
  /// - Remark: Starts the session's pi if it is not running, so its snapshot comes.
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  /// - Returns: The output.
  private mutating func open(_ sessionId: SessionId) -> SyncOutput {
    send(
      .openSession(
        OpenSessionCommand(requestId: track(.open(sessionId)), traceparent: makeTraceparent(), sessionId: sessionId)))
  }

  /// Records a request on its way.
  ///
  /// - Remark: Its answer is matched by the id.
  /// - SideEffects: none
  /// - Parameter request: What it is.
  /// - Returns: Its new id.
  private mutating func track(_ request: Request) -> RequestId {
    let requestId = makeRequestId()
    requests[requestId] = request
    return requestId
  }

  /// A command for the current connection.
  ///
  /// - Remark: Only called with a connection.
  /// - SideEffects: none
  /// - Parameter command: The command.
  /// - Returns: The output.
  private func send(_ command: Command) -> SyncOutput {
    .send(command, generation: generation ?? 0)
  }
}
