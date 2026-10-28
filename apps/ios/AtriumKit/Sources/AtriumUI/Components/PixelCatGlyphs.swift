/// The pixel cat drawn in characters instead of dots, after ascii-sharks (design-language "像素猫插图").
///
/// - Remark: The same grids and poses as the dots, so the cat keeps its shape and its moves; only a
///   cell's mark changes. The body is shaded by density, as ascii-sharks shades its sharks: sparse
///   glyphs where the light from the top left falls, dense ones in shadow, with a little per-cell
///   noise so it reads as fur; the rim of the body takes light edge glyphs; features keep fixed
///   ones. The shimmer flips a few cells to a neighbouring glyph each tick, picked by a hash of
///   the cell and the tick, so a tick always looks the same and nothing is stored. Pure, so it is
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
    let size = PixelCat.size
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
      let notCat = { (r: Int, c: Int) in
        r < 0 || c < 0 || r >= size || c >= size || notCatCells.contains(grid[r][c])
      }
      let onRim =
        notCat(row - 1, column) || notCat(row + 1, column) || notCat(row, column - 1) || notCat(row, column + 1)
      if onRim { return edges[Int(hash(row, column, 2) % UInt64(edges.count))] }
      let light = 1 - 0.75 * Double(row) / Double(size) - 0.2 * Double(column) / Double(size)
      let noise = Int(hash(row, column, 3) % 3) - 1
      let level = Int(((1 - light) * Double(ramp.count - 1)).rounded()) + noise
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
