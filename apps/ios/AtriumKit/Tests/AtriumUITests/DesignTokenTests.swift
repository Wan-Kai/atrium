import SwiftUI
import Testing

@testable import AtriumUI

@Suite("Design tokens")
struct DesignTokenTests {
  @Test(
    "puts only Latin text and numbers in the serif",
    arguments: ["Atrium", "weather-app", "feat/radar-map", "482 916", "Café Crème", "v1.2 — “beta”", ""])
  func latin(_ text: String) {
    #expect(Typography.isLatinOnly(text))
    #expect(Typography.display(for: text, size: 23) == .system(size: 23, weight: .regular, design: .serif))
  }

  @Test(
    "falls back to PingFang semibold, a little smaller, for anything else",
    arguments: ["天气应用", "weather 应用", "ｗｅａｔｈｅｒ", "날씨", "погода", "cat 🐱", "かな"])
  func fallback(_ text: String) {
    #expect(!Typography.isLatinOnly(text))
    #expect(Typography.display(for: text, size: 23, cjkSize: 19) == .system(size: 19, weight: .semibold))
    #expect(Typography.display(for: text, size: 23) == .system(size: 19, weight: .semibold))
  }

  @Test("takes the paper colour table of design-language")
  func colours() {
    let rows: [(ColorToken, RGBA, RGBA)] = [
      (.page, RGBA(0xf6f2e9), RGBA(0x1c1a16)),
      (.note, RGBA(0xfffcf5), RGBA(0x25221d)),
      (.surface, RGBA(0xefe9dc), RGBA(0x2b2822)),
      (.text, RGBA(0x26221c), RGBA(0xeee9df)),
      (.text2, RGBA(0x4d473d), RGBA(0xcec7b9)),
      (.secondary, RGBA(0x8b8477), RGBA(0x8f887b)),
      (.tertiary, RGBA(0xd3cbbb), RGBA(0x4a453c)),
      (.line, RGBA(0x46371e, 0.11), RGBA(0xeee9df, 0.09)),
      (.tint, RGBA(0x8a7352), RGBA(0xc9b28c)),
      (.tintSoft, RGBA(0x8a7352, 0.14), RGBA(0xc9b28c, 0.16)),
      (.ink, RGBA(0x26221c), RGBA(0xeee9df)),
      (.onInk, RGBA(0xf6f2e9), RGBA(0x1c1a16)),
      (.attn, RGBA(0xc0651c), RGBA(0xe6944a)),
      (.danger, RGBA(0xc13f35), RGBA(0xec6a5e)),
      (.ok, RGBA(0x3d7a4a), RGBA(0x7bbf8a)),
      (.rail, RGBA(0x3c321e, 0.14), RGBA(0xfff0dc, 0.13)),
      (.node, RGBA(0xcbc3b4), RGBA(0x5f5951)),
      (.stickyStuck, RGBA(0xf4cdc4), RGBA(0xc2948a)),
      (.stickyStuckInk, RGBA(0x3d1913), RGBA(0x2a110d)),
      (.stickyWaiting, RGBA(0xf7dfb8), RGBA(0xc4a77c)),
      (.stickyWaitingInk, RGBA(0x3a2610), RGBA(0x24180a)),
      (.stickyReminder, RGBA(0xdfe0cf), RGBA(0xa8aa95)),
      (.stickyReminderInk, RGBA(0x262a17), RGBA(0x1d2012)),
    ]
    for (token, light, dark) in rows {
      #expect(token.value(in: .light) == light, "\(token)")
      #expect(token.value(in: .dark) == dark, "\(token)")
    }
  }

  @Test("gives every token a solid or translucent value in both appearances")
  func complete() {
    for token in ColorToken.allCases {
      for scheme in [ColorScheme.light, .dark] {
        let value = token.value(in: scheme)
        #expect(value.opacity > 0 && value.opacity <= 1)
        #expect(value.hex <= 0xffffff)
      }
    }
    #expect(ColorToken.glassSolid.value(in: .light).opacity == 1)
    #expect(ColorToken.glassSolid.value(in: .dark).opacity == 1)
  }

  @Test("gallery reductions preserve system preferences and can only add restrictions")
  func accessibility() {
    var environment = EnvironmentValues()
    #expect(environment.atriumReduceMotion == environment.accessibilityReduceMotion)
    #expect(environment.atriumReduceTransparency == environment.accessibilityReduceTransparency)
    environment.atriumAccessibilityReductions = AccessibilityReductions(motion: true, transparency: true)
    #expect(environment.atriumReduceMotion)
    #expect(environment.atriumReduceTransparency)
  }

  @Test("maps the three springs one to one")
  func springs() {
    let expected: [(MotionToken, Double, Double)] = [(.smooth, 0.42, 0), (.snappy, 0.30, 0.15), (.bouncy, 0.40, 0.26)]
    for (token, duration, bounce) in expected {
      let motion = token.resolved(reduceMotion: false)
      #expect(motion.animation == .spring(duration: duration, bounce: bounce))
      #expect(motion.allowsScale && motion.allowsSpatialMotion)
    }
  }

  @Test("turns every token into a 0.18 s cross-fade that may not scale or move, with Reduce Motion")
  func reduced() {
    for token in MotionToken.allCases {
      let motion = token.resolved(reduceMotion: true)
      #expect(motion.animation == .easeInOut(duration: 0.18))
      #expect(!motion.allowsScale)
      #expect(!motion.allowsSpatialMotion)
    }
    #expect(Motion.fold(reduceMotion: true) == .reduced)
    #expect(Motion.fold(reduceMotion: false).animation == .timingCurve(0.45, 0, 0.15, 1, duration: 0.4))
  }
}
