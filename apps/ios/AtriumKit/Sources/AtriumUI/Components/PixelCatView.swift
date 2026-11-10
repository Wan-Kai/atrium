import SwiftUI

/// Paints the pixel cat (design-language "像素猫插图"), idling unless asleep or Reduce Motion is on.
///
/// - Remark: Dots are 0.7 of their cell with corners of 0.3 of a dot, as the prototype's canvas.
///   Colours: cream (lighter at the top) is the cat, ink its features, the deep beige tint what is not
///   the cat (the paper redesign; it was grey-blue), pink the blush and ears; in dark mode the ring goes
///   and the tile darkens. The timeline only
///   fires when `PixelCatIdle` says the pose changes, so an idle cat costs nothing between moves.
struct PixelCatView: View {
  /// Where the cat is.
  let scene: PixelCat.Scene
  /// The width and height, in points: 160 for empty states, 128 smaller, about 72 on the new session
  /// page.
  var size: CGFloat = 160
  /// Picks this cat's moves, so two cats on one screen do not move together and tests can pin them.
  var seed: UInt64 = 0
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The cat, in its current pose.
  var body: some View {
    let still = reduceMotion || scene == .asleep
    TimelineView(PixelCatSchedule(seed: seed, paused: still)) { context in
      let pose =
        still ? .rest : PixelCatIdle.pose(at: context.date.timeIntervalSinceReferenceDate, seed: seed)
      PixelCatCanvas(
        grid: PixelCat.grid(scene, pose: pose), colors: PixelCatColors(scheme: scheme, asleep: scene == .asleep),
        sitting: scene == .sit)
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// Draws one grid of the pixel cat.
///
/// - Remark: Split from `PixelCatView` so a pose that did not change does not repaint: the grid is
///   equatable.
private struct PixelCatCanvas: View, Equatable {
  /// The cells.
  let grid: [[PixelCat.Cell]]
  /// The colours.
  let colors: PixelCatColors
  /// Whether the cat sits on nothing, so empty cells are not drawn.
  let sitting: Bool

  /// The dots.
  var body: some View {
    Canvas { graphics, canvasSize in
      let pitch = canvasSize.width / CGFloat(PixelCat.size)
      let dot = pitch * 0.7
      let inset = (pitch - dot) / 2
      for (row, cells) in grid.enumerated() {
        for (column, cell) in cells.enumerated() {
          let centre = hypot(Double(column) - 15.5, Double(row) - 15.5)
          if cell == .empty && (sitting || centre > 15.6) { continue }
          guard let color = colors.color(of: cell, row: row) else { continue }
          let rect = CGRect(
            x: CGFloat(column) * pitch + inset,
            y: CGFloat(row) * pitch + inset,
            width: dot,
            height: dot
          )
          graphics.fill(Path(roundedRect: rect, cornerRadius: dot * 0.3), with: .color(color))
        }
      }
    }
  }
}

/// The pixel cat's colours in an appearance (the prototype's `--px-*`).
///
/// - Remark: The asleep cat is greyed: grey body, faded ink and pink, a faint tile.
struct PixelCatColors: Equatable {
  /// Light or dark.
  let scheme: ColorScheme
  /// Whether the cat is asleep and greyed.
  let asleep: Bool

  /// A cell's colour, or `nil` for a cell that is not drawn.
  ///
  /// - Remark: The body shades from the lighter cream at the top to the darker at the bottom.
  /// - SideEffects: none
  /// - Parameters:
  ///   - cell: The cell.
  ///   - row: Its row, for the shading.
  /// - Returns: The colour.
  func color(of cell: PixelCat.Cell, row: Int) -> Color? {
    let dark = scheme == .dark
    let creamTop = asleep ? (dark ? 0x6e685f : 0xc8bfaf) : 0xfbf3e6
    let creamBottom = asleep ? (dark ? 0x5d5850 : 0xb5ab98) : 0xe9d8bf
    let ink: UInt32 = asleep ? (dark ? 0x2a2724 : 0x7d766b) : 0x1f2537
    switch cell {
    case .outside: return nil
    case .empty: return dark ? RGBA(0xfff0dc, 0.05).color : RGBA(0x3c321e, 0.05).color
    case .body: return Self.mix(UInt32(creamTop), UInt32(creamBottom), Double(row) / Double(PixelCat.size))
    case .eye, .nose: return RGBA(ink).color
    case .highlight: return RGBA(0xffffff).color
    case .blush, .ear: return RGBA(asleep ? (dark ? 0x7a6a64 : 0xd3bfb4) : (dark ? 0xd9938b : 0xf0aea6)).color
    case .tile:
      if asleep { return dark ? RGBA(0xfff0dc, 0.08).color : RGBA(0x3c321e, 0.1).color }
      return RGBA(dark ? 0x7a6648 : 0x8a7352).color
    case .tab: return RGBA(dark ? 0x56483a : 0xc9b896).color
    case .toe: return Self.mix(UInt32(creamTop), ink, 0.5)
    case .ok: return RGBA(dark ? 0x7bbf8a : 0x3d7a4a).color
    case .check: return RGBA(0xfbf3e6).color
    case .outline: return dark ? nil : RGBA(0x46371e, 0.42).color
    }
  }

  /// Mixes two colours.
  ///
  /// - Remark: Channel by channel in sRGB, as the prototype's canvas.
  /// - SideEffects: none
  /// - Parameters:
  ///   - from: The first, `0xRRGGBB`.
  ///   - to: The second.
  ///   - amount: How far towards the second, 0 to 1.
  /// - Returns: The mix.
  private static func mix(_ from: UInt32, _ to: UInt32, _ amount: Double) -> Color {
    let channel = { (hex: UInt32, shift: UInt32) in Double((hex >> shift) & 0xff) }
    let mixed = [16, 8, 0].map { shift in
      UInt32(
        (channel(from, UInt32(shift)) + (channel(to, UInt32(shift)) - channel(from, UInt32(shift))) * amount).rounded())
    }
    return RGBA(mixed[0] << 16 | mixed[1] << 8 | mixed[2]).color
  }
}

/// The moments the idle cat changes pose, for a `TimelineView`.
///
/// - Remark: See `PixelCatIdle.changes(after:seed:count:)`. The list never ends (a timeline whose
///   list ends stops); a paused cat gets one entry and stays.
nonisolated private struct PixelCatSchedule: TimelineSchedule {
  /// The cat's seed.
  let seed: UInt64
  /// Whether the cat does not move.
  let paused: Bool

  /// The moments, worked out a few at a time as SwiftUI reads them.
  ///
  /// - Remark: A sequence that never ends while the cat moves.
  struct Entries: Sequence, IteratorProtocol {
    /// The cat's seed.
    let seed: UInt64
    /// The next moment to give, if any.
    var upcoming: Double?
    /// Whether to stop after the first.
    let paused: Bool

    /// Gives the next moment.
    ///
    /// - Remark: See the type.
    /// - SideEffects: Advances the iterator.
    /// - Returns: The moment, or `nil` once a paused cat has its one.
    mutating func next() -> Date? {
      guard let moment = upcoming else { return nil }
      upcoming = paused ? nil : PixelCatIdle.changes(after: moment, seed: seed, count: 1).first
      return Date(timeIntervalSinceReferenceDate: moment)
    }
  }

  /// Lists the moments from a date on.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - startDate: Where to begin.
  ///   - mode: Normal or low frequency; the cat moves rarely either way.
  /// - Returns: The moments.
  func entries(from startDate: Date, mode: TimelineScheduleMode) -> Entries {
    Entries(seed: seed, upcoming: startDate.timeIntervalSinceReferenceDate, paused: paused)
  }
}
