/// Whether the conversation page is scrolling, so older turns wait to go in until it rests.
///
/// - Remark: A fetched batch is laid out whole in one frame (150～230 ms in the simulator), which
///   is a visible stall in the middle of a drag or a fling; and with a finger on the screen its
///   place cannot be kept (SPEC-0005 "MP4a 定的细节" 9, "等滚动停了再插"). A class the page
///   writes and the model reads; it draws nothing.
@MainActor
public final class ScrollRest {
  /// How often a waiting batch looks again.
  static let step = Duration.milliseconds(50)
  /// The longest a batch waits.
  static let longest = Duration.seconds(3)
  /// Whether a finger is on the page or it is still sliding.
  public var moving = false

  /// Makes one, at rest.
  ///
  /// - Remark: Owned by the model.
  /// - SideEffects: none
  public init() {}

  /// Returns once the page rests, or after ``longest``.
  ///
  /// - Remark: Looks every ``step`` on the given clock, so tests drive it; cancelling ends it.
  /// - SideEffects: Sleeps on the clock.
  /// - Parameter clock: The clock to wait on.
  func wait(on clock: any Clock<Duration>) async {
    var waited = Duration.zero
    while moving, waited < Self.longest {
      do { try await clock.sleep(for: Self.step) } catch { return }
      waited += Self.step
    }
  }
}
