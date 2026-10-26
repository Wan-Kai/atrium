import AtriumProtocol
import AtriumRender
import Testing

/// Context lines numbered from `old` and `new`.
///
/// - Remark: Their text names their old number, so folds can be told apart.
/// - SideEffects: none
/// - Parameters:
///   - count: How many.
///   - old: The first old line number.
///   - new: The first new line number.
/// - Returns: The lines.
private func context(_ count: Int, old: Int, new: Int) -> [DiffLine] {
  (0..<count).map { DiffLine(kind: .context, oldNumber: old + $0, newNumber: new + $0, text: "line \(old + $0)") }
}

/// An added line.
///
/// - Remark: See `context(_:old:new:)`.
/// - SideEffects: none
/// - Parameter new: Its new line number.
/// - Returns: The line.
private func add(_ new: Int) -> DiffLine { DiffLine(kind: .add, oldNumber: nil, newNumber: new, text: "added \(new)") }

/// A deleted line.
///
/// - Remark: See `context(_:old:new:)`.
/// - SideEffects: none
/// - Parameter old: Its old line number.
/// - Returns: The line.
private func del(_ old: Int) -> DiffLine {
  DiffLine(kind: .del, oldNumber: old, newNumber: nil, text: "deleted \(old)")
}

@Suite("Diff layout")
struct DiffLayoutTests {
  @Test("folds the lines before and between hunks, which the host did not send")
  func gaps() {
    let first = DiffHunk(
      oldStart: 10, oldCount: 3, newStart: 10, newCount: 4,
      lines: context(1, old: 10, new: 10) + [add(11)] + context(2, old: 11, new: 12))
    let second = DiffHunk(
      oldStart: 40, oldCount: 2, newStart: 41, newCount: 1, lines: [del(40)] + context(1, old: 41, new: 41))
    let segments = DiffLayout.segments([first, second])
    #expect(segments.first == .gap(count: 9, oldStart: 1, newStart: 1))
    #expect(segments[1] == .header("@@ -10,3 +10,4 @@", hunk: 0))
    #expect(segments.contains(.gap(count: 27, oldStart: 13, newStart: 14)))
    #expect(segments.filter { if case .gap = $0 { true } else { false } }.count == 2)
    #expect(segments.contains(.header("@@ -40,2 +41 @@", hunk: 1)))
  }

  @Test("does not fold anything before a hunk that starts the file, or an added file")
  func noGap() {
    let start = DiffHunk(
      oldStart: 1, oldCount: 1, newStart: 1, newCount: 2, lines: context(1, old: 1, new: 1) + [add(2)])
    #expect(DiffLayout.segments([start]).first == .header("@@ -1 +1,2 @@", hunk: 0))
    let added = DiffHunk(oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, lines: [add(1)])
    #expect(DiffLayout.segments([added]) == [.header("@@ -0,0 +1 @@", hunk: 0), .line(add(1), hunk: 0)])
  }

  @Test("folds a long run of context inside a hunk, keeping three lines next to each change")
  func longContext() {
    let run = context(20, old: 2, new: 3)
    let hunk = DiffHunk(
      oldStart: 1, oldCount: 22, newStart: 1, newCount: 23, lines: [del(1), add(1), add(2)] + run + [add(23)])
    let segments = DiffLayout.segments([hunk])
    #expect(segments.count == 1 + 3 + 3 + 1 + 3 + 1)
    #expect(segments[7] == .folded(Array(run[3..<17]), hunk: 0))
    #expect(segments[6] == .line(run[2], hunk: 0))
    #expect(segments[8] == .line(run[17], hunk: 0))
  }

  @Test("keeps a short run open and folds an edge run only on the side away from the change")
  func edges() {
    let short = DiffHunk(
      oldStart: 1, oldCount: 9, newStart: 1, newCount: 10, lines: context(8, old: 1, new: 1) + [add(9)])
    #expect(!DiffLayout.segments([short]).contains { if case .folded = $0 { true } else { false } })
    let leading = context(12, old: 1, new: 1)
    let edge = DiffHunk(oldStart: 1, oldCount: 12, newStart: 1, newCount: 13, lines: leading + [add(13)])
    let segments = DiffLayout.segments([edge])
    #expect(segments[1] == .folded(Array(leading[0..<9]), hunk: 0))
    #expect(segments.count == 1 + 1 + 3 + 1)
  }
}
