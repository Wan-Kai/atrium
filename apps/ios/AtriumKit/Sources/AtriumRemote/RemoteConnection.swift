import AtriumNoise
import CryptoKit
import Foundation

/// The phone's link to one Mac: connect, heartbeats, reconnect, foreground and background
/// (SPEC-0005 "日常连接", "断线与恢复").
///
/// - Remark: An actor because the receive loop, the heartbeat loop, retries and the app's lifecycle
///   all touch the same state (coding-standards "Swift（手机端）"). Every connection attempt gets a
///   new generation; a callback from an older one is dropped (mobile-remote.md §7). Only a `revoked`
///   control message and `device_unknown` in handshake message 2, both authenticated by Noise,
///   delete data; WebSocket close codes only change what is shown (SPEC-0005 "撤销").
public actor RemoteConnection {
  /// Handshake, `hello` and `welcome` must finish within this.
  public static let handshakeTimeout = Duration.seconds(15)
  /// Back in front, a link that heard from the host this recently is probed instead of replaced.
  public static let probeWindow = Duration.seconds(20)
  /// How long the probe heartbeat may take.
  public static let probeTimeout = Duration.seconds(2)
  /// The longest wait between attempts.
  public static let maxBackoff = Duration.seconds(30)

  /// Every change of ``status``, in order.
  public nonisolated let statuses: AsyncStream<ConnectionStatus>
  /// Latest local persistence state, independent of connection status changes.
  public nonisolated let storageIssues: AsyncStream<RemoteStorageIssue?>
  /// A failed local confirmation or cleanup, retained until resolved or superseded.
  public private(set) var storageIssue: RemoteStorageIssue?
  /// The host's Atrium messages, tagged with their connection.
  public nonisolated let messages: AsyncStream<RemoteMessage>
  /// What the connection line shows now.
  public private(set) var status = ConnectionStatus.connecting
  /// The current connection attempt; bumped by each new one.
  public private(set) var generation = 0
  /// The host record, completed once a pending pairing is confirmed.
  public private(set) var host: HostRecord

  /// Where the link stands.
  ///
  /// - Remark: `parked` waits for the network or the foreground instead of a timer.
  private enum Link {
    case idle
    case connecting
    case open(SecureChannel)
    case waiting
    case parked
    case stopped
  }

  /// A finished handshake.
  ///
  /// - Remark: Sendable, to come out of the attempt's task group.
  private struct Established: Sendable {
    let deviceId: String
    let channel: SecureChannel
  }

  private let statusSink: AsyncStream<ConnectionStatus>.Continuation
  private let storageSink: AsyncStream<RemoteStorageIssue?>.Continuation
  private var ownership: HostStore.Claim
  private var storageRecovery: HostStorageRecovery?
  private let messageSink: AsyncStream<RemoteMessage>.Continuation
  private let deviceKey: Curve25519.KeyAgreement.PrivateKey
  private let store: HostStore
  private let environment: RemoteEnvironment
  private var link = Link.idle
  private var handover: SecureChannel?
  private var connectingTransport: (any RemoteTransport)?
  private var tasks: [Task<Void, Never>] = []
  private var backoffStep = 0
  private var appPhase = AppPhase.active
  private var networkAvailable = true
  private var tracker = HeartbeatTracker()
  private var lastHeard: Elapsed?
  /// Heartbeat answers read on the current link; tests wait on it.
  private(set) var heartbeatsAnswered = 0

  /// Prepares a link to `host`; nothing happens until ``start()``.
  ///
  /// - Remark: After pairing, the pairing channel is handed over and goes straight on to `hello`
  ///   (SPEC-0005 "配对流程" step 5); later attempts use IK.
  /// - SideEffects: none
  /// - Parameters:
  ///   - host: The Mac; a pending record is completed by the first successful connection.
  ///   - deviceKey: This phone's static key.
  ///   - store: Where the records live, for confirming and deleting.
  ///   - environment: Connections, clock and randomness.
  ///   - handover: An open channel from pairing, if any.
  ///   - ownership: Original record versions captured by the caller's record load or pairing.
  public init(
    host: HostRecord,
    deviceKey: Curve25519.KeyAgreement.PrivateKey,
    store: HostStore,
    environment: RemoteEnvironment,
    handover: SecureChannel? = nil,
    ownership: HostStore.Claim? = nil
  ) {
    self.host = host
    self.deviceKey = deviceKey
    self.store = store
    self.environment = environment
    self.handover = handover
    self.ownership = ownership ?? store.claim(host.hostId)
    (storageIssues, storageSink) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1))
    storageSink.yield(nil)
    (statuses, statusSink) = AsyncStream.makeStream()
    (messages, messageSink) = AsyncStream.makeStream()
    statusSink.yield(status)
  }

  /// Starts connecting.
  ///
  /// - Remark: Does nothing once started or stopped.
  /// - SideEffects: Opens a connection; starts tasks.
  public func start() {
    guard case .idle = link else { return }
    beginAttempt()
  }

  /// Stops for good: closes the link and ends the streams.
  ///
  /// - Remark: For forgetting a Mac or tearing down the app's state.
  /// - SideEffects: Closes the connection; cancels tasks; finishes the streams.
  public func stop() {
    tearDown()
    link = .stopped
    statusSink.finish()
    storageSink.finish()
    storageRecovery = nil
    messageSink.finish()
  }

  /// Retries the remaining version-owned storage action once.
  ///
  /// - Remark: Never starts a network connection or installs a retry timer.
  /// - SideEffects: May update keychain records and storageIssue.
  public func retryStorage() {
    guard !isStopped, let recovery = storageRecovery else { return }
    switch recovery.perform() {
    case .saved(let record, let claim):
      host = record
      ownership = claim
      storageRecovery = nil
      setStorageIssue(nil)
    case .failed(let issue):
      if let claim = recovery.currentClaim { ownership = claim }
      setStorageIssue(issue)
    case .removed:
      storageRecovery = nil
      setStorageIssue(nil)
    case .superseded:
      storageRecovery = nil
      setStorageIssue(nil)
      if recovery.operation == .confirmPairing {
        tearDown()
        finish(.superseded)
      }
    }
  }

  /// Sends one encoded Atrium message on the connection of `generation`.
  ///
  /// - Remark: Refused for an older generation, so a message meant for a replaced connection is never
  ///   sent on the new one. Whether sending is allowed (synced) is the caller's call (``ConnectionStatus/canSend``).
  /// - SideEffects: Writes to the connection.
  /// - Parameters:
  ///   - data: The encoded message.
  ///   - generation: The connection it is meant for.
  /// - Throws: ``RemoteError/closed`` when that connection is gone, or the channel's error.
  public func send(_ data: Data, generation: Int) async throws(RemoteError) {
    guard generation == self.generation, case .open(let channel) = link else { throw .closed }
    try await channel.sendMessage(data)
  }

  /// Says that every open session has caught up on the connection of `generation`.
  ///
  /// - Remark: The sync layer decides this (SPEC-0005 "'已连接'分两步"); a late call for an older
  ///   connection is ignored.
  /// - SideEffects: May change ``status``.
  /// - Parameter generation: The connection.
  public func markSynced(generation: Int) {
    guard generation == self.generation, case .open = link, status == .syncing else { return }
    setStatus(.connected)
  }

  /// Follows the app's lifecycle.
  ///
  /// - Remark: Only `.background → .active` resumes; `.inactive` (Control Centre, alerts) leaves the
  ///   connection alone (SPEC-0005 "回到前台", from mimi-remote). Going to the background does not
  ///   close by itself; the app calls ``closeForBackground()`` inside a background task.
  /// - SideEffects: May change ``status``, open a connection or send a heartbeat.
  /// - Parameter phase: The new phase.
  public func setAppPhase(_ phase: AppPhase) {
    // Inactive is intermediate on the way out of the background as well as for alerts.
    // Preserve the last active/background phase so either route has the same recovery.
    guard phase != .inactive else { return }
    let previous = appPhase
    appPhase = phase
    if previous == .background, phase == .active {
      retryStorage()
      resume()
    }
  }

  /// Closes the link because the app went to the background.
  ///
  /// - Remark: Best effort: iOS may suspend the app before this runs, so ``setAppPhase(_:)`` copes
  ///   with a link left open (SPEC-0005 "进入后台").
  /// - SideEffects: Closes the connection; cancels tasks.
  public func closeForBackground() {
    guard !status.isTerminal, !isStopped else { return }
    tearDown()
    link = .parked
  }

  /// Follows the network path: `NWPathMonitor` updates.
  ///
  /// - Remark: Any change resets the backoff and retries a waiting link at once (SPEC-0005 "重连");
  ///   without a network, attempts wait for one and the line says "连不出去".
  /// - SideEffects: May change ``status``, cancel a retry or open a connection.
  /// - Parameter available: Whether the path is satisfied.
  public func networkChanged(available: Bool) {
    networkAvailable = available
    guard !status.isTerminal, !isStopped else { return }
    backoffStep = 0
    if !available {
      tearDown()
      link = .parked
      setStatus(.noNetwork)
      return
    }
    switch link {
    case .waiting, .parked:
      if appPhase != .background { beginAttempt() }
    default: break
    }
  }

  /// Whether ``stop()`` was called.
  private var isStopped: Bool {
    if case .stopped = link { return true }
    return false
  }

  /// Back in front: show "正在同步" at once, then probe or reconnect.
  ///
  /// - Remark: SPEC-0005 "回到前台": the status changes in the same call, well within 0.5 s. A link
  ///   that heard from the host in the last 20 s gets one heartbeat and 2 s to answer; otherwise a new
  ///   connection is opened directly.
  /// - SideEffects: Changes ``status``; sends a heartbeat or opens a connection.
  private func resume() {
    guard !status.isTerminal, !isStopped else { return }
    setStatus(.syncing)
    backoffStep = 0
    let now = environment.stopwatch.now
    if case .open(let channel) = link, let lastHeard, lastHeard.duration(to: now) < Self.probeWindow {
      let generation = generation
      let probeTask = Task { await self.probe(channel, generation: generation, sentAt: now) }
      tasks.append(probeTask)
    } else if networkAvailable {
      beginAttempt()
    } else {
      tearDown()
      link = .parked
      setStatus(.noNetwork)
    }
  }

  /// Sends the foreground probe and reconnects if nothing comes back within 2 s.
  ///
  /// - Remark: Anything from the host counts as an answer, not only the heartbeat's.
  /// - SideEffects: Sends a heartbeat; may open a new connection.
  /// - Parameters:
  ///   - channel: The open channel.
  ///   - generation: Its generation.
  ///   - sentAt: When the probe started.
  private func probe(_ channel: SecureChannel, generation: Int, sentAt: Elapsed) async {
    do {
      try await channel.sendHeartbeat()
      try await environment.stopwatch.sleep(for: Self.probeTimeout)
    } catch is CancellationError {
      return
    } catch {
      // A failed send closed the channel; the receive loop reports it.
      return
    }
    guard generation == self.generation else { return }
    if let lastHeard, lastHeard > sentAt { return }
    beginAttempt()
  }

  /// Opens a new connection, replacing whatever there was.
  ///
  /// - Remark: ``tearDown()`` moves to a new generation, which makes every callback of the old link stale.
  /// - SideEffects: Closes the old link; opens a connection; starts the attempt's task.
  private func beginAttempt() {
    guard ownership == store.claim(host.hostId) else {
      tearDown()
      finish(.superseded)
      return
    }
    let handover = handover
    self.handover = nil
    tearDown()
    link = .connecting
    let generation = generation
    let attemptTask = Task { await self.attempt(generation, handover: handover) }
    tasks.append(attemptTask)
  }

  /// Runs one attempt: handshake (or the handed-over channel), `hello`, `welcome`, within 15 s.
  ///
  /// - Remark: On timeout the transport is closed, which is what unblocks a pending receive.
  /// - SideEffects: Opens a connection; on success starts the receive and heartbeat loops.
  /// - Parameters:
  ///   - generation: The attempt's generation.
  ///   - handover: The pairing channel, on the first attempt after pairing.
  private func attempt(_ generation: Int, handover: SecureChannel?) async {
    let host = host
    let environment = environment
    let deviceKey = deviceKey
    var transport: (any RemoteTransport)?
    if handover == nil {
      guard let endpoint = clientEndpoint(relay: host.relay, hostId: host.hostId) else {
        failed(generation, .transport(.unreachable))
        return
      }
      transport = environment.connect(endpoint)
      connectingTransport = transport
    }
    let opening = transport
    let result: Result<Established, RemoteError>? = await withTaskGroup(
      of: Result<Established, RemoteError>?.self
    ) { group in
      group.addTask {
        do throws(RemoteError) {
          return .success(
            try await Self.establish(
              host: host, deviceKey: deviceKey, environment: environment, transport: opening, handover: handover))
        } catch {
          return .failure(error)
        }
      }
      group.addTask {
        try? await environment.stopwatch.sleep(for: Self.handshakeTimeout)
        return nil
      }
      let first = await group.next() ?? nil
      if first == nil {
        opening?.close()
        await handover?.close()
      }
      group.cancelAll()
      // A handshake that finished after the timeout still owns a channel; close it.
      for await late in group {
        if case .success(let established)? = late { await established.channel.close() }
      }
      return first
    }
    connectingTransport = nil
    guard generation == self.generation, case .connecting = link else {
      if case .success(let established)? = result { await established.channel.close() }
      return
    }
    switch result {
    case .success(let established)?: opened(established, generation: generation)
    case .failure(let error)?: failed(generation, error)
    case nil: failed(generation, .handshakeTimeout)
    }
  }

  /// The handshake, `hello` and `welcome` on a new transport or the handed-over channel.
  ///
  /// - Remark: Static and nonisolated so it runs in the attempt's child task.
  /// - SideEffects: Sends and receives on the connection.
  /// - Parameters:
  ///   - host: The Mac.
  ///   - deviceKey: This phone's key.
  ///   - environment: Clock, versions and trace ids.
  ///   - transport: A new connection, when there is no handover.
  ///   - handover: The pairing channel, if any.
  /// - Returns: The device id and the channel.
  /// - Throws: ``RemoteError``.
  private static func establish(
    host: HostRecord,
    deviceKey: Curve25519.KeyAgreement.PrivateKey,
    environment: RemoteEnvironment,
    transport: (any RemoteTransport)?,
    handover: SecureChannel?
  ) async throws(RemoteError) -> Established {
    let deviceId: String
    let channel: SecureChannel
    if let handover, let known = host.deviceId {
      (deviceId, channel) = (known, handover)
    } else if let transport {
      (deviceId, channel) = try await RemoteHandshake.connect(
        hostId: host.hostId, hostKey: host.hostKey, deviceKey: deviceKey, appVersion: environment.appVersion,
        transport: transport, stopwatch: environment.stopwatch, protocolVersion: environment.protocolVersion)
    } else {
      throw .closed
    }
    _ = try await RemoteHandshake.hello(
      channel: channel, deviceId: deviceId, traceparent: environment.traceparent(),
      protocolVersion: environment.protocolVersion)
    return Established(deviceId: deviceId, channel: channel)
  }

  /// The channel is up: "正在同步", heartbeats, and the receive loop.
  ///
  /// - Remark: A pending pairing becomes a confirmed record here (SPEC-0005 "配对流程" step 6); a
  ///   keychain failure there does not stop the link, the next start tries again.
  /// - SideEffects: Writes the store; changes ``status``; starts tasks.
  /// - Parameters:
  ///   - established: The device id and channel.
  ///   - generation: The attempt's generation.
  private func opened(_ established: Established, generation: Int) {
    guard ownership == store.claim(host.hostId) else {
      established.channel.abort()
      tearDown()
      finish(.superseded)
      return
    }
    if host.deviceId != established.deviceId {
      storageRecovery = HostStorageRecovery(
        store: store, pending: host, deviceId: established.deviceId, claim: ownership)
      host.deviceId = established.deviceId
      retryStorage()
      guard !status.isTerminal, generation == self.generation else {
        established.channel.abort()
        return
      }
    }
    link = .open(established.channel)
    backoffStep = 0
    tracker = HeartbeatTracker()
    heartbeatsAnswered = 0
    lastHeard = environment.stopwatch.now
    setStatus(.syncing)
    let channel = established.channel
    let receiveTask = Task { await self.receiveLoop(channel, generation: generation) }
    let heartbeatTask = Task { await self.heartbeatLoop(channel, generation: generation) }
    tasks.append(contentsOf: [receiveTask, heartbeatTask])
  }

  /// Reads events until the channel fails or is replaced.
  ///
  /// - Remark: Anything heard counts for the foreground probe.
  /// - SideEffects: Publishes messages; may delete the pairing on `revoked`.
  /// - Parameters:
  ///   - channel: The channel.
  ///   - generation: Its generation.
  private func receiveLoop(_ channel: SecureChannel, generation: Int) async {
    while true {
      let event: ChannelEvent
      do {
        event = try await channel.nextEvent()
      } catch {
        failed(generation, error)
        return
      }
      guard generation == self.generation else { return }
      let now = environment.stopwatch.now
      lastHeard = now
      switch event {
      case .heartbeat: break
      case .heartbeatAck:
        tracker.acknowledged(at: now)
        heartbeatsAnswered += 1
      case .message(let data): messageSink.yield(RemoteMessage(generation: generation, data: data))
      case .control(let body):
        if (try? RemoteJSON.decode(ControlMessage.self, from: body)) == .revoked {
          failed(generation, .rejected(reason: "revoked", hostProtocol: nil))
          return
        }
      }
    }
  }

  /// Sends heartbeats on schedule; two misses end the link.
  ///
  /// - Remark: Sleeps until the tracker's next check, so the manual clock in tests drives it.
  /// - SideEffects: Sends on the channel; may end the link.
  /// - Parameters:
  ///   - channel: The channel.
  ///   - generation: Its generation.
  private func heartbeatLoop(_ channel: SecureChannel, generation: Int) async {
    let stopwatch = environment.stopwatch
    while generation == self.generation {
      switch tracker.tick(at: stopwatch.now) {
      case .wait: break
      case .send:
        tracker.sent(at: stopwatch.now)
        do {
          try await channel.sendHeartbeat()
        } catch {
          failed(generation, error)
          return
        }
      case .reconnect:
        failed(generation, .heartbeatTimeout)
        return
      }
      do {
        try await stopwatch.sleep(for: tracker.nextCheck(at: stopwatch.now))
      } catch {
        return
      }
    }
  }

  /// Ends the link of `generation` and decides what comes next.
  ///
  /// - Remark: Refusals inside Noise are final; the rest picks the status from the error and
  ///   retries with backoff.
  /// - SideEffects: Closes the link; may delete records; changes ``status``; schedules a retry.
  /// - Parameters:
  ///   - generation: The link that failed.
  ///   - error: Why.
  private func failed(_ generation: Int, _ error: RemoteError) {
    guard generation == self.generation, !status.isTerminal, !isStopped else { return }
    tearDown()
    switch error {
    case .rejected(reason: "device_unknown", _) where host.isPending:
      finish(.pairingIncomplete)
      storageRecovery = HostStorageRecovery(
        store: store, removal: store.removal(owner: ownership, hostKey: host.hostKey, pendingOnly: true),
        operation: .removePending)
      retryStorage()
    case .rejected(reason: "device_unknown", _), .rejected(reason: "revoked", _):
      finish(.revoked)
      storageRecovery = HostStorageRecovery(
        store: store, removal: store.removal(owner: ownership, hostKey: host.hostKey, pendingOnly: false),
        operation: .removeHost)
      retryStorage()
    case .rejected(reason: "version_mismatch", let hostProtocol):
      finish(.versionMismatch(hostProtocol: hostProtocol))
    case .versionMismatch(let hostProtocol):
      finish(.versionMismatch(hostProtocol: hostProtocol))
    default:
      setStatus(networkAvailable ? Self.status(for: error) : .noNetwork)
      scheduleRetry()
    }
  }

  /// The status a retryable failure shows.
  ///
  /// - Remark: Relay close codes are shown, never acted on beyond that (SPEC-0005 "撤销").
  /// - SideEffects: none
  /// - Parameter error: The failure.
  /// - Returns: The status.
  static func status(for error: RemoteError) -> ConnectionStatus {
    switch error {
    case .transport(.noNetwork): return .noNetwork
    case .transport(.unreachable): return .relayUnreachable
    case .transport(.closed(code: 4404, let reason)): return .hostOffline(lastSeen: lastSeen(reason))
    default: return .reconnecting
    }
  }

  /// Reads relay's `offline:<unix seconds>` close reason.
  ///
  /// - Remark: `offline:0` means the relay never saw the host since it started (SPEC-0005 "宿主不在线").
  /// - SideEffects: none
  /// - Parameter reason: The close reason.
  /// - Returns: The time, or `nil` for 0 or a reason that does not parse.
  static func lastSeen(_ reason: String) -> Date? {
    guard reason.hasPrefix("offline:"), let seconds = Int(reason.dropFirst("offline:".count)), seconds > 0 else {
      return nil
    }
    return Date(timeIntervalSince1970: TimeInterval(seconds))
  }

  /// The wait before attempt `step`: 1, 2, 4 … 30 s, each shortened by up to 20 % at random.
  ///
  /// - Remark: SPEC-0005 "重连"; the jitter only shortens, so the wait never passes 30 s.
  /// - SideEffects: none
  /// - Parameters:
  ///   - step: How many attempts failed in a row before this one.
  ///   - jitter: A random number in `0..<1`.
  /// - Returns: The wait.
  static func backoff(step: Int, jitter: Double) -> Duration {
    let base: Int64 = step >= 5 ? 30_000 : min(30_000, 1000 << step)
    let factor = 1 - 0.2 * min(max(jitter, 0), 1)
    return .milliseconds(Int64((Double(base) * factor).rounded()))
  }

  /// Waits the backoff, or for the network or the foreground, then tries again.
  ///
  /// - Remark: A retry timer from an older generation never fires an attempt.
  /// - SideEffects: Starts a timer task.
  private func scheduleRetry() {
    guard networkAvailable, appPhase != .background else {
      link = .parked
      return
    }
    link = .waiting
    let delay = Self.backoff(step: backoffStep, jitter: environment.jitter())
    backoffStep += 1
    let generation = generation
    let stopwatch = environment.stopwatch
    let retryTask = Task {
      do {
        try await stopwatch.sleep(for: delay)
      } catch {
        return
      }
      self.retry(generation)
    }
    tasks.append(retryTask)
  }

  /// The backoff ran out.
  ///
  /// - Remark: Only if nothing else started an attempt meanwhile.
  /// - SideEffects: Opens a connection.
  /// - Parameter generation: The generation that scheduled it.
  private func retry(_ generation: Int) {
    guard generation == self.generation, case .waiting = link else { return }
    beginAttempt()
  }

  /// Stops for good with a final status.
  ///
  /// - Remark: No retries after `version_mismatch`, `device_unknown` or `revoked` (SPEC-0005 "重连").
  /// - SideEffects: Changes ``status``.
  /// - Parameter status: The final status.
  private func finish(_ status: ConnectionStatus) {
    link = .parked
    setStatus(status)
  }

  /// Cancels the link's tasks, closes its channel or connection, and starts a new generation.
  ///
  /// - Remark: The new generation makes the dying loops' late failures stale, so they cannot cancel
  ///   what comes next (a retry timer). Teardown closes the socket immediately without waiting for
  ///   queued frames or launching detached cleanup work.
  /// - SideEffects: Cancels tasks; closes the connection.
  private func tearDown() {
    for task in tasks { task.cancel() }
    tasks = []
    connectingTransport?.close()
    connectingTransport = nil
    if case .open(let channel) = link { channel.abort() }
    handover?.abort()
    handover = nil
    link = .idle
    generation += 1
  }

  /// Publishes changed local persistence state even when the network status is unchanged.
  ///
  /// - Remark: Latest-only state buffering is safe here; this is not a protocol message queue.
  /// - SideEffects: Changes storageIssue and yields its state.
  /// - Parameter issue: Failure or successful/superseded resolution.
  private func setStorageIssue(_ issue: RemoteStorageIssue?) {
    guard storageIssue != issue else { return }
    storageIssue = issue
    storageSink.yield(issue)
  }

  /// Publishes a new status.
  ///
  /// - Remark: Repeats are not published.
  /// - SideEffects: Changes ``status``; yields to ``statuses``.
  /// - Parameter status: The status.
  private func setStatus(_ status: ConnectionStatus) {
    guard status != self.status else { return }
    self.status = status
    statusSink.yield(status)
  }
}
