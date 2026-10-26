import Synchronization

/// A clock that only moves when a test says so.
///
/// - Remark: coding-standards "Swift（手机端）": time is injected, and the manual clock lives in a
///   test support target once the first waiting code exists (heartbeats and reconnects, MP4).
///   Sleepers wake in deadline order; tests wait for the number of sleepers before advancing, so an
///   advance never races a sleep that has not started yet.
public final class ManualClock: Clock {
  /// A point on the manual clock.
  ///
  /// - Remark: Just an offset from zero.
  public struct Instant: InstantProtocol {
    /// Time since the clock started.
    public var offset: Duration

    /// The instant `duration` later.
    ///
    /// - Remark: `InstantProtocol` requirement.
    /// - SideEffects: none
    /// - Parameter duration: How much later.
    /// - Returns: The later instant.
    public func advanced(by duration: Duration) -> Instant {
      Instant(offset: offset + duration)
    }

    /// The time from this instant to `other`.
    ///
    /// - Remark: `InstantProtocol` requirement.
    /// - SideEffects: none
    /// - Parameter other: The other instant.
    /// - Returns: `other - self`.
    public func duration(to other: Instant) -> Duration {
      other.offset - offset
    }

    /// Orders instants.
    ///
    /// - Remark: `Comparable` requirement.
    /// - SideEffects: none
    /// - Parameters:
    ///   - lhs: One instant.
    ///   - rhs: The other.
    /// - Returns: Whether `lhs` is earlier.
    public static func < (lhs: Instant, rhs: Instant) -> Bool {
      lhs.offset < rhs.offset
    }
  }

  /// One task waiting on the clock.
  ///
  /// - Remark: `id` lets cancellation find it.
  private struct Sleeper {
    let id: Int
    let deadline: Instant
    let continuation: CheckedContinuation<Void, any Error>
  }

  /// The clock's state.
  ///
  /// - Remark: Behind a mutex; continuations are resumed outside it.
  private struct State {
    var now = Instant(offset: .zero)
    var sleepers: [Sleeper] = []
    var nextId = 0
    var watchers: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
  }

  private let state = Mutex(State())

  /// Makes a clock at zero.
  ///
  /// - Remark: One per test.
  /// - SideEffects: none
  public init() {}

  /// The current instant.
  public var now: Instant { state.withLock { $0.now } }

  /// The clock has no resolution limit.
  public var minimumResolution: Duration { .zero }

  /// How many tasks are sleeping now.
  public var sleeperCount: Int { state.withLock { $0.sleepers.count } }

  /// How long from now each sleeper still sleeps, shortest first.
  public var remaining: [Duration] {
    state.withLock { state in state.sleepers.map { state.now.duration(to: $0.deadline) }.sorted() }
  }

  /// Sleeps until the clock reaches `deadline`.
  ///
  /// - Remark: A deadline already reached returns at once; cancellation throws `CancellationError`.
  /// - SideEffects: Registers a sleeper; may wake watchers.
  /// - Parameters:
  ///   - deadline: When to wake.
  ///   - tolerance: Ignored.
  /// - Throws: `CancellationError`.
  public func sleep(until deadline: Instant, tolerance: Duration? = nil) async throws {
    let id = state.withLock { state in
      state.nextId += 1
      return state.nextId
    }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        let outcome: (wake: Bool, cancelled: Bool, watchers: [CheckedContinuation<Void, Never>]) = state.withLock {
          state in
          if Task.isCancelled { return (false, true, []) }
          if deadline <= state.now { return (true, false, []) }
          state.sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
          let count = state.sleepers.count
          let ready = state.watchers.filter { $0.count <= count }.map(\.continuation)
          state.watchers.removeAll { $0.count <= count }
          return (false, false, ready)
        }
        for watcher in outcome.watchers { watcher.resume() }
        if outcome.cancelled { continuation.resume(throwing: CancellationError()) }
        if outcome.wake { continuation.resume() }
      }
    } onCancel: {
      let sleeper = state.withLock { state -> Sleeper? in
        guard let index = state.sleepers.firstIndex(where: { $0.id == id }) else { return nil }
        return state.sleepers.remove(at: index)
      }
      sleeper?.continuation.resume(throwing: CancellationError())
    }
  }

  /// Moves the clock forward and wakes everyone whose deadline has come, earliest first.
  ///
  /// - Remark: Woken tasks run afterwards, asynchronously; tests wait for what they do.
  /// - SideEffects: Changes the time; resumes sleepers.
  /// - Parameter duration: How far.
  public func advance(by duration: Duration) {
    let due = state.withLock { state in
      state.now = state.now.advanced(by: duration)
      let now = state.now
      let due = state.sleepers.filter { $0.deadline <= now }.sorted { $0.deadline < $1.deadline }
      state.sleepers.removeAll { $0.deadline <= now }
      return due
    }
    for sleeper in due { sleeper.continuation.resume() }
  }

  /// Waits until at least `count` tasks are sleeping.
  ///
  /// - Remark: The way to know a loop has reached its wait before advancing time.
  /// - SideEffects: Suspends until then.
  /// - Parameter count: How many sleepers.
  public func waitForSleepers(_ count: Int = 1) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let ready = state.withLock { state in
        if state.sleepers.count >= count { return true }
        state.watchers.append((count, continuation))
        return false
      }
      if ready { continuation.resume() }
    }
  }
}
