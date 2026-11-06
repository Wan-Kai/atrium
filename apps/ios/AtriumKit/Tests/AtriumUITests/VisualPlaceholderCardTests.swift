import Testing

@testable import AtriumUI

@Suite("Visual placeholder card")
struct VisualPlaceholderCardTests {
  @Test("puts the demo's name in its own title row and the note on a line of its own (SPEC-0007, 手机端)")
  func lines() {
    let long = String(repeating: "很长的演示名字", count: 20) + ".html"
    #expect(VisualPlaceholderCard.lines(name: "2-03-isolation.html") == ["演示 · 2-03-isolation.html", "在电脑上查看"])
    #expect(VisualPlaceholderCard.lines(name: long) == ["演示 · \(long)", "在电脑上查看"])
  }
}
