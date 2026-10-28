/// The pixel cat drawn in characters instead of dots, after ascii-sharks (design-language "像素猫插图").
///
/// - Remark: The same grids as the dots, so the cat keeps its shape; only a cell's mark changes.
///   As ascii-sharks shades its sharks, every body and tile cell has a light: the light from the
///   top left falls on the cream body, which runs from nearly white to deep brown in the bottom
///   right, with per-cell noise so it reads as fur; the view colours the cell's block by it, and
///   the character follows it too, sparse glyphs where it is lit and dense ones in shadow. The rim
///   of the body is a little lighter and takes edge glyphs; features keep fixed glyphs and their
///   own colours. The shimmer flips a few cells to a neighbouring glyph each tick, picked by a hash
///   of the cell and the tick, so a tick always looks the same and nothing is stored. The head tilt
///   is left out: one row shifted sideways reads as a broken head in characters. Pure, so it is
///   tested on macOS; `PixelCatView` draws it.
nonisolated enum PixelCatGlyphs {
  /// The body's shading ramp, lit to shaded (ascii-sharks' skin ramp).
  static let ramp: [Character] = Array(":;t%SX8#@")
  /// The glyphs on the body's rim.
  static let edges: [Character] = Array(".',`")
  /// The tile's and the folder's texture.
  private static let weave: [Character] = Array("%S8#")
  /// In how many cells of a hundred the shimmer flips a glyph each tick.
  private static let shimmerPercent: UInt64 = 5
  /// The cells round the cat that make a body cell part of its rim.
  private static let notCatCells: Set<PixelCat.Cell> = [.empty, .outside, .outline, .tile, .tab]

  /// Tells whether the shimmer may flip a cell on a tick.
  ///
  /// - Remark: Only a hash, so a drawing can skip the cells a tick leaves alone before working out
  ///   their glyph; a cell it names flips if it is body or tile and not on the rim.
  /// - SideEffects: none
  /// - Parameters:
  ///   - row: The cell's row.
  ///   - column: The cell's column.
  ///   - tick: The tick.
  /// - Returns: Whether it may flip.
  static func mayFlip(row: Int, column: Int, tick: Int) -> Bool {
    roll(row, column, tick) % 100 < shimmerPercent
  }

  /// The shimmer's roll for a cell on a tick.
  ///
  /// - Remark: See `mayFlip`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - row: The row.
  ///   - column: The column.
  ///   - tick: The tick.
  /// - Returns: The roll.
  private static func roll(_ row: Int, _ column: Int, _ tick: Int) -> UInt64 {
    hash(row, column, 100 + UInt64(truncatingIfNeeded: tick))
  }

  /// The pose the character cat takes for the idle cat's pose: the same without the head tilt.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter pose: The idle cat's pose.
  /// - Returns: The pose to draw.
  static func pose(_ pose: PixelCat.Pose) -> PixelCat.Pose {
    var drawn = pose
    drawn.tilt = false
    return drawn
  }

  /// How lit a body or tile cell is, from 0 (deep shadow) to 1 (full light), in eight steps.
  ///
  /// - Remark: See the type. Light falls from the top left: the body loses it fast downwards and a
  ///   little to the right, its rim catches a little more, and ±0.12 of noise breaks it into fur;
  ///   the tile and folder are shaded the same way, more gently. Stepped so a drawing uses a few
  ///   colours. `nil` for every other cell.
  /// - SideEffects: none
  /// - Parameters:
  ///   - grid: The cat's cells.
  ///   - row: The cell's row.
  ///   - column: The cell's column.
  /// - Returns: The light, or `nil`.
  static func light(in grid: [[PixelCat.Cell]], row: Int, column: Int) -> Double? {
    let size = Double(PixelCat.size)
    let down = Double(row) / size
    let across = Double(column) / size
    let noise = Double(hash(row, column, 3) % 1000) / 1000 * 0.24 - 0.12
    let raw: Double
    switch grid[row][column] {
    case .body:
      raw = 1.25 - 1.15 * down - 0.35 * across + noise + (onRim(grid, row, column) ? 0.1 : 0)
    case .tile, .tab:
      raw = 0.8 - 0.45 * down - 0.2 * across + noise * 0.8
    default:
      return nil
    }
    return (min(max(raw, 0), 1) * 7).rounded() / 7
  }

  /// Tells whether a body cell touches something that is not the cat.
  ///
  /// - Remark: Its four neighbours, and the edge of the grid.
  /// - SideEffects: none
  /// - Parameters:
  ///   - grid: The cells.
  ///   - row: The row.
  ///   - column: The column.
  /// - Returns: Whether it is on the rim.
  private static func onRim(_ grid: [[PixelCat.Cell]], _ row: Int, _ column: Int) -> Bool {
    let size = PixelCat.size
    let notCat = { (r: Int, c: Int) in
      r < 0 || c < 0 || r >= size || c >= size || notCatCells.contains(grid[r][c])
    }
    return notCat(row - 1, column) || notCat(row + 1, column) || notCat(row, column - 1) || notCat(row, column + 1)
  }

  /// The character for one cell, or `nil` when nothing is drawn there.
  ///
  /// - Remark: See the type. A body cell is on the rim when one of its four neighbours is not cat.
  /// - SideEffects: none
  /// - Parameters:
  ///   - grid: The cat's cells, from `PixelCat.grid`.
  ///   - row: The cell's row.
  ///   - column: The cell's column.
  ///   - tick: The shimmer's tick, or `nil` for a still cat.
  /// - Returns: The character.
  static func glyph(in grid: [[PixelCat.Cell]], row: Int, column: Int, tick: Int?) -> Character? {
    switch grid[row][column] {
    case .outside: return nil
    case .empty, .outline: return "."
    case .eye: return "@"
    case .highlight: return "'"
    case .nose: return "v"
    case .blush: return "*"
    case .ear: return ";"
    case .toe: return ","
    case .tab: return "="
    case .ok: return "#"
    case .check: return "+"
    case .tile:
      return pick(weave, at: Int(hash(row, column, 1) % UInt64(weave.count)), row: row, column: column, tick: tick)
    case .body:
      if onRim(grid, row, column) { return edges[Int(hash(row, column, 2) % UInt64(edges.count))] }
      let shade = 1 - (light(in: grid, row: row, column: column) ?? 1)
      let level = Int((shade * Double(ramp.count - 1)).rounded())
      return pick(ramp, at: min(max(level, 0), ramp.count - 1), row: row, column: column, tick: tick)
    }
  }

  /// A glyph from a set, moved one place by the shimmer on its ticks.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - set: The glyphs, in order.
  ///   - index: The glyph without shimmer.
  ///   - row: The cell's row.
  ///   - column: The cell's column.
  ///   - tick: The shimmer's tick, or `nil`.
  /// - Returns: The glyph.
  private static func pick(_ set: [Character], at index: Int, row: Int, column: Int, tick: Int?) -> Character {
    guard let tick else { return set[index] }
    let roll = roll(row, column, tick)
    guard roll % 100 < shimmerPercent else { return set[index] }
    let step = (roll / 100) % 2 == 0 ? 1 : -1
    let moved = index + step
    return set[moved >= 0 && moved < set.count ? moved : index - step]
  }

  /// A stable hash of a cell and a salt.
  ///
  /// - Remark: One SplitMix64 round over the three numbers packed together: cheap enough to run on
  ///   every cell each tick, and the same between launches.
  /// - SideEffects: none
  /// - Parameters:
  ///   - row: The row.
  ///   - column: The column.
  ///   - salt: What the hash is for.
  /// - Returns: The hash.
  private static func hash(_ row: Int, _ column: Int, _ salt: UInt64) -> UInt64 {
    var value = (UInt64(truncatingIfNeeded: row) << 48) ^ (UInt64(truncatingIfNeeded: column) << 32) ^ salt
    value = value &+ 0x9e37_79b9_7f4a_7c15
    value = (value ^ (value >> 30)) &* 0xbf58_476d_1ce4_e5b9
    value = (value ^ (value >> 27)) &* 0x94d0_49bb_1331_11eb
    return value ^ (value >> 31)
  }
}
