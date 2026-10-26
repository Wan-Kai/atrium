import AtriumRender
import Testing

@Suite("Streaming Markdown")
struct StreamingMarkdownTests {
  @Test(
    "incremental blocks equal a full parse at every character boundary",
    arguments: [
      "# 标题\n\n中文 **强调** 与 `code`。\n\n第二段。\n",
      "| a | b |\n| --- | --- |\n| 1 | 2 |\npartial\n\nnext\n",
      "4. first\n\n1. second\n\nend\n",
      "title\n===\n\nnext\n\nend\n",
      "intro\n\n    a\n    b\n\nend\n",
      "a\rb\rc\n\nx\n\n\ny\nz",
      "intro\r\n\r\n```ts\rx\r\n```\r\n\r\nafter\r\n",
      "intro\n\n   ```swift\n   let x = 1\n   ```\n\nend\n",
      "[earlier][ref]\n\nparagraph\n\n[ref]: https://example.com\n",
      "```swift\nlet emoji = \"👨‍👩‍👧\"\n\nlet x = 2\n```\n\nafter\n",
      "<div>\n\ninside\n</div>\n\nafter\n",
      "- [x] task\n- plain\n  - nested\n\nend\n",
    ])
  func matchesFull(_ source: String) {
    var parser = StreamingMarkdown()
    var prefix = ""
    for character in source {
      prefix.append(character)
      let incremental = parser.update(prefix)
      #expect(incremental == StreamingMarkdown.parse(prefix), "prefix: \(prefix)")
    }
    #expect(parser.update(source, complete: true) == StreamingMarkdown.parse(source))
  }

  @Test("parses only the tail after a stable boundary and resets on replacement")
  func cache() {
    var parser = StreamingMarkdown()
    _ = parser.update("first\n\nsecond\n")
    #expect(parser.frozenByteCount == 7)
    #expect(parser.update("first\n\nsecond\nmore") == StreamingMarkdown.parse("first\n\nsecond\nmore"))
    #expect(parser.lastParsedByteCount == "second\nmore".utf8.count)
    #expect(parser.update("replacement") == StreamingMarkdown.parse("replacement"))
    #expect(parser.frozenByteCount == 0)
  }

