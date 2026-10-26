/// The phone's heartbeat rule: one every 10 s, 15 s without an answer is a miss, 2 misses in a row
/// means reconnect (SPEC-0005 "断线与恢复 · 心跳").
///
/// - Remark: Pure; the connection feeds it times from its stopwatch and sleeps until ``nextCheck(at:)``.
public struct HeartbeatTracker: Sendable {
  /// Time between heartbeats.
  public let interval: Duration
  /// How long to wait for the answer.
  public let timeout: Duration
  /// Misses in a row that mean the connection is dead.
  public let maxMisses: Int
  private var pendingSince: Elapsed?
  private var lastSentAt: Elapsed?
  /// Misses in a row so far.
  public private(set) var misses = 0

  /// Creates a tracker with SPEC-0005's values by default.
  ///
  /// - Remark: Tests pass the defaults explicitly where the numbers matter.
  /// - SideEffects: none
  /// - Parameters:
  ///   - interval: Time between heartbeats.
  ///   - timeout: How long to wait for an answer.
  ///   - maxMisses: Misses in a row that end the connection.
  public init(interval: Duration = .seconds(10), timeout: Duration = .seconds(15), maxMisses: Int = 2) {
    self.interval = interval
    self.timeout = timeout
    self.maxMisses = maxMisses
  }

  /// What the caller should do at a given time.
  ///
  /// - Remark: Returned by ``tick(at:)``.
  public enum Action: Equatable, Sendable {
    /// Nothing yet.
    case wait
    /// Send a heartbeat now and call ``HeartbeatTracker/sent(at:)``.
    case send
    /// Give up and reconnect.
    case reconnect
  }

  /// Decides the next step at `now`.
  ///
  /// - Remark: An unanswered heartbeat counts as one miss once `timeout` has passed; the next
  ///   heartbeat still goes out on schedule; the next timed unanswered heartbeat starts at 20 s,
  ///   so two misses take 35 s by default.
  /// - SideEffects: none
  /// - Parameter now: The current time.
  /// - Returns: The action.
  public mutating func tick(at now: Elapsed) -> Action {
    if let pendingSince, pendingSince.duration(to: now) >= timeout {
      self.pendingSince = nil
      misses += 1
    }
    if misses >= maxMisses { return .reconnect }
    guard let lastSentAt else { return .send }
    return lastSentAt.duration(to: now) >= interval ? .send : .wait
  }

  /// When ``tick(at:)`` next has something to do.
  ///
  /// - Remark: The earlier of the next heartbeat and the open one's timeout.
  /// - SideEffects: none
  /// - Parameter now: The current time.
  /// - Returns: How long to sleep, never negative.
  public func nextCheck(at now: Elapsed) -> Duration {
    var due = lastSentAt.map { $0.advanced(by: interval) } ?? now
    if let pendingSince { due = min(due, pendingSince.advanced(by: timeout)) }
    return max(.zero, now.duration(to: due))
  }

  /// Records that a heartbeat went out at `now`.
  ///
  /// - Remark: Only the oldest unanswered one is timed.
  /// - SideEffects: none
  /// - Parameter now: The current time.
  public mutating func sent(at now: Elapsed) {
    lastSentAt = now
    if pendingSince == nil { pendingSince = now }
  }

  /// Records an answer at `now`.
  ///
  /// - Remark: Any answer clears the misses.
  /// - SideEffects: none
  /// - Parameter now: The current time.
  /// - Returns: The round-trip time of the oldest unanswered heartbeat, or `nil` if none was open.
  @discardableResult
  public mutating func acknowledged(at now: Elapsed) -> Duration? {
    misses = 0
    guard let pendingSince else { return nil }
    self.pendingSince = nil
    return pendingSince.duration(to: now)
  }
}
