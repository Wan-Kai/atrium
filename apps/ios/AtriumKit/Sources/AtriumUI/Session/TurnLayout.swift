import AtriumProtocol
import Foundation

/// What a turn shows on the session page: your message, its process, its reply and what it changed.
///
/// - Remark: SPEC-0005 "MP5 定的细节 · MP5a" and the final prototype's conversation: a bubble for
///   your message (none for one the host sent to have pi go on), the process rail with its
///   headline, the reply as Markdown, and the line of changed files under it. Worked out from the
///   turn alone, so the page only lays it out.
struct TurnLayout: Equatable {
  /// What a turn changed, summed over its files.
  ///
  /// - Remark: Lines a file did not count are left out.
  struct Changes: Equatable {
    /// How many files.
    let files: Int
    /// Lines added, where known.
    let added: Int
    /// Lines removed, where known.
    let removed: Int
  }

  /// The turn's id.
  let id: String
  /// Your message's text.
  let user: String
  /// How many images came with it.
  let images: Int
  /// Whether your message shows as a bubble: not when the host sent it.
  let showsBubble: Bool
  /// The process rail's rows.
  let rows: [RailRow]
  /// What the folded rail says the process did.
  let summary: [String]
  /// The reply's text, if the turn ended on one.
  let reply: String?
  /// Whether the turn still runs.
  let running: Bool
  /// Whether the process rail shows: it has rows, or the turn runs.
  var showsRail: Bool { running || !rows.isEmpty }
  /// pi's error text when the turn failed, empty when pi gave none; `nil` when it did not fail.
  let failure: String?
  /// What it changed, `nil` when nothing.
  let changes: Changes?
  /// When you sent its message, in milliseconds since the epoch.
  let sentAt: Int

  private let outcome: Turn.Outcome
  private let startedAt: Int
  private let durationMs: Int?

  /// Lays out a turn.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter turn: The turn.
  init(_ turn: Turn) {
    let layout = RailRows.layout(turn)
    id = turn.id
    user = turn.user.text
    images = turn.user.images
    sentAt = turn.user.timestamp
    showsBubble = !turn.user.auto
    rows = layout.rows
    summary = RailRows.summary(turn)
    reply = layout.reply
    running = turn.outcome == .running
    failure = turn.outcome == .failed ? (turn.error ?? "") : nil
    changes =
      turn.changes.isEmpty
      ? nil
      : Changes(
        files: turn.changes.count, added: turn.changes.reduce(0) { $0 + ($1.added ?? 0) },
        removed: turn.changes.reduce(0) { $0 + ($1.removed ?? 0) })
    outcome = turn.outcome
    startedAt = turn.startedAt
    durationMs = turn.durationMs
  }

  /// The rail's headline: the time so far while it runs, else how it ended and how long it took.
  ///
  /// - Remark: "1:12" while running (the cat and "进行中" come before it); "用时 48 秒",
  ///   "已停止，用时 1 分 40 秒", "出错，用时 52 秒" after, as the prototype writes them.
  /// - SideEffects: none
  /// - Parameter now: The time now, in milliseconds since the Unix epoch.
  /// - Returns: The headline.
  func headline(now: Int) -> String {
    if running { return Self.elapsed(max(0, now - startedAt)) }
    let took = "用时 " + RailRows.formatDuration(durationMs ?? 0)
    switch outcome {
    case .stopped: return "已停止，" + took
    case .failed: return "出错，" + took
    case .running, .done: return took
    }
  }

  /// A running time as a clock: "0:07", "1:12", "1:02:05".
  ///
  /// - Remark: Tabular in the headline, ticking every second.
  /// - SideEffects: none
  /// - Parameter ms: Milliseconds.
  /// - Returns: The time.
  static func elapsed(_ ms: Int) -> String {
    let seconds = ms / 1000
    let clock = String(format: "%d:%02d", (seconds / 60) % 60, seconds % 60)
    return seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60) : clock
  }

  /// A moment as the time under a bubble: hours and minutes, "9:31".
  ///
  /// - Remark: design-language "手机端 · 对话页": the time sits under the bubble, not in it. The time
  ///   zone is passed in so the words do not depend on where the tests run.
  /// - SideEffects: none
  /// - Parameters:
  ///   - ms: The moment, in milliseconds since the epoch.
  ///   - timeZone: Where the phone is.
  /// - Returns: The time.
  static func clock(_ ms: Int, in timeZone: TimeZone = .current) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let parts = calendar.dateComponents([.hour, .minute], from: Date(timeIntervalSince1970: Double(ms) / 1000))
    return String(format: "%d:%02d", parts.hour ?? 0, parts.minute ?? 0)
  }
}
