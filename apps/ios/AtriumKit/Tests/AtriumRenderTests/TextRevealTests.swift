import AtriumRender
import Testing

@Suite("Text reveal")
struct TextRevealTests {
  @Test("shows a text it starts with whole")
  func begin() {
    let reveal = TextReveal("你好，world")
    #expect(reveal.isSettled)
    #expect(reveal.visible(streaming: true) == "你好，world")
  }

  @Test("reveals a burst in proportion to the backlog, catching up in about 150 ms")
  func pacing() {
    var reveal = TextReveal("")
    reveal.retarget(String(repeating: "字", count: 600))
    reveal.advance(by: 1.0 / 60)
    // 600 × (1/60) / 0.15 = 66.7, rounded up.
    #expect(reveal.revealed == 67)
    var frames = 1
    while !reveal.isSettled {
      reveal.advance(by: 1.0 / 60)
      frames += 1
    }
    // The backlog shrinks by a factor of (1 − 1/9) a frame and by at least one character, so 600
    // characters take about 0.6 s at 60 Hz: two thirds are gone after one horizon.
    #expect(frames > 9 && frames < 60)
    var again = TextReveal("")
    again.retarget(String(repeating: "a", count: 600))
    for _ in 0..<9 { again.advance(by: 1.0 / 60) }
    #expect(again.revealed > 360 && again.revealed < 420)
  }

  @Test("finishes the tail one character at a time at least, and never overshoots")
  func tail() {
    var reveal = TextReveal("ab")
    reveal.retarget("abc")
    reveal.advance(by: 0.001)
    #expect(reveal.revealed == 3)
    reveal.advance(by: 1)
    #expect(reveal.revealed == 3)
  }

  @Test("shows everything after a stall and nothing new after no time")
  func stall() {
    var reveal = TextReveal("")
    reveal.retarget(String(repeating: "x", count: 1000))
    reveal.advance(by: 0)
    #expect(reveal.revealed == 0)
    reveal.advance(by: 10)
    #expect(reveal.revealed == 1000)
  }

  @Test("keeps what is shown when the text grows, cuts it when another text takes its place")
  func retarget() {
    var reveal = TextReveal("")
    reveal.retarget("hello world")
    reveal.advance(by: 1.0 / 60)
    let shown = reveal.revealed
    reveal.retarget("hello world, again")
    #expect(reveal.revealed == shown)
    reveal.retarget("hi")
    #expect(reveal.revealed == min(shown, 2))
  }

  @Test("never cuts inside an emoji, and holds back a character still being built")
  func graphemes() {
    var reveal = TextReveal("")
    reveal.retarget("a👨‍👩‍👧b")
    reveal.advance(by: 1.0 / 60)
    #expect(["a", "a👨‍👩‍👧", "a👨‍👩‍👧b"].contains(reveal.visible(streaming: true)))
    #expect(TextReveal("ok 👨\u{200D}").visible(streaming: true) == "ok ")
    #expect(TextReveal("ok 👨\u{200D}").visible(streaming: false) == "ok 👨\u{200D}")
    #expect(TextReveal("flag 🇨").visible(streaming: true) == "flag ")
    #expect(TextReveal("flag 🇨🇳").visible(streaming: true) == "flag 🇨🇳")
  }
}
