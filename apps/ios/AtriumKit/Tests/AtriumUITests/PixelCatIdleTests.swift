import Testing

@testable import AtriumUI

@Suite("Pixel cat idling")
struct PixelCatIdleTests {
  @Test("starts one action every 4 to 6 seconds", arguments: [0, 7, 0xdead_beef] as [UInt64])
  func spacing(seed: UInt64) {
    let starts = (Int64(0)..<400).map { PixelCatIdle.start(of: $0, seed: seed) }
    for (earlier, later) in zip(starts, starts.dropFirst()) {
      #expect(later - earlier > 4 && later - earlier < 6)
    }
  }

  @Test("blinks about two times in three, otherwise tilts or flicks")
  func mix() {
    let actions = (Int64(0)..<3000).map { PixelCatIdle.action(of: $0, seed: 42) }
    let blinks = Double(actions.filter { $0 == .blink }.count) / 3000
    let tilts = Double(actions.filter { $0 == .tilt }.count) / 3000
    #expect(abs(blinks - 0.66) < 0.03)
    #expect(abs(tilts - 0.17) < 0.03)
    #expect(actions.contains(.flick))
  }

  @Test("holds each pose for its length, then rests")
  func poses() throws {
    let seed: UInt64 = 3
    for index in Int64(1)..<60 {
      let start = PixelCatIdle.start(of: index, seed: seed)
      #expect(PixelCatIdle.pose(at: start - 0.01, seed: seed) == .rest)
      switch PixelCatIdle.action(of: index, seed: seed) {
      case .blink:
        #expect(PixelCatIdle.pose(at: start + 0.01, seed: seed) == PixelCat.Pose(blink: true))
        #expect(PixelCatIdle.pose(at: start + 0.14, seed: seed) == PixelCat.Pose(blink: true))
        #expect(PixelCatIdle.pose(at: start + 0.16, seed: seed) == .rest)
      case .tilt:
        #expect(PixelCatIdle.pose(at: start + 0.51, seed: seed) == PixelCat.Pose(tilt: true))
        #expect(PixelCatIdle.pose(at: start + 0.53, seed: seed) == .rest)
      case .flick:
        #expect(PixelCatIdle.pose(at: start + 0.05, seed: seed) == PixelCat.Pose(flick: true))
        #expect(PixelCatIdle.pose(at: start + 0.18, seed: seed) == .rest)
        #expect(PixelCatIdle.pose(at: start + 0.30, seed: seed) == PixelCat.Pose(flick: true))
        #expect(PixelCatIdle.pose(at: start + 0.37, seed: seed) == .rest)
      }
    }
  }

  @Test("lists every moment the pose changes, and only those")
  func changes() {
    let seed: UInt64 = 9
    let from = 1_000_000.3
    let moments = PixelCatIdle.changes(after: from, seed: seed, count: 40)
    #expect(moments.count == 40)
    #expect(moments.allSatisfy { $0 > from })
    #expect(moments == moments.sorted())
    var previous = PixelCatIdle.pose(at: from, seed: seed)
    var time = from
    var seen: [Double] = []
    while time < moments[39] {
      time += 0.005
      let pose = PixelCatIdle.pose(at: time, seed: seed)
      if pose != previous { seen.append(time) }
      previous = pose
    }
    #expect(seen.count == moments.count - 1 || seen.count == moments.count)
    for moment in seen {
      #expect(moments.contains { abs($0 - moment) < 0.006 })
    }
  }

  @Test("does the same for the same seed and differently for another")
  func seeded() {
    let first = (Int64(0)..<50).map { PixelCatIdle.start(of: $0, seed: 1) }
    #expect(first == (Int64(0)..<50).map { PixelCatIdle.start(of: $0, seed: 1) })
    #expect(first != (Int64(0)..<50).map { PixelCatIdle.start(of: $0, seed: 2) })
  }
}
