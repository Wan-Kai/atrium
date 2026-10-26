import AtriumRender
import Foundation
import Testing

@Suite("Render worker benchmarks", .serialized)
struct RenderPerformanceTests {
  @Test("reports parser, incremental-tail and code-highlighting timings without equating them to UI frames")
  func measurements() async throws {
    let section = "# Reply\n\n中文 **text** and `code`.\n\n```ts\nconst x = 42;\n```\n\nnext paragraph.\n\n"
    let source = String(repeating: section, count: 1200)
    let code = (0..<500).map { "const value\($0): number = \($0); // a value" }.joined(separator: "\n")
    let clock = ContinuousClock()
    var parse: [Double] = []
    var highlight: [Double] = []
    for _ in 0..<5 {
      let start = clock.now
      let blocks = StreamingMarkdown.parse(source)
      parse.append(milliseconds(start.duration(to: clock.now)))
      #expect(blocks.count == 4800)
      let beforeCode = clock.now
      let tokens = try #require(await CodeHighlighter.shared.highlight(code, language: "typescript"))
      highlight.append(milliseconds(beforeCode.duration(to: clock.now)))
      #expect(tokens.map(\.text).joined() == code)
    }
    var incremental = StreamingMarkdown()
    _ = incremental.update(source)
    let beforeTail = clock.now
    _ = incremental.update(source + "tail\n")
    let tail = milliseconds(beforeTail.duration(to: clock.now))
    print(
      "RENDER_BENCH bytes=\(source.utf8.count) parseMedianMs=\(parse.sorted()[2]) code500MedianMs=\(highlight.sorted()[2]) tailMs=\(tail) parsedTailBytes=\(incremental.lastParsedByteCount)"
    )
  }

  /// Converts clock duration to fractional milliseconds.
  ///
  /// - Remark: Benchmarks deliberately use a real monotonic clock, not a fake frame clock.
  /// - SideEffects: none
  /// - Parameter duration: Measured interval.
  /// - Returns: Milliseconds.
  private func milliseconds(_ duration: Duration) -> Double {
    Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
  }
}
