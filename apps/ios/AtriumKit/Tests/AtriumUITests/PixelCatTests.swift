import Foundation
import Testing

@testable import AtriumUI

/// The prototype's grids, one string per row (`pixel-cat-grids.json`).
///
/// - Remark: Written by running the prototype's own `pxMap` (from `const PXN` to `pixDraw` in
///   `prototypes/mobile-app-final-prototype.html`) in Node for every scene and pose and mapping its
///   cell names to one letter each; see `letter(_:)`.
private let prototypeGrids: [String: [String]] = {
  guard let url = Bundle.module.url(forResource: "pixel-cat-grids", withExtension: "json", subdirectory: "Fixtures"),
    let data = try? Data(contentsOf: url),
    let grids = try? JSONDecoder().decode([String: [String]].self, from: data)
  else { return [:] }
  return grids
}()

/// The letter the fixture writes for a cell.
///
/// - Remark: The prototype's names: `""` is ".", `x` is a space, `f2` is "F", the rest their own
///   letter.
/// - SideEffects: none
/// - Parameter cell: The cell.
/// - Returns: The letter.
private func letter(_ cell: PixelCat.Cell) -> Character {
  switch cell {
  case .empty: "."
  case .outside: " "
  case .body: "b"
  case .eye: "e"
  case .highlight: "w"
  case .nose: "n"
  case .blush: "k"
  case .ear: "p"
  case .toe: "t"
  case .tile: "f"
  case .tab: "F"
  case .ok: "g"
  case .check: "c"
  case .outline: "o"
  }
}

@Suite("Pixel cat")
struct PixelCatTests {
  /// The fixture's name for a scene.
  static let names: [(PixelCat.Scene, String)] = [
    (.sit, "sit"), (.tile, "tile"), (.peek, "peek"), (.asleep, "grey"), (.paired, "ok"),
  ]

  /// The fixture's poses.
  static let poses: [(PixelCat.Pose, String)] = [
    (.rest, "rest"), (PixelCat.Pose(blink: true), "blink"), (PixelCat.Pose(tilt: true), "tilt"),
    (PixelCat.Pose(flick: true), "flick"),
  ]

  @Test("draws every scene and pose cell for cell as the prototype")
  func matchesPrototype() throws {
    #expect(prototypeGrids.count == 17)
    for (scene, sceneName) in Self.names {
      for (pose, poseName) in Self.poses {
        guard let expected = prototypeGrids["\(sceneName)-\(poseName)"] else { continue }
        let rows = PixelCat.grid(scene, pose: pose).map { String($0.map(letter)) }
        #expect(rows == expected, "\(sceneName)-\(poseName)")
      }
    }
  }

  @Test("is 32 by 32")
  func size() {
    for scene in PixelCat.Scene.allCases {
      let grid = PixelCat.grid(scene)
      #expect(grid.count == 32)
      #expect(grid.allSatisfy { $0.count == 32 })
    }
  }

  @Test("sleeps with its eyes shut, whatever the pose")
  func asleep() {
    #expect(PixelCat.grid(.asleep, pose: PixelCat.Pose(tilt: true)) == PixelCat.grid(.asleep))
    #expect(!PixelCat.grid(.asleep).joined().contains(.highlight))
    #expect(PixelCat.grid(.tile).joined().contains(.highlight))
  }
}
