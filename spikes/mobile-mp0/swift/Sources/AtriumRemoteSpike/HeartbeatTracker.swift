/// The phone's heartbeat rule: one every 10 s, 15 s without an answer is a miss, 2 misses in a row
/// means reconnect (SPEC-0005 "断线与恢复 · 心跳").
///
/// - Remarks: Pure; the caller feeds it times from its clock.
/// - Side effects: none.
public struct HeartbeatTracker<Instant: InstantProtocol> where Instant.Duration == Duration {
    /// Time between heartbeats.
    public let interval: Duration
    /// How long to wait for the answer.
    public let timeout: Duration
    /// Misses in a row that mean the connection is dead.
    public let maxMisses: Int
    private var pendingSince: Instant?
    private var lastSentAt: Instant?
    /// Misses in a row so far.
    public private(set) var misses = 0

    /// Creates a tracker with SPEC-0005's values by default.
    ///
    /// - Side effects: none.
    public init(interval: Duration = .seconds(10), timeout: Duration = .seconds(15), maxMisses: Int = 2) {
        self.interval = interval
        self.timeout = timeout
        self.maxMisses = maxMisses
    }

    /// What the caller should do at `now`.
    public enum Action: Equatable, Sendable {
        /// Nothing yet.
        case wait
        /// Send a heartbeat now and call ``sent(at:)``.
        case send
        /// Give up and reconnect.
        case reconnect
    }

    /// Decides the next step at `now`.
    ///
    /// - Remarks: An unanswered heartbeat counts as one miss once `timeout` has passed; the next
    ///   heartbeat still goes out on schedule, so two misses take about 25 s by default.
    /// - Side effects: none.
    public mutating func tick(at now: Instant) -> Action {
        if let pendingSince, pendingSince.duration(to: now) >= timeout {
            self.pendingSince = nil
            misses += 1
        }
        if misses >= maxMisses { return .reconnect }
        guard let lastSentAt else { return .send }
        return lastSentAt.duration(to: now) >= interval ? .send : .wait
    }

    /// Records that a heartbeat went out at `now`.
    ///
    /// - Side effects: none.
    public mutating func sent(at now: Instant) {
        lastSentAt = now
        if pendingSince == nil { pendingSince = now }
    }

    /// Records an answer at `now`.
    ///
    /// - Side effects: none.
    /// - Returns: The round-trip time of the oldest unanswered heartbeat, or `nil` if none was open.
    public mutating func acknowledged(at now: Instant) -> Duration? {
        misses = 0
        guard let pendingSince else { return nil }
        self.pendingSince = nil
        return pendingSince.duration(to: now)
    }
}
