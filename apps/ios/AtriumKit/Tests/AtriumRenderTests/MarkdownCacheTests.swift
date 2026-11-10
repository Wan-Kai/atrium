import Testing

@testable import AtriumRender

@Suite("Markdown cache")
struct MarkdownCacheTests {
  @Test("warming parses each text once, as the plain parser does, and keeps it")
  func warms() async {
    let cache = MarkdownCache(limit: 4)
    #expect(cache.blocks(for: "**a**") == nil)
    await cache.warm(["**a**", "- b"])
    #expect(cache.blocks(for: "**a**") == StreamingMarkdown.parse("**a**"))
    #expect(cache.blocks(for: "- b") == StreamingMarkdown.parse("- b"))
  }

  @Test("past the limit the oldest text goes first")
  func evicts() {
    let cache = MarkdownCache(limit: 2)
    cache.store([.paragraph("1")], for: "1")
    cache.store([.paragraph("2")], for: "2")
    cache.store([.paragraph("3")], for: "3")
    #expect(cache.blocks(for: "1") == nil)
    #expect(cache.blocks(for: "2") == [.paragraph("2")])
    #expect(cache.blocks(for: "3") == [.paragraph("3")])
  }
}
