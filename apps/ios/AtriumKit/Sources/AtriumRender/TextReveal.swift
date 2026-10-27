/// How far a streaming text has been revealed (design-language "动效 · 流式输出").
///
/// - Remark: Deltas arrive in bursts; painting each as it lands shows the bursts. So arrival only
///   moves the target, and each frame reveals a share of what is still hidden: the backlog shrinks
///   with a time constant of 150 ms, so a burst speeds the text up smoothly and the display trails
///   steady output by about that much. A port of the desktop's `text-reveal.ts`, counting
///   characters (grapheme clusters) instead of UTF-16 units, which Swift strings do natively, so a
///   cut never splits an emoji. Pure; the view drives it from its frame clock.
public struct TextReveal: Equatable, Sendable {
  /// The time constant the backlog shrinks with, in seconds.
  public static let horizon = 0.150

  /// All the text received so far.
  public private(set) var target: String
  /// How many characters of it there are; kept so frames do not count again.
  public private(set) var targetCount: Int
  /// How many characters are shown; it only grows while the target does.
  public private(set) var revealed: Int

  /// Starts revealing a text that is shown whole at once.
  ///
  /// - Remark: Only growth is paced: a finished message, a snapshot after reconnecting or a
  ///   recreated view paint everything immediately, with no special case each.
  /// - SideEffects: none
  /// - Parameter text: The text so far.
  public init(_ text: String) {
    target = text
    targetCount = text.count
    revealed = targetCount
  }

  /// Whether everything received is shown, so the frame loop may stop.
  public var isSettled: Bool { revealed >= targetCount }

  /// Points the reveal at newly arrived text, keeping how much is shown.
  ///
  /// - Remark: A target that is not a continuation means another message took this place; then at
  ///   most its whole length stays revealed.
  /// - SideEffects: Changes the state.
  /// - Parameter text: All the text received now.
  public mutating func retarget(_ text: String) {
    guard text != target else { return }
    target = text
    targetCount = text.count
    revealed = min(revealed, targetCount)
  }

  /// Reveals one frame's worth of the backlog.
  ///
  /// - Remark: The step is proportional to the backlog, so a burst catches up faster instead of
  ///   jumping, and at least one character so the tail always finishes. A frame of a whole horizon
  ///   or more (a stall) shows everything; the desktop's cap on a frame's length changes nothing
  ///   past that, so there is none here.
  /// - SideEffects: Changes the state.
  /// - Parameter elapsed: Seconds since the previous frame.
  public mutating func advance(by elapsed: Double) {
    let backlog = targetCount - revealed
    guard backlog > 0, elapsed > 0 else { return }
    let step = max(1, Int((Double(backlog) * min(elapsed, Self.horizon) / Self.horizon).rounded(.up)))
    revealed = min(targetCount, revealed + step)
  }

  /// The text to paint.
  ///
  /// - Remark: While the text still streams, a last character that cannot stand alone yet waits
  ///   for the rest: one ending in a zero-width joiner, or a lone regional indicator (half a flag).
  /// - SideEffects: none
  /// - Parameter streaming: Whether more text may still arrive.
  /// - Returns: The visible text.
  public func visible(streaming: Bool) -> String {
    if revealed < targetCount { return String(target.prefix(revealed)) }
    guard streaming, let last = target.last else { return target }
    let scalars = last.unicodeScalars
    let joiner = scalars.last?.value == 0x200D
    let halfFlag = scalars.count == 1 && (0x1F1E6...0x1F1FF).contains(scalars.first?.value ?? 0)
    return joiner || halfFlag ? String(target.dropLast()) : target
  }
}
