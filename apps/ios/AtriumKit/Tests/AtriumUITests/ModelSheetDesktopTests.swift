import Foundation
import Testing

@testable import AtriumUI

/// The model sheet's parts copied from the desktop's model panel (design-language "手机端 · 模型 sheet").
@Suite("Model sheet as the desktop")
struct ModelSheetDesktopTests {
  /// Checks the thinking box's dots match the desktop's `paintDots` for the box.
  ///
  /// - Remark: The expected values came from running `packages/ui/src/design/dots.ts` in Node on a
  ///   168×38 box (three levels) with seed 1: two-thirds covered in light, and full in dark at 1 s
  ///   halfway through a sweep. Only the full box's colour differs (the theme's deep beige, not the
  ///   desktop's blue to peach), so only its alpha is compared.
  /// - SideEffects: none
  @Test func dotsMatchTheDesktop() {
    let plain = EffortDots.dots(width: 168, height: 38, coverage: 2.0 / 3, full: false, dark: false, now: 0, sweep: nil)
    #expect(plain.count == 140)
    let plainSample = [plain[0], plain[7], plain[40], plain[139]].map { Self.describe($0) }
    #expect(plainSample == ["0.142@1.20,-0.80", "0.172@43.20,-0.80", "0.136@1.20,11.20", "0.027@115.20,35.20"])
    let full = EffortDots.dots(width: 168, height: 38, coverage: 1, full: true, dark: true, now: 1000, sweep: 0.5)
    #expect(full.count == 196)
    let fullSample = [full[0], full[33], full[90], full[195]].map { Self.describe($0) }
    #expect(fullSample == ["0.185@1.20,-0.80", "0.359@31.20,5.20", "0.251@37.20,17.20", "0.186@163.20,35.20"])
  }

  /// Checks a drag past either end is pulled back, harder the further it goes.
  ///
  /// - Remark: The desktop's `rubber`.
  /// - SideEffects: none
  @Test func rubberBandsPastTheEnds() {
    #expect(ThinkingBox.rubber(0.4) == 0.4)
    #expect(abs(ThinkingBox.rubber(-0.5) - -0.2) < 1e-9)
    #expect(abs(ThinkingBox.rubber(1.5) - 1.2) < 1e-9)
  }

  /// Checks the level nearest a coverage, and the cell under a tap.
  ///
  /// - Remark: The desktop's `nearestLevel` and its click branch.
  /// - SideEffects: none
  @Test func picksLevelsAsTheDesktop() {
    #expect(ThinkingBox.nearestLevel(0.6, count: 4) == 1)
    #expect(ThinkingBox.nearestLevel(0.65, count: 4) == 2)
    #expect(ThinkingBox.nearestLevel(-0.3, count: 4) == 0)
    #expect(ThinkingBox.nearestLevel(1.3, count: 4) == 3)
    #expect(ThinkingBox.tappedLevel(0.3, count: 4) == 1)
    #expect(ThinkingBox.tappedLevel(0, count: 4) == 0)
    #expect(ThinkingBox.tappedLevel(1, count: 4) == 3)
  }

  /// Checks a provider half out of the column is faint and blurred, and one in view is clear.
  ///
  /// - Remark: The scroll transition's phase goes from 0 in view to ±1 just out of it.
  /// - SideEffects: none
  @Test func providersFadeAtTheEdges() {
    #expect(ProviderColumn.edge(0) == ProviderColumn.Edge(opacity: 1, blur: 0))
    #expect(ProviderColumn.edge(-0.5) == ProviderColumn.Edge(opacity: 0.5, blur: 2))
    #expect(ProviderColumn.edge(1) == ProviderColumn.Edge(opacity: 0, blur: 4))
  }

  /// Checks the bolt is the desktop's Hugeicons Flash on its 24 grid.
  ///
  /// - Remark: Its outline reaches about x 4.8 to 19.2 and y 2 to 22, centred on the grid.
  /// - SideEffects: none
  @Test func boltIsTheDesktopFlash() throws {
    let bounds = try #require(FastBolt.path).boundingBoxOfPath
    #expect((4.5...5.3).contains(bounds.minX) && (18.7...19.5).contains(bounds.maxX))
    #expect((1.7...2.3).contains(bounds.minY) && (21.7...22.3).contains(bounds.maxY))
  }

  /// A dot as the desktop's test wrote it.
  ///
  /// - Remark: Alpha to three places, the corner to two.
  /// - SideEffects: none
  /// - Parameter dot: The dot.
  /// - Returns: "alpha@x,y".
  private static func describe(_ dot: EffortDots.Dot) -> String {
    String(format: "%.3f@%.2f,%.2f", dot.alpha, dot.origin.x, dot.origin.y)
  }
}
