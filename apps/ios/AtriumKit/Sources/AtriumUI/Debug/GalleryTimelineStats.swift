#if DEBUG && os(iOS)
  /// Counts row construction and rendering during the synthetic timeline experiment.
  ///
  /// - Remark: Counts only, never ids or conversation content. Updating plain counters does not
  ///   invalidate a SwiftUI view, so the measurement does not create a per-frame feedback loop.
  enum GalleryTimelineStats {
    /// Actual row body evaluations since the measurement began.
    private(set) static var rowBodies = 0
    /// List/ForEach row-builder evaluations, including rows skipped by Equatable.
    private(set) static var rowBuilds = 0
    /// Session page turn body evaluations.
    private(set) static var turnBodies = 0
    /// Markdown block body evaluations.
    private(set) static var blockBodies = 0

    /// Starts a new count interval.
    ///
    /// - Remark: Called only by the Debug probe.
    /// - SideEffects: Clears Debug counters.
    static func reset() {
      rowBodies = 0
      rowBuilds = 0
      turnBodies = 0
      blockBodies = 0
    }

    /// Counts one row body evaluation.
    ///
    /// - Remark: Instrumentation is absent from Release builds.
    /// - SideEffects: Increments the body count.
    static func bodyEvaluated() { rowBodies += 1 }

    /// Counts one row-builder evaluation.
    ///
    /// - Remark: Separates construction for identity lookup from actual rendering work.
    /// - SideEffects: Increments the construction count.
    static func rowBuilt() { rowBuilds += 1 }

    /// Counts one session page turn body evaluation.
    ///
    /// - Remark: The streaming benchmark compares how many turns redraw as the tail grows.
    /// - SideEffects: Increments the turn count.
    static func turnEvaluated() { turnBodies += 1 }

    /// Counts one Markdown block body evaluation.
    ///
    /// - Remark: See `turnEvaluated()`.
    /// - SideEffects: Increments the block count.
    static func blockEvaluated() { blockBodies += 1 }
  }
#endif
