import Testing

@testable import AtriumUI

@Suite("Pixel cat: drawn in characters")
struct PixelCatGlyphsTests {
  /// The sitting cat at rest, for the shading tests.
  private let sitting = PixelCat.grid(.tile)

  /// Every body cell with no neighbour outside the body, with its row.
  ///
  /// - Remark: The cells the shading ramp decides; edges take their own glyphs.
  /// - SideEffects: none
  /// - Parameter grid: The grid.
  /// - Returns: The inner body cells.
  private func innerBody(_ grid: [[PixelCat.Cell]]) -> [(row: Int, column: Int)] {
    var cells: [(Int, Int)] = []
    for row in 1..<(PixelCat.size - 1) {
      for column in 1..<(PixelCat.size - 1) where grid[row][column] == .body {
        let around = [grid[row - 1][column], grid[row + 1][column], grid[row][column - 1], grid[row][column + 1]]
        if around.allSatisfy({ $0 != .empty && $0 != .outside && $0 != .outline && $0 != .tile }) {
          cells.append((row, column))
        }
      }
    }
    return cells
  }

  @Test("the lit top of the body takes sparse glyphs and the shaded bottom dense ones, as ascii-sharks")
  func shading() throws {
    let inner = innerBody(sitting)
    let top = try #require(inner.min { $0.row < $1.row })
    let bottom = try #require(inner.max { $0.row < $1.row })
    let level = { (cell: (row: Int, column: Int)) -> Int in
      let glyph = PixelCatGlyphs.glyph(in: self.sitting, row: cell.row, column: cell.column, tick: nil)
      return PixelCatGlyphs.ramp.firstIndex(of: glyph ?? " ") ?? -1
    }
    let topLevels = inner.filter { $0.row <= top.row + 2 }.map(level)
    let bottomLevels = inner.filter { $0.row >= bottom.row - 2 }.map(level)
    #expect(!topLevels.contains(-1) && !bottomLevels.contains(-1))
    let mean = { (levels: [Int]) in Double(levels.reduce(0, +)) / Double(levels.count) }
    #expect(mean(bottomLevels) - mean(topLevels) >= 2)
  }

  @Test("the body's rim takes edge glyphs; features keep fixed glyphs; nothing is drawn outside")
  func fixedGlyphs() throws {
    var rim: Character?
    var eye: Character?
    var nose: Character?
    var outside: Character??
    for row in 0..<PixelCat.size {
      for column in 0..<PixelCat.size {
        let glyph = PixelCatGlyphs.glyph(in: sitting, row: row, column: column, tick: nil)
        switch sitting[row][column] {
        case .eye: eye = glyph
        case .nose: nose = glyph
        case .outside: outside = .some(glyph)
        case .body where row > 0 && sitting[row - 1][column] == .tile: rim = glyph
        default: break
        }
      }
    }
    #expect(PixelCatGlyphs.edges.contains(try #require(rim)))
    #expect(eye == "@")
    #expect(nose == "v")
    #expect(outside == .some(nil))
  }

  @Test("the shimmer changes a few cells a tick, the same ones for the same tick, and none without a tick")
  func shimmer() {
    var cells = 0
    var changedEver = Set<Int>()
    for tick in 0..<40 {
      var changed = 0
      for row in 0..<PixelCat.size {
        for column in 0..<PixelCat.size where sitting[row][column] == .body || sitting[row][column] == .tile {
          if tick == 0 { cells += 1 }
          let still = PixelCatGlyphs.glyph(in: sitting, row: row, column: column, tick: nil)
          let moving = PixelCatGlyphs.glyph(in: sitting, row: row, column: column, tick: tick)
          #expect(moving == PixelCatGlyphs.glyph(in: sitting, row: row, column: column, tick: tick))
          if moving != still {
            changed += 1
            changedEver.insert(row * PixelCat.size + column)
          }
        }
      }
      #expect(changed > 0)
      #expect(Double(changed) <= Double(cells) * 0.1)
    }
    #expect(changedEver.count > cells / 4)
  }
}
