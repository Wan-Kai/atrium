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

  /// Notes that the view placed itself at the end after opening.
  ///
  /// - Remark: Only from placing; a later call changes nothing.
  /// - SideEffects: Changes the state.
  mutating func placed() {
    if mode == .placing { mode = .following }
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
