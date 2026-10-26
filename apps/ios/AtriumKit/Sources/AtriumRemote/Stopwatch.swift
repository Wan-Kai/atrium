/// A point in time, as the time since a ``Stopwatch`` started.
///
/// - Remark: The injected clock is `any Clock<Duration>`, whose own instants cannot be stored or
///   compared once erased; this one can, and works with the generic ``FrameReassembler`` and
///   ``HeartbeatTracker``.
public struct Elapsed: InstantProtocol {
  /// Time since the stopwatch started.
  public var offset: Duration

  /// Makes an instant at `offset`.
  ///
  /// - Remark: Public so tests can write expected instants.
  /// - SideEffects: none
  /// - Parameter offset: Time since the start.
  public init(offset: Duration) {
    self.offset = offset
  }

  /// The instant `duration` later.
  ///
  /// - Remark: `InstantProtocol` requirement.
  /// - SideEffects: none
  /// - Parameter duration: How much later.
  /// - Returns: The later instant.
  public func advanced(by duration: Duration) -> Elapsed {
    Elapsed(offset: offset + duration)
  }

  /// The time from this instant to `other`.
  ///
  /// - Remark: `InstantProtocol` requirement.
  /// - SideEffects: none
  /// - Parameter other: The other instant.
  /// - Returns: `other - self`.
  public func duration(to other: Elapsed) -> Duration {
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
  public static func < (lhs: Elapsed, rhs: Elapsed) -> Bool {
    lhs.offset < rhs.offset
  }
}

/// The injected clock, with a readable "now" for timeouts and heartbeats.
///
/// - Remark: Every wait in AtriumRemote goes through here, so tests drive time with a manual clock
///   (coding-standards "Swift（手机端）": time is always injected).
public struct Stopwatch: Sendable {
  /// The clock waits use.
  public let clock: any Clock<Duration>
  private let read: @Sendable () -> Duration

  /// Starts measuring from the clock's current time.
  ///
  /// - Remark: Opens the existential once, so later readings need no generic code.
  /// - SideEffects: none (reads the clock)
  /// - Parameter clock: `ContinuousClock()` in the app, a manual clock in tests.
  public init(_ clock: any Clock<Duration>) {
    self.clock = clock
    read = Self.reader(clock)
  }

  /// Makes the reading closure for a concrete clock.
  ///
  /// - Remark: Generic so the start instant keeps its type.
  /// - SideEffects: none (reads the clock)
  /// - Parameter clock: The clock.
  /// - Returns: A closure giving the time since now.
  private static func reader<C: Clock<Duration>>(_ clock: C) -> @Sendable () -> Duration {
    let origin = clock.now
    return { origin.duration(to: clock.now) }
  }

  /// The current instant.
  public var now: Elapsed { Elapsed(offset: read()) }

  /// Waits for `duration` on the clock.
  ///
  /// - Remark: Throws `CancellationError` when the task is cancelled, like the clock does.
  /// - SideEffects: Suspends the task.
  /// - Parameter duration: How long.
  /// - Throws: `CancellationError`.
  public func sleep(for duration: Duration) async throws {
    try await clock.sleep(for: duration)
  }
}
