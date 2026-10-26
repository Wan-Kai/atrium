import AtriumProtocol

/// How one file's diff is shown on the phone: hunk by hunk, long unchanged stretches folded.
///
/// - Remark: design-language "手机端 · 改动与 diff": a sticky header per hunk, and long unchanged
///   context folded into "展开 N 行". Two kinds of fold: lines between hunks (and before the first),
///   which the host did not send, so opening them needs context matching both comparison revisions;
///   a working-tree `read_file` cannot supply merge-base/HEAD context for a base diff. MP6 must
///   guarantee revision matching before offering that action. Context inside a hunk is already
///   present and can open in place.
///   A run inside a hunk folds when it is longer than `foldOver`, keeping `keep` lines next to the
///   changes on each side. Pure; the view draws it.
public enum DiffLayout {
  /// One piece of the shown diff, top to bottom.
  ///
  /// - Remark: Identified by its place so a list can keep rows stable while folds open.
  public enum Segment: Equatable, Sendable {
    /// Unchanged lines the diff does not hold, before a hunk.
    ///
    /// `count` lines starting at `oldStart` in the old file and `newStart` in the new one.
    case gap(count: Int, oldStart: Int, newStart: Int)
    /// A hunk's header, "@@ -12,7 +12,8 @@", which sticks to the top while its lines scroll.
    case header(String, hunk: Int)
    /// One line.
    case line(DiffLine, hunk: Int)
    /// Unchanged lines inside a hunk, folded; they open in place.
    case folded([DiffLine], hunk: Int)
  }

  /// A run of context inside a hunk folds when it is longer than this.
  public static let foldOver = 8
  /// How many context lines stay open next to a change on each side of a fold.
  public static let keep = 3

  /// Lays out a file's hunks.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter hunks: The file's hunks, in order, as the host sends them.
  /// - Returns: The segments.
  public static func segments(_ hunks: [DiffHunk]) -> [Segment] {
    var segments: [Segment] = []
    var nextOld = 1
    var nextNew = 1
    for (index, hunk) in hunks.enumerated() {
      // A zero-count range names the preceding line, not the first line after the gap.
      let oldStart = hunk.oldStart + (hunk.oldCount == 0 ? 1 : 0)
      let newStart = hunk.newStart + (hunk.newCount == 0 ? 1 : 0)
      let missing = oldStart - nextOld
      if missing > 0 {
        segments.append(.gap(count: missing, oldStart: nextOld, newStart: nextNew))
      }
      segments.append(.header(header(hunk), hunk: index))
      segments += lines(hunk.lines, hunk: index)
      nextOld = oldStart + hunk.oldCount
      nextNew = newStart + hunk.newCount
    }
    return segments
  }

  /// A hunk's header as git writes it.
  ///
  /// - Remark: A count of one is left out, as git does.
  /// - SideEffects: none
  /// - Parameter hunk: The hunk.
  /// - Returns: "@@ -a,b +c,d @@".
  public static func header(_ hunk: DiffHunk) -> String {
    let old = hunk.oldCount == 1 ? "\(hunk.oldStart)" : "\(hunk.oldStart),\(hunk.oldCount)"
    let new = hunk.newCount == 1 ? "\(hunk.newStart)" : "\(hunk.newStart),\(hunk.newCount)"
    return "@@ -\(old) +\(new) @@"
  }

  /// A hunk's lines, with long context runs folded.
  ///
  /// - Remark: A run at the hunk's start or end keeps lines only on the side that touches a change.
  /// - SideEffects: none
  /// - Parameters:
  ///   - lines: The hunk's lines.
  ///   - hunk: The hunk's index.
  /// - Returns: The segments.
  private static func lines(_ lines: [DiffLine], hunk: Int) -> [Segment] {
    var segments: [Segment] = []
    var start = 0
    while start < lines.count {
      guard lines[start].kind == .context else {
        segments.append(.line(lines[start], hunk: hunk))
        start += 1
        continue
      }
      var end = start
      while end < lines.count && lines[end].kind == .context { end += 1 }
      let head = start == 0 ? 0 : keep
      let tail = end == lines.count ? 0 : keep
      let run = Array(lines[start..<end])
      if run.count > foldOver {
        segments += run.prefix(head).map { .line($0, hunk: hunk) }
        segments.append(.folded(Array(run.dropFirst(head).dropLast(tail)), hunk: hunk))
        segments += run.suffix(tail).map { .line($0, hunk: hunk) }
      } else {
        segments += run.map { .line($0, hunk: hunk) }
      }
      start = end
    }
    return segments
  }
}
