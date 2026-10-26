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

  @Test("takes the colour table of design-language and the final prototype")
  func colours() {
    let rows: [(ColorToken, RGBA, RGBA)] = [
      (.page, RGBA(0xfaf9f5), RGBA(0x1c1b19)),
      (.surface, RGBA(0xf3f1eb), RGBA(0x252421)),
      (.text, RGBA(0x1f1e1c), RGBA(0xf2efe8)),
      (.text2, RGBA(0x3d3b37), RGBA(0xd9d5cc)),
      (.secondary, RGBA(0x86827a), RGBA(0x9b968c)),
      (.tertiary, RGBA(0xcbc6bc), RGBA(0x504c46)),
      (.tint, RGBA(0x2f6fed), RGBA(0x8fb0ff)),
      (.attn, RGBA(0xd97a1e), RGBA(0xe08a35)),
      (.attnText, RGBA(0xb3600b), RGBA(0xeda25a)),
      (.danger, RGBA(0xd4463d), RGBA(0xef6b5f)),
      (.ok, RGBA(0x2f8a46), RGBA(0x4caf68)),
      (.okText, RGBA(0x2c7a3e), RGBA(0x74c98a)),
      (.rail, RGBA(0x3c321e, 0.14), RGBA(0xfff0dc, 0.13)),
      (.branch, RGBA(0x3c321e, 0.26), RGBA(0xfff0dc, 0.26)),
      (.node, RGBA(0xcbc3b4), RGBA(0x5f5951)),
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
