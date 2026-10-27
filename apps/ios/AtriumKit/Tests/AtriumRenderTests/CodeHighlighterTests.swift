import AtriumRender
import Foundation
import Testing

@Suite("Code highlighter")
struct CodeHighlighterTests {
  @Test("reads highlight.js's spans, unescaping text and merging runs of one scope")
  func html() {
    let html =
      #"<span class="hljs-keyword">const</span> a = <span class="hljs-string">&quot;x &amp; y&quot;</span>;"#
      + #" <span class="hljs-comment">// &lt;b&gt; it&#x27;s</span>"#
    #expect(
      CodeHighlighter.tokens(fromHTML: html) == [
        CodeToken("const", .keyword), CodeToken(" a = ", nil), CodeToken("\"x & y\"", .string),
        CodeToken("; ", nil), CodeToken("// <b> it's", .comment),
      ])
  }

  @Test("gives nested text the innermost scope that means something")
  func nesting() {
    let html =
      #"<span class="hljs-string">`a <span class="hljs-subst">${<span class="hljs-number">1</span>}</span> b`</span>"#
    #expect(
      CodeHighlighter.tokens(fromHTML: html) == [
        CodeToken("`a ${", .string), CodeToken("1", .constant), CodeToken("} b`", .string),
      ])
    #expect(
      CodeHighlighter.tokens(fromHTML: #"<span class="hljs-title function_">run</span>()"#) == [
        CodeToken("run", .title), CodeToken("()", nil),
      ])
  }

  @Test("keeps a stray ampersand or bracket as text")
  func stray() {
    #expect(CodeHighlighter.tokens(fromHTML: "a & b <c") == [CodeToken("a & b <c", nil)])
    #expect(CodeHighlighter.tokens(fromHTML: "") == [])
  }

  @Test("highlights TypeScript with the bundled highlight.js, the text unchanged")
  func typescript() async throws {
    let code = "export function put(key: string): number {\n  return 42; // done\n}\n"
    let tokens = try #require(await CodeHighlighter.shared.highlight(code, language: "ts"))
    #expect(tokens.map(\.text).joined() == code)
    #expect(tokens.contains(CodeToken("export", .keyword)))
    #expect(tokens.contains(CodeToken("42", .constant)))
    #expect(tokens.contains(CodeToken("// done", .comment)))
    #expect(tokens.contains { $0.text == "put" && $0.scope == .title })
  }

  @Test(
    "knows the languages replies use, by name or alias",
    arguments: [
      "ts", "tsx", "typescript", "js", "json", "swift", "python", "bash", "sh", "go", "rust", "css",
      "html", "yaml", "toml", "diff", "markdown", "sql", "kotlin",
    ])
  func languages(_ language: String) async {
    #expect(await CodeHighlighter.shared.highlight("x", language: language) != nil)
  }

  @Test(
    "real highlighting preserves Unicode beside escaped ASCII and span boundaries",
    arguments: [
      "<\u{301}", "&\u{FE0F}", ">\u{301}", "\"\u{301}", "'\u{301}", "<\u{301} &\u{FE0F} 👨‍👩‍👧 🇨🇳",
      "const value = `x ${1 < 2 ? \"<\u{301}\" : \"&\u{FE0F}\"}`; // 👩🏽‍💻",
      "const\u{301} x = 1; // combining mark after highlighted keyword",
    ])
  func unicodeRoundTrip(_ code: String) async throws {
    let tokens = try #require(await CodeHighlighter.shared.highlight(code, language: "javascript"))
    #expect(Array(tokens.map(\.text).joined().utf8) == Array(code.utf8))
  }

  @Test("leaves an unknown language plain")
  func unknown() async {
    #expect(await CodeHighlighter.shared.highlight("x", language: "nope") == nil)
    #expect(await CodeHighlighter.shared.highlight("x", language: "") == nil)
  }
}