  @Test(
    "canonical-equivalent replacements invalidate UTF-8 offsets", arguments: [("e\u{301}", "é"), ("é", "e\u{301}")])
  func canonicalReplacements(_ spellings: (String, String)) throws {
    let original = String(repeating: spellings.0, count: 8) + "\n\nx\nlong enough tail"
    let replacementHead = String(repeating: spellings.1, count: 8)
    let replacement = replacementHead + "\n\nx\nlong enough tailz"
    var parser = StreamingMarkdown()
    _ = parser.update(original)
    #expect(parser.frozenByteCount > 0)
    let actual = parser.update(replacement)
    #expect(actual == StreamingMarkdown.parse(replacement))
    #expect(parser.lastParsedByteCount == replacement.utf8.count)
    guard case .paragraph(let text) = try #require(actual.first) else {
      Issue.record("expected first paragraph")
      return
    }
    #expect(Array(String(text.characters).utf8) == Array(replacementHead.utf8))
  }

  @Test("normalization shortening cannot retain an offset past the replacement")
  func shorterCanonicalReplacement() {
    var parser = StreamingMarkdown()
    let original = String(repeating: "e\u{301}", count: 8) + "\n\nx\n"
    let replacement = String(repeating: "é", count: 8) + "\n\nx\nz"
    _ = parser.update(original)
    #expect(parser.frozenByteCount > replacement.utf8.count)
    #expect(parser.update(replacement) == StreamingMarkdown.parse(replacement))
    #expect(parser.lastParsedByteCount == replacement.utf8.count)
  }

  @Test("a true byte append keeps the cached prefix even when it extends a grapheme")
  func appendedCombiningMark() {
    var parser = StreamingMarkdown()
    let source = "first\n\nx\nlast"
    _ = parser.update(source)
    let frozen = parser.frozenByteCount
    #expect(frozen == 7)
    let next = source + "\u{301}"
    #expect(parser.update(next) == StreamingMarkdown.parse(next))
    #expect(parser.lastParsedByteCount == next.utf8.count - frozen)
  }

  @Test("later reference definitions are not frozen away")
  func reference() {
    var parser = StreamingMarkdown()
    _ = parser.update("[x][r]\n\nsecond\n")
    let source = "[x][r]\n\nsecond\n\n[r]: https://example.com\n"
    #expect(parser.update(source) == StreamingMarkdown.parse(source))
    #expect(parser.lastParsedByteCount == source.utf8.count)
  }

  @Test("only permits HTTP and HTTPS links and never interprets HTML")
  func safeLinks() throws {
    for destination in ["javascript:alert", "file:///private/secret", "atrium://pair", "data:text/plain,x"] {
      let blocks = StreamingMarkdown.parse("[click](\(destination))")
      guard case .paragraph(let text) = try #require(blocks.first) else {
        Issue.record("expected a paragraph")
        continue
      }
      #expect(text.runs.allSatisfy { $0.link == nil })
      #expect(String(text.characters) == "click")
    }
    guard case .paragraph(let text) = try #require(StreamingMarkdown.parse("[site](https://example.com)").first) else {
      Issue.record("expected paragraph")
      return
    }
    #expect(text.runs.first?.link?.absoluteString == "https://example.com")
    #expect(StreamingMarkdown.parse("<script>alert(1)</script>") == [.html("<script>alert(1)</script>\n")])
  }

  @Test("checks fences inside quotes and treats single-line indented code as complete")
  func nestedFences() {
    #expect(
      StreamingMarkdown.parse("> ```swift\n> x") == [.quote([.code(language: "swift", code: "x", closed: false)])])
    #expect(
      StreamingMarkdown.parse("> ```swift\n> x\n> ```") == [.quote([.code(language: "swift", code: "x", closed: true)])]
    )
    #expect(StreamingMarkdown.parse("    x") == [.code(language: nil, code: "x", closed: true)])
  }

  @Test("closed fences accept independent zero-to-three-space indentation inside and outside quotes")
  func closingFenceIndentation() {
    for quoted in [false, true] {
      for opening in 0...3 {
        for closing in 0...3 {
          let container = quoted ? "> " : ""
          let source =
            container + String(repeating: " ", count: opening) + "```swift\n"
            + container + "x\n" + container + String(repeating: " ", count: closing) + "```"
          let code = MarkdownBlock.code(language: "swift", code: "x", closed: true)
          #expect(
            StreamingMarkdown.parse(source) == (quoted ? [.quote([code])] : [code]),
            "opening=\(opening), closing=\(closing), quote=\(quoted)")
        }
      }
    }
  }

  @Test("a fence outside a quote does not close its code, and indented backticks remain literal")
  func fenceContainerBoundary() {
    #expect(
      StreamingMarkdown.parse("> ```swift\n> x\n```") == [
        .quote([.code(language: "swift", code: "x", closed: false)]),
        .code(language: nil, code: "", closed: false),
      ])
    #expect(
      StreamingMarkdown.parse("```swift\nliteral ```") == [.code(language: "swift", code: "literal ```", closed: false)]
    )
    #expect(
      StreamingMarkdown.parse("    ```swift\n    x\n    ```") == [
        .code(language: nil, code: "```swift\nx\n```", closed: true)
      ])
  }

  @Test("uses source for diagrams and preserves fence closing and inline formatting")
  func blocks() {
    #expect(
      StreamingMarkdown.parse("```mermaid\ngraph LR; A-->B\n```\n") == [
        .diagram(language: "mermaid", source: "graph LR; A-->B")
      ])
    #expect(
      StreamingMarkdown.parse("````swift\nx\n```\n") == [
        .code(language: "swift", code: "x\n```", closed: false)
      ])
    #expect(
      StreamingMarkdown.parse("````swift\nx\n````\n") == [
        .code(language: "swift", code: "x", closed: true)
      ])
  }
}
