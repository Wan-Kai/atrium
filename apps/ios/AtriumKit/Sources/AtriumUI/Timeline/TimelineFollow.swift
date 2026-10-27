import CoreGraphics

/// Whether a conversation's timeline sticks to its end: placing, following, or reading history.
///
/// - Remark: Three states (SPEC-0005 "iOS App", from mimi-remote's timeline, mobile-remote.md §7):
///   when a conversation opens the view first places itself at the end; then it follows the tail
///   as text streams and steps arrive; once the person scrolls up it stays put and notes that
///   something new arrived unseen, and scrolling back to the end (or tapping "回到底部") follows
///   again. Same rules as the desktop's `follow-bottom.ts`, with one simplification: only scrolls
///   the person makes count (SwiftUI's scroll phase tells them apart), so the view's own scrolls
///   need no bookkeeping. Pure, so it is tested on macOS.
nonisolated struct TimelineFollow: Equatable, Sendable {
  /// What the timeline does with its end.
  ///
  /// - Remark: See the type.
  enum Mode: Equatable, Sendable {
    /// Just opened: placing itself at the end, before anything else happens.
    case placing
    /// Staying at the end as content grows.
    case following
    /// The person scrolled up; content grows below without moving the view.
    case reading
  }

  /// Within this many points of the end counts as at the end (the desktop's 24px).
  static let nearEnd: CGFloat = 24

  /// What the timeline does now.
  private(set) var mode = Mode.placing
  /// Whether new content arrived while reading history; the "回到底部" button shows a dot.
  private(set) var unseen = false
  /// A geometry change held until the current touch interaction ends.
  private var deferredLayout = false

  /// Notes that the view placed itself at the end after opening.
  ///
  /// - Remark: Only from placing; a later call changes nothing.
  /// - SideEffects: Changes the state.
  mutating func placed() {
    if mode == .placing { mode = .following }
  }

  /// Decides whether completed layout needs a new bottom position.
  ///
  /// - Remark: A source update or Task.yield does not prove a new List row has a scroll target.
  ///   Positioning waits for layout; later equal-size text updates need no scroll command.
  /// - SideEffects: Completes initial placement once nonempty content has layout.
  /// - Parameters:
  ///   - hasRows: Whether the display projection contains rows.
  ///   - sizeChanged: Whether content or viewport height changed.
  /// - Returns: Whether to position at the bottom now.
  mutating func laidOut(hasRows: Bool, sizeChanged: Bool) -> Bool {
    guard hasRows else { return false }
    if mode == .placing {
      placed()
      return true
    }
    return mode == .following && sizeChanged
  }

  /// Remembers layout changes without moving content under a held finger.
  ///
  /// - Remark: Tracking means touch-down, not necessarily scrolling. A later idle phase must not
  ///   lose initial placement or a resize merely because no new geometry callback follows it.
  /// - SideEffects: Retains a pending layout flag.
  /// - Parameter sizeChanged: Whether content or viewport height changed.
  mutating func deferLayout(sizeChanged: Bool) {
    deferredLayout = deferredLayout || sizeChanged || mode == .placing
  }

  /// Processes layout deferred by a touch, without interrupting history reading.
  ///
  /// - Remark: Actual scrolling has already updated the follow mode; a touch without movement has
  ///   not. With no observed layout, an idle callback alone must not complete initial placement.
  /// - SideEffects: Clears the pending flag and may complete initial placement.
  /// - Parameter hasRows: Whether row targets exist.
  /// - Returns: Whether the view should now position at the end.
  mutating func interactionEnded(hasRows: Bool) -> Bool {
    guard deferredLayout else { return false }
    deferredLayout = false
    return laidOut(hasRows: hasRows, sizeChanged: true)
  }

  /// Notes where a scroll the person made ended.
  ///
  /// - Remark: Away from the end stops following; back at the end follows again and clears the
  ///   dot. Ignored while placing, when the view is still moving itself.
  /// - SideEffects: Changes the state.
  /// - Parameter distanceFromEnd: How far the bottom of the visible area is from the content's end.
  mutating func scrolledByPerson(distanceFromEnd: CGFloat) {
    guard mode != .placing else { return }
    let atEnd = distanceFromEnd <= Self.nearEnd
    mode = atEnd ? .following : .reading
    if atEnd { unseen = false }
  }

  /// Notes that content grew, and says whether the view should scroll to the end.
  ///
  /// - Remark: Placing scrolls to the end anyway once laid out, so growth then needs nothing.
  /// - SideEffects: Changes the state.
  /// - Returns: Whether to scroll to the end now.
  mutating func contentGrew() -> Bool {
    switch mode {
    case .placing: return false
    case .following: return true
    case .reading:
      unseen = true
      return false
    }
  }

  /// Notes that the person asked to go back to the end.
  ///
  /// - Remark: The "回到底部" button.
  /// - SideEffects: Changes the state.
  mutating func jumpedToEnd() {
    mode = .following
    unseen = false
  }
}
