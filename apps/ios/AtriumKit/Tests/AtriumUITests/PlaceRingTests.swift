import CoreGraphics
import Foundation
import Testing

@testable import AtriumUI

/// The home "+"'s ring of places (design-language "手机端 · 首页", 2026-10-29).
@Suite struct PlaceRingTests {
  /// Checks the keys sit 48° apart from -84°, and turning moves them along.
  ///
  /// - Remark: Turning by one slot puts the second key where the first was.
  /// - SideEffects: none
  @Test func placesKeysAlongTheRing() {
    #expect(PlaceRing.angle(index: 0, scroll: 0) == -84)
    #expect(PlaceRing.angle(index: 2, scroll: 0) == -180)
    #expect(PlaceRing.angle(index: 1, scroll: 1) == -84)
  }

  /// Checks the keys sit close round the "+" without touching it or each other.
  ///
  /// - Remark: design-language "手机端 · 首页": 92pt out, so a key's edge is about 37pt from the
  ///   "+"'s; neighbours keep room for a name between them.
  /// - SideEffects: none
  @Test func keepsKeysCloseToThePlus() {
    #expect(PlaceRing.radius == 92)
    let first = PlaceRing.point(angle: PlaceRing.angle(index: 0, scroll: 0))
    let second = PlaceRing.point(angle: PlaceRing.angle(index: 1, scroll: 0))
    #expect(hypot(first.x - second.x, first.y - second.y) > PlaceRing.size + 20)
  }

  /// Checks the frosted pad behind the ring covers the keys shown and their names, and no more.
  ///
  /// - Remark: design-language "手机端 · 首页": only the "+" and the ring get a backdrop and take
  ///   touches; a name hangs about 22pt under its key. The pad stays well inside a 390pt screen.
  /// - SideEffects: none
  @Test func padsOnlyTheRing() {
    for index in 0..<PlaceRing.shown {
      let key = PlaceRing.point(angle: PlaceRing.angle(index: index, scroll: 0))
      #expect(hypot(key.x, key.y + 22) + PlaceRing.size / 2 <= PlaceRing.pad)
    }
    #expect(PlaceRing.pad <= 160)
    #expect(PlaceRing.feather > 0)
  }

  /// Checks how far the ring turns: none with a screenful, the overflow otherwise.
  ///
  /// - Remark: Three keys fit; the last one turns no further than the third slot.
  /// - SideEffects: none
  @Test func turnsOnlyAsFarAsTheOverflow() {
    #expect(PlaceRing.maxScroll(count: 2) == 0)
    #expect(PlaceRing.maxScroll(count: 3) == 0)
    #expect(PlaceRing.maxScroll(count: 9) == 6)
  }

  /// Checks the rubber band past either end gives a third of the pull.
  ///
  /// - Remark: Inside the range the turn is as dragged.
  /// - SideEffects: none
  @Test func rubberBandsPastTheEnds() {
    #expect(PlaceRing.rubber(2, max: 4) == 2)
    #expect(PlaceRing.rubber(-1, max: 4) == -0.35)
    #expect(PlaceRing.rubber(5, max: 4) == 4.35)
  }

  /// Checks a release lands on a whole slot, carried by its speed, and stays in range.
  ///
  /// - Remark: The speed is in slots a drag event; it throws nine times that far.
  /// - SideEffects: none
  @Test func settlesOnASlot() {
    #expect(PlaceRing.settle(scroll: 1.4, velocity: 0, max: 4) == 1)
    #expect(PlaceRing.settle(scroll: 1.4, velocity: 0.1, max: 4) == 2)
    #expect(PlaceRing.settle(scroll: 0, velocity: 0.06, max: 4) == 1)
    #expect(PlaceRing.settle(scroll: 3.8, velocity: 0.5, max: 4) == 4)
    #expect(PlaceRing.settle(scroll: -0.3, velocity: -0.2, max: 4) == 0)
  }

  /// Checks a drag's angle step wraps across ±180°.
  ///
  /// - Remark: Going from 179° to -179° is 2°, not -358°.
  /// - SideEffects: none
  @Test func wrapsAngleSteps() {
    #expect(PlaceRing.step(from: 179, to: -179) == 2)
    #expect(PlaceRing.step(from: -179, to: 179) == -2)
    #expect(PlaceRing.step(from: -100, to: -90) == 10)
  }

  /// Checks keys outside the three slots fade out over most of a slot, at either end.
  ///
  /// - Remark: Fully shown from -84° to -180°, gone 60% of a slot past either.
  /// - SideEffects: none
  @Test func fadesKeysOutsideTheSlots() {
    #expect(PlaceRing.fade(angle: -120) == 1)
    #expect(PlaceRing.fade(angle: -84) == 1)
    #expect(PlaceRing.fade(angle: -180) == 1)
    #expect(abs(PlaceRing.fade(angle: -84 + 14.4) - 0.5) < 0.001)
    #expect(abs(PlaceRing.fade(angle: -180 - 14.4) - 0.5) < 0.001)
    #expect(PlaceRing.fade(angle: -50) == 0)
    #expect(PlaceRing.fade(angle: -228) == 0)
  }

  /// Checks a tap finds the key under it, and nothing between keys or past the fade.
  ///
  /// - Remark: Points are from the "+"'s centre.
  /// - SideEffects: none
  @Test func findsTheKeyUnderATap() {
    let second = PlaceRing.point(angle: PlaceRing.angle(index: 1, scroll: 0))
    #expect(PlaceRing.key(at: CGPoint(x: second.x + 10, y: second.y - 8), count: 6, scroll: 0) == 1)
    #expect(PlaceRing.key(at: .zero, count: 6, scroll: 0) == nil)
    let third = PlaceRing.point(angle: PlaceRing.angle(index: 2, scroll: 0))
    let between = CGPoint(x: (second.x + third.x) / 2, y: (second.y + third.y) / 2)
    #expect(PlaceRing.key(at: between, count: 6, scroll: 0) == nil)
    let gone = PlaceRing.point(angle: PlaceRing.angle(index: 0, scroll: 2))
    #expect(PlaceRing.key(at: gone, count: 6, scroll: 2) == nil)
    let waiting = PlaceRing.point(angle: PlaceRing.angle(index: 3, scroll: 0))
    #expect(PlaceRing.key(at: waiting, count: 6, scroll: 0) == nil)
  }

  /// Checks the ripple: each key a little after the one before, its name after it lands.
  ///
  /// - Remark: design-language "手机端 · 首页": 0.028 s apart, names 0.2 s later.
  /// - SideEffects: none
  @Test func ripplesKeysOutInOrder() {
    #expect(PlaceRing.delay(order: 0) == 0)
    #expect(abs(PlaceRing.delay(order: 3) - 0.084) < 0.0001)
    #expect(abs(PlaceRing.labelDelay(order: 3) - 0.284) < 0.0001)
  }
}
