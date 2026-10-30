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
  /// The phone's snapshot budget: 3 turns, 256 KiB; older ones come on scrolling up (SPEC-0005
  /// "MP4a 定的细节" 9).
  public static let snapshotBudget = SnapshotBudget(turns: 3, bytes: 256 * 1024)

  /// How many items, and bytes at most, one scroll to the top fetches (SPEC-0005 "MP4a 定的细节" 9).
  public static let olderBatch = (items: 3, bytes: 256 * 1024)

  /// The sessions with a `fetch_transcript` for older items on its way.
  public private(set) var loadingOlder: Set<SessionId> = []

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
    /// A message's `prompt` or `steer`, by its own request id.
    case prompt
    /// One of a message's images, by the message's id and the image's place.
    case upload(RequestId, Int)
    /// An action on a session, whose failure is shown.
    case action(SessionId, SessionAction)
    /// `clear_attention` of a session.
    case clearing(SessionId)
    /// `list_models`, whose answer is the catalog.
    case models
    /// `create_session` or `create_chat` of a new session, and what to send once it is made.
    case start(ContainerId?, String, [OutgoingImage])
    /// `fetch_transcript` for the items before `before`, from `epoch`.
    case older(SessionId, epoch: Int, before: String)
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
  /// The images each session's input holds.
  public private(set) var draftImages: [SessionId: [OutgoingImage]] = [:]
  /// Why a session's last message did not go; cleared when its input changes.
  public private(set) var problems: [SessionId: SendProblem] = [:]
  /// The latest message of each session found in its transcript, by request id.
  public private(set) var lastDelivered: [SessionId: RequestId] = [:]
  /// Why the last action on a session failed.
  public private(set) var actionProblems: [SessionId: ActionProblem] = [:]
  /// The workspaces whose changes are watched, as last asked.
  public private(set) var watchedChanges: [WorkspaceId] = []
  /// The latest changes of each watched workspace.
  public private(set) var changes: [WorkspaceId: ChangesUpdatedEvent] = [:]
  /// The diff the change list looks at; `nil` when none is open.
  public private(set) var diffTarget: DiffTarget?
  /// Whether a new session is being made.
  public private(set) var starting = false
  /// The session the last start made; the new-session page turns into its page.
  public private(set) var started: SessionId?
  /// Why the last start failed, if it did.
  public private(set) var startFailure: ErrorCode?
  /// The workspaces the Mac could not find when a session was started in them, on this connection.
  public private(set) var missingContainers: Set<ContainerId> = []
  /// The model catalog of ``modelsWorkspace``, with the default model; `nil` until its answer.
  public private(set) var models: ListModelsResult?
  /// The workspace the catalog is for (`nil` for a chat's), the one last asked about.
  public private(set) var modelsWorkspace: WorkspaceId?
  /// The latest `list_models`; an older answer is dropped.
  private var modelsRequest: RequestId?
  /// The latest diff of ``diffTarget``.
  public private(set) var diff: DiffUpdatedEvent?

  private var requests: [RequestId: Request] = [:]
  private var listAnswered = false
  private var listSnapshot = false
  private let makeRequestId: () -> String
  private let makeTraceparent: () -> String
  private let now: () -> Duration
  /// When each message in the outbox was sent, and whether it was retried already.
  private var timing: [RequestId: (sentAt: Duration, retried: Bool)] = [:]
  /// The images of each message in the outbox that has any.
  private var images: [RequestId: [OutgoingImage]] = [:]
  /// The attachment ids the host gave a message's images on this connection, in order.
  private var attachments: [RequestId: [String?]] = [:]

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
    loadingOlder = []
    // The mark lasts for one connection: the folder may be back (SPEC-0005 "MP6 定的细节 · MP6d").
    if !again {
      missingContainers = []
      startFailure = nil
    }
    // A start whose answer was lost may or may not have made its session; the list will show it.
    if starting {
      starting = false
      startFailure = .outcomeUnknown
    }
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
    // The host forgets a connection's watches with it (SPEC-0005 "MP6 定的细节 · MP6a").
    if let diffTarget { outputs.append(watchDiffCommand(diffTarget)) }
    if !watchedChanges.isEmpty { outputs.append(watchChangesCommand(watchedChanges)) }
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
      case .start(_, let text, let pictures)?:
        starting = false
        if case .object(let fields)? = success.result, case .string(let sessionId)? = fields["sessionId"] {
          started = sessionId
          outputs += open(sessionId) + post(text, to: sessionId, kind: .prompt, images: pictures)
        }
      case .models? where success.requestId == modelsRequest:
        if let result = success.result, let data = try? JSONEncoder().encode(result) {
          models = (try? JSONDecoder().decode(ListModelsResult.self, from: data)) ?? models
        }
      case .upload(let message, let place)?:
        outputs += uploaded(message, place: place, attachmentId: Self.attachmentId(success.result))
      case .older(let sessionId, let epoch, let before)?:
        loadingOlder.remove(sessionId)
        if let result = success.result, let data = try? JSONEncoder().encode(result),
          let older = try? JSONDecoder().decode(FetchTranscriptResult.self, from: data)
        {
          sessions[sessionId]?.prependOlder(older.items, hasOlder: older.hasOlder, epoch: epoch, before: before)
        }
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
      case .upload(let message, _):
        // The retry's upload failing says nothing of the first sending, which may have run.
        if timing[message]?.retried == true, let index = outbox.firstIndex(where: { $0.id == message }) {
          outbox[index].state = .uncertain
        } else {
          refused(message, failure.error.code)
        }
      case .action(let sessionId, let action):
        actionProblems[sessionId] = ActionProblem(action: action, code: failure.error.code)
      case .start(let container, _, _):
        starting = false
        startFailure = failure.error.code
        // There is no field for a workspace's folder being gone; a start finds out (SPEC-0005 "MP6 定的细节 · MP6d").
        if let container, failure.error.code == .workspaceNotFound || failure.error.code == .sessionCwdMissing {
          missingContainers.insert(container)
        }
      case .older(let sessionId, _, _): loadingOlder.remove(sessionId)
      case .clearing, .models, .other: break
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
    case .changesUpdated(let updated) where watchedChanges.contains(updated.workspaceId):
      changes[updated.workspaceId] = updated
    case .diffUpdated(let updated)
    where diffTarget == DiffTarget(workspaceId: updated.workspaceId, mode: updated.mode):
      diff = updated
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
    loadingOlder.remove(sessionId)
    for (requestId, request) in requests {
      switch request {
      case .open(let opened) where opened == sessionId: requests[requestId] = .other
      case .action(let acted, _) where acted == sessionId: requests[requestId] = .other
      case .older(let loading, _, _) where loading == sessionId: requests[requestId] = .other
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

  /// Changes the images a session's input holds.
  ///
  /// - Remark: Picking or removing an image clears why the last message did not go.
  /// - SideEffects: none
  /// - Parameters:
  ///   - images: The images.
  ///   - sessionId: The session.
  public mutating func setDraftImages(_ images: [OutgoingImage], for sessionId: SessionId) {
    draftImages[sessionId] = images.isEmpty ? nil : images
    problems[sessionId] = nil
  }

  /// Sends a session's input as a message, if it may be sent.
  ///
  /// - Remark: A new random request id, which is also the message's `clientMessageId`; it shows as
  ///   sending until answered. As a `prompt` it is sent now when idle and queued on the host while
  ///   a run goes on; as a `steer` ("立即插话") it reaches pi before its next step. While the agent
  ///   asks a question it always goes as a steer, which answers the question.
  /// - SideEffects: none
  /// - Parameters:
  ///   - sessionId: The session.
  ///   - steer: Whether to send it as a steer.
  /// - Returns: The command to send.
  public mutating func send(_ sessionId: SessionId, steer: Bool = false) -> [SyncOutput] {
    let text = drafts[sessionId] ?? ""
    let pictures = draftImages[sessionId] ?? []
    guard canSend(sessionId), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pictures.isEmpty
    else { return [] }
    drafts[sessionId] = nil
    draftImages[sessionId] = nil
    problems[sessionId] = nil
    // A reply while the agent asks goes in as a steer and answers it (SPEC-0003, SPEC-0005 "MP5 定的细节").
    let asking = sessions[sessionId]?.control?.question != nil
    return post(text, to: sessionId, kind: steer || asking ? .steer : .prompt, images: pictures)
  }

  /// Asks something of a session's run: stop it, act on its queue, retry, let deliveries go.
  ///
  /// - Remark: Only once synced and with the session open. Taking an action clears why the last
  ///   one failed; a failure is kept in ``actionProblems``.
  /// - SideEffects: none
  /// - Parameters:
  ///   - action: The action.
  ///   - sessionId: The session.
  /// - Returns: The command to send.
  public mutating func perform(_ action: SessionAction, in sessionId: SessionId) -> [SyncOutput] {
    guard synced, openSessions.contains(sessionId) else { return [] }
    actionProblems[sessionId] = nil
    let requestId = track(.action(sessionId, action))
    let trace = makeTraceparent()
    let command: Command =
      switch action {
      case .stop: .stop(StopCommand(requestId: requestId, traceparent: trace, sessionId: sessionId))
      case .resumeQueue:
        .resumeQueue(ResumeQueueCommand(requestId: requestId, traceparent: trace, sessionId: sessionId))
      case .clearQueue: .clearQueue(ClearQueueCommand(requestId: requestId, traceparent: trace, sessionId: sessionId))
      case .removeQueued(let item):
        .removeQueued(RemoveQueuedCommand(requestId: requestId, traceparent: trace, sessionId: sessionId, itemId: item))
      case .steerQueued(let item):
        .steerQueued(SteerQueuedCommand(requestId: requestId, traceparent: trace, sessionId: sessionId, itemId: item))
      case .updateQueued(let item, let text):
        .updateQueued(
          UpdateQueuedCommand(requestId: requestId, traceparent: trace, sessionId: sessionId, itemId: item, text: text))
      case .retryRun: .retryRun(RetryRunCommand(requestId: requestId, traceparent: trace, sessionId: sessionId))
      case .resumeDeliveries:
        .resumeDeliveries(
          ResumeDeliveriesCommand(requestId: requestId, traceparent: trace, sessionId: sessionId, tree: false))
      case .answerQuestion(let question, let reply):
        .answerQuestion(
          AnswerQuestionCommand(
            requestId: requestId, traceparent: trace, sessionId: sessionId, questionId: question, answer: reply))
      case .setModel(let model):
        .setModel(
          SetModelCommand(
            requestId: requestId, traceparent: trace, sessionId: sessionId, providerId: model.providerId,
            modelId: model.modelId))
      case .setThinkingLevel(let level):
        .setThinkingLevel(
          SetThinkingLevelCommand(requestId: requestId, traceparent: trace, sessionId: sessionId, level: level))
      case .setFast(let enabled):
        .setFast(SetFastCommand(requestId: requestId, traceparent: trace, sessionId: sessionId, enabled: enabled))
      case .answerInteraction(let interaction, let answer):
        .answerInteraction(
          AnswerInteractionCommand(
            requestId: requestId, traceparent: trace, sessionId: sessionId, interactionId: interaction, answer: answer))
      }
    return [send(command)]
  }

  /// Starts a new session with its first message: in a workspace, or as a new chat.
  ///
  /// - Remark: SPEC-0005 "MP6 定的细节 · MP6d": `create_session` (or `create_chat`), then, once its
  ///   id is back, the session is opened and the message sent with its receipt (images uploaded
  ///   first). One start at a time, only once synced, and only with something to send.
  /// - SideEffects: none
  /// - Parameters:
  ///   - container: The workspace; ignored for a chat.
  ///   - chat: Whether to start a new chat instead.
  ///   - text: The first message.
  ///   - pictures: Its images.
  /// - Returns: The command to send.
  public mutating func startSession(
    in container: ContainerId?, chat: Bool, text: String, images pictures: [OutgoingImage]
  ) -> [SyncOutput] {
    guard synced, !starting, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pictures.isEmpty
    else { return [] }
    let place: ContainerId? = chat ? nil : container
    guard chat || place != nil else { return [] }
    starting = true
    started = nil
    startFailure = nil
    let requestId = track(.start(place, text, pictures))
    if let place {
      return [
        send(
          .createSession(CreateSessionCommand(requestId: requestId, traceparent: makeTraceparent(), containerId: place))
        )
      ]
    }
    return [send(.createChat(CreateChatCommand(requestId: requestId, traceparent: makeTraceparent())))]
  }

  /// Asks for the models a workspace's sessions can use, or for a chat's with `nil`.
  ///
  /// - Remark: The model sheet (SPEC-0005 "MP6 定的细节 · MP6c"); the answer replaces ``models``.
  ///   Only once synced. Asking about another place drops the catalog at once, and only the latest
  ///   ask's answer is kept, so a catalog is never shown for the wrong place (the MP6 review).
  /// - SideEffects: none
  /// - Parameters:
  ///   - workspaceId: The workspace, or `nil`.
  ///   - refresh: Whether pi should list them again instead of answering from its cache.
  /// - Returns: The command to send.
  public mutating func listModels(workspaceId: WorkspaceId?, refresh: Bool) -> [SyncOutput] {
    guard synced else { return [] }
    if workspaceId != modelsWorkspace { models = nil }
    modelsWorkspace = workspaceId
    let requestId = track(.models)
    modelsRequest = requestId
    return [
      send(
        .listModels(
          ListModelsCommand(
            requestId: requestId, traceparent: makeTraceparent(), workspaceId: workspaceId,
            refresh: refresh ? true : nil)))
    ]
  }

  /// Asks the Mac for the items before the earliest one an open session has.
  ///
  /// - Remark: SPEC-0005 "MP4a 定的细节" 9: when the page's top row shows, only after the sync, only
  ///   when older items exist, one at a time per session.
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  /// - Returns: The command to send, or nothing.
  public mutating func loadOlder(_ sessionId: SessionId) -> [SyncOutput] {
    guard synced, !loadingOlder.contains(sessionId), let state = sessions[sessionId], state.hasOlder,
      let before = state.items.first?.id
    else { return [] }
    loadingOlder.insert(sessionId)
    let requestId = track(.older(sessionId, epoch: state.epoch, before: before))
    return [
      send(
        .fetchTranscript(
          FetchTranscriptCommand(
            requestId: requestId, traceparent: makeTraceparent(), sessionId: sessionId, epoch: state.epoch,
            before: before, limit: Self.olderBatch.items, maxBytes: Self.olderBatch.bytes)))
    ]
  }

  /// Watches the changes of the workspaces shown.
  ///
  /// - Remark: SPEC-0005 "MP6 定的细节 · MP6a": the whole set each time, as the command replaces
  ///   the last; the same set again sends nothing. Without a connection it is only recorded.
  /// - SideEffects: none
  /// - Parameter workspaceIds: The workspaces, at most 64.
  /// - Returns: The command to send.
  public mutating func watchChanges(_ workspaceIds: [WorkspaceId]) -> [SyncOutput] {
    let wanted = Array(workspaceIds.prefix(64))
    guard Set(wanted) != Set(watchedChanges) else { return [] }
    watchedChanges = wanted
    changes = changes.filter { wanted.contains($0.key) }
    return generation == nil ? [] : [watchChangesCommand(wanted)]
  }

  /// Opens the change list's diff, or closes it with `nil`.
  ///
  /// - Remark: One at a time; a new target drops the diff shown until its own comes.
  /// - SideEffects: none
  /// - Parameter target: The workspace and mode, or `nil`.
  /// - Returns: The command to send.
  public mutating func watchDiff(_ target: DiffTarget?) -> [SyncOutput] {
    guard target != diffTarget else { return [] }
    diffTarget = target
    diff = nil
    return generation == nil ? [] : [watchDiffCommand(target)]
  }

  /// `watch_changes`.
  ///
  /// - Remark: Its answer settles nothing.
  /// - SideEffects: none
  /// - Parameter workspaceIds: The workspaces.
  /// - Returns: The output.
  private mutating func watchChangesCommand(_ workspaceIds: [WorkspaceId]) -> SyncOutput {
    send(
      .watchChanges(
        WatchChangesCommand(requestId: track(.other), traceparent: makeTraceparent(), workspaceIds: workspaceIds)))
  }

  /// `watch_diff`.
  ///
  /// - Remark: Its answer settles nothing.
  /// - SideEffects: none
  /// - Parameter target: The target, or `nil`.
  /// - Returns: The output.
  private mutating func watchDiffCommand(_ target: DiffTarget?) -> SyncOutput {
    send(.watchDiff(WatchDiffCommand(requestId: track(.other), traceparent: makeTraceparent(), target: target)))
  }

  /// Forgets why the last action on a session failed.
  ///
  /// - Remark: When its toast is dismissed.
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  public mutating func dismissActionProblem(in sessionId: SessionId) {
    actionProblems[sessionId] = nil
  }

  /// Clears a session's error once its page shows it, as the desktop does.
  ///
  /// - Remark: SPEC-0005 "MP5 定的细节 · MP5b": only an uncleared `error`, not `auth`, and once
  ///   while a request for it is on its way.
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  /// - Returns: The command to send, if any.
  public mutating func clearAttention(_ sessionId: SessionId) -> [SyncOutput] {
    guard synced, let summary = index.sessions.first(where: { $0.sessionId == sessionId }),
      let attention = summary.attention, attention.reason == .error, !attention.cleared,
      !requests.values.contains(where: { if case .clearing(sessionId) = $0 { true } else { false } })
    else { return [] }
    return [
      send(
        .clearAttention(
          ClearAttentionCommand(
            requestId: track(.clearing(sessionId)), traceparent: makeTraceparent(), sessionId: sessionId)))
    ]
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
    let pictures = images[requestId] ?? []
    drop(requestId)
    return post(message.text, to: message.sessionId, kind: message.kind, images: pictures)
  }

  /// Takes back a message that never left: the connection was gone when it was to be written.
  ///
  /// - Remark: Its text goes back in front of what the input holds now; "没发出去". A retry that
  ///   could not be written leaves the first sending, which may have run: it is uncertain instead.
  /// - SideEffects: none
  /// - Parameter written: The message, or one of its uploads.
  public mutating func notWritten(_ written: RequestId) {
    // An upload that never left is its message never leaving.
    var requestId = written
    if case .upload(let message, _)? = requests[written] { requestId = message }
    requests[written] = nil
    guard let index = outbox.firstIndex(where: { $0.id == requestId }), outbox[index].state == .sending else {
      return
    }
    requests[requestId] = nil
    if timing[requestId]?.retried == true {
      outbox[index].state = .uncertain
      return
    }
    let message = outbox[index]
    let pictures = images[requestId] ?? []
    drop(requestId)
    giveBack(message, .notSent, images: pictures)
  }

  /// Records a message and makes its `prompt`.
  ///
  /// - Remark: See ``send(_:)``.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The text.
  ///   - sessionId: The session.
  ///   - kind: What it is sent as.
  ///   - pictures: Its images, uploaded first.
  /// - Returns: The outputs.
  private mutating func post(
    _ text: String, to sessionId: SessionId, kind: Outgoing.Kind, images pictures: [OutgoingImage]
  ) -> [SyncOutput] {
    let requestId = makeRequestId()
    outbox.append(
      Outgoing(id: requestId, sessionId: sessionId, text: text, state: .sending, kind: kind, images: pictures.count))
    timing[requestId] = (now(), false)
    guard !pictures.isEmpty else { return [prompt(requestId)] }
    images[requestId] = pictures
    return upload(requestId)
  }

  /// Uploads a message's images on this connection, forgetting ids an earlier one gave.
  ///
  /// - Remark: SPEC-0005 "MP5 定的细节 · MP5c": attachments belong to the connection they were
  ///   uploaded on, so a retry uploads them again; the message goes once every id is back.
  /// - SideEffects: none
  /// - Parameter requestId: The message.
  /// - Returns: The uploads.
  private mutating func upload(_ requestId: RequestId) -> [SyncOutput] {
    let pictures = images[requestId] ?? []
    attachments[requestId] = Array(repeating: nil, count: pictures.count)
    return pictures.enumerated().map { place, picture in
      send(
        .uploadAttachment(
          UploadAttachmentCommand(
            requestId: track(.upload(requestId, place)), traceparent: makeTraceparent(), mimeType: picture.mimeType,
            data: picture.data)))
    }
  }

  /// Takes the id the host gave one of a message's images, and sends the message once all are in.
  ///
  /// - Remark: An answer without an id cannot be used; the message then waits for the next sync.
  /// - SideEffects: none
  /// - Parameters:
  ///   - requestId: The message.
  ///   - place: The image's place.
  ///   - attachmentId: The id, if the answer had one.
  /// - Returns: The message's command, once every image is in.
  private mutating func uploaded(_ requestId: RequestId, place: Int, attachmentId: String?) -> [SyncOutput] {
    guard outbox.contains(where: { $0.id == requestId }), var ids = attachments[requestId], ids.indices.contains(place)
    else { return [] }
    ids[place] = attachmentId
    attachments[requestId] = ids
    return ids.allSatisfy { $0 != nil } ? [prompt(requestId)] : []
  }

  /// The `prompt` or `steer` of a message in the outbox, for its first sending or its one retry.
  ///
  /// - Remark: The same request id both times (SPEC-0005 "协议改动" 4).
  /// - SideEffects: none
  /// - Parameter requestId: The message.
  /// - Returns: The output.
  private mutating func prompt(_ requestId: RequestId) -> SyncOutput {
    let message = outbox.first { $0.id == requestId }
    requests[requestId] = .prompt
    let sessionId = message?.sessionId ?? ""
    let text = message?.text ?? ""
    let ids = attachments[requestId]?.compactMap { $0 }
    if message?.kind == .steer {
      return send(
        .steer(
          SteerCommand(
            requestId: requestId, traceparent: makeTraceparent(), sessionId: sessionId, text: text, attachmentIds: ids))
      )
    }
    return send(
      .prompt(
        PromptCommand(
          requestId: requestId, traceparent: makeTraceparent(), sessionId: sessionId, text: text, attachmentIds: ids)))
  }

  /// Takes the host's answer to a message.
  ///
  /// - Remark: A prompt started is kept until its turn shows; handled or queued, settled. A steer
  ///   has no turn of its own: settled once the host took it.
  /// - SideEffects: none
  /// - Parameters:
  ///   - requestId: The message.
  ///   - disposition: What the host did with it.
  private mutating func answered(_ requestId: RequestId, disposition: String?) {
    guard let index = outbox.firstIndex(where: { $0.id == requestId }) else { return }
    if disposition == "started", outbox[index].kind == .prompt {
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
    let pictures = images[requestId] ?? []
    drop(requestId)
    giveBack(message, .refused(code), images: pictures)
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
  /// - Remark: SPEC-0005 "MP4b 定的细节": accepted messages are settled once their turn shows, or
  ///   let go after ``retryWindow`` if it never does; one still sending is in the
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
        // pi may answer before its turn reaches the snapshot; the turn comes as a live event.
        if let sent = timing[message.id], now() - sent.sentAt < Self.retryWindow { continue }
        drop(message.id)
        continue
      }
      guard message.state == .sending, let sent = timing[message.id] else { continue }
      if !sent.retried, now() - sent.sentAt < Self.retryWindow {
        timing[message.id] = (sent.sentAt, true)
        outputs += images[message.id] == nil ? [prompt(message.id)] : upload(message.id)
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
    images[requestId] = nil
    attachments[requestId] = nil
  }

  /// Puts a message that did not go back in front of its session's input.
  ///
  /// - Remark: So nothing typed meanwhile is lost.
  /// - SideEffects: none
  /// - Parameters:
  ///   - message: The message.
  ///   - problem: Why it did not go.
  ///   - pictures: Its images, which go in front of those the input holds.
  private mutating func giveBack(_ message: Outgoing, _ problem: SendProblem, images pictures: [OutgoingImage] = []) {
    let typed = drafts[message.sessionId] ?? ""
    drafts[message.sessionId] = typed.isEmpty ? message.text : "\(message.text)\n\(typed)"
    problems[message.sessionId] = problem
    if !pictures.isEmpty { draftImages[message.sessionId] = pictures + (draftImages[message.sessionId] ?? []) }
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

  /// The attachment id in an `upload_attachment` result.
  ///
  /// - Remark: `nil` for a result without one.
  /// - SideEffects: none
  /// - Parameter result: The result.
  /// - Returns: The id.
  private static func attachmentId(_ result: JSONValue?) -> String? {
    guard case .object(let fields)? = result, case .string(let value)? = fields["attachmentId"] else { return nil }
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
