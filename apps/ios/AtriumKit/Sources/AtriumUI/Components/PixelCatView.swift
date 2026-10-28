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
  /// Dots, or characters after ascii-sharks.
  var style: Style = .dots
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The cat, in its current pose.
  var body: some View {
    let still = reduceMotion || scene == .asleep
    switch style {
    case .dots: dots(still: still)
    case .glyphs(let shimmer): glyphs(still: still, shimmer: shimmer)
    }
  }

  /// How the cells are drawn.
  ///
  /// - Remark: The glyphs are the prototype under trial (2026-10-28); the dots are the shipped cat.
  enum Style: Equatable {
    /// Rounded-square dots.
    case dots
    /// Characters shaded by density, flickering a few cells eight times a second when `shimmer`.
    case glyphs(shimmer: Bool)
  }

  /// The ticks a second of the glyph shimmer.
  static let shimmerRate = 8.0

  /// The cat in characters.
  ///
  /// - Remark: One timeline for both the moves and the shimmer: with the shimmer it fires
  ///   `shimmerRate` times a second and reads the pose from the clock; without it, only when the
  ///   pose changes, as the dots. Paused under Reduce Motion and asleep.
  /// - SideEffects: none
  /// - Parameters:
  ///   - still: Whether the cat does not move.
  ///   - shimmer: Whether the glyphs flicker.
  /// - Returns: The view.
  @ViewBuilder
  private func glyphs(still: Bool, shimmer: Bool) -> some View {
    let colors = PixelCatColors(scheme: scheme, asleep: scene == .asleep)
    Group {
      if shimmer && !still {
        TimelineView(.animation(minimumInterval: 1 / Self.shimmerRate)) { context in
          let time = context.date.timeIntervalSinceReferenceDate
          let grid = PixelCat.grid(scene, pose: PixelCatIdle.pose(at: time, seed: seed))
          // The still cat repaints only when the pose changes; each tick redraws only the cells it flips.
          ZStack {
            PixelCatGlyphCanvas(grid: grid, colors: colors, sitting: scene == .sit, tick: nil).equatable()
            PixelCatGlyphCanvas(
              grid: grid, colors: colors, sitting: scene == .sit, tick: Int(time * Self.shimmerRate), onlyFlipped: true)
          }
        }
      } else {
        TimelineView(PixelCatSchedule(seed: seed, paused: still)) { context in
          let pose =
            still ? .rest : PixelCatIdle.pose(at: context.date.timeIntervalSinceReferenceDate, seed: seed)
          PixelCatGlyphCanvas(
            grid: PixelCat.grid(scene, pose: pose), colors: colors, sitting: scene == .sit, tick: nil)
        }
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  /// The cat in dots.
  ///
  /// - Remark: Repaints only when the pose changes.
  /// - SideEffects: none
  /// - Parameter still: Whether the cat does not move.
  /// - Returns: The view.
  private func dots(still: Bool) -> some View {
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

/// Draws one grid of the pixel cat in characters.
///
/// - Remark: Each cell is a solid block in its colour with `PixelCatGlyphs`' character on top in a
///   low-contrast ink (see `PixelCatColors.glyphBlock` and `glyphInk`); one monospaced semibold
///   face a little taller than a cell. Each distinct character and colour is laid out once per draw
///   and reused for every cell that shares it; the ink steps every four rows for that. Equatable,
///   so an unchanged tick does not repaint.
private struct PixelCatGlyphCanvas: View, Equatable {
  /// The cells.
  let grid: [[PixelCat.Cell]]
  /// The colours.
  let colors: PixelCatColors
  /// Whether the cat sits on nothing, so the background is not drawn.
  let sitting: Bool
  /// The shimmer's tick, or `nil`.
  let tick: Int?
  /// Whether to draw only the cells the tick flips, over a still cat drawn underneath.
  var onlyFlipped = false

  /// A character in a colour, laid out once a draw.
  ///
  /// - Remark: Laying out text is the costly part of a draw; the cat uses a few dozen of these.
  private struct Key: Hashable {
    /// The character.
    let glyph: Character
    /// Its colour.
    let color: Color
  }

  /// The characters.
  var body: some View {
    Canvas { graphics, canvasSize in
      let pitch = canvasSize.width / CGFloat(PixelCat.size)
      let font = Font.system(size: pitch * 1.18, weight: .semibold, design: .monospaced)
      var laidOut: [Key: GraphicsContext.ResolvedText] = [:]
      for (row, cells) in grid.enumerated() {
        for (column, cell) in cells.enumerated() {
          if onlyFlipped, let tick, !PixelCatGlyphs.mayFlip(row: row, column: column, tick: tick) { continue }
          let band = row / 4 * 4
          // The background only inside the circle, and not at all when sitting, as the dots.
          if cell == .empty && (sitting || hypot(Double(column) - 15.5, Double(row) - 15.5) > 15.6) { continue }
          if !onlyFlipped, let block = colors.glyphBlock(of: cell, row: row) {
            graphics.fill(
              Path(CGRect(x: CGFloat(column) * pitch, y: CGFloat(row) * pitch, width: pitch, height: pitch)),
              with: .color(block))
          }
          guard let glyph = PixelCatGlyphs.glyph(in: grid, row: row, column: column, tick: tick),
            let color = colors.glyphInk(of: cell, row: band)
          else { continue }
          if onlyFlipped {
            guard glyph != PixelCatGlyphs.glyph(in: grid, row: row, column: column, tick: nil) else { continue }
            if let block = colors.glyphBlock(of: cell, row: row) {
              graphics.fill(
                Path(CGRect(x: CGFloat(column) * pitch, y: CGFloat(row) * pitch, width: pitch, height: pitch)),
                with: .color(block))
            }
          }
          let key = Key(glyph: glyph, color: color)
          let text = laidOut[key] ?? graphics.resolve(Text(String(glyph)).font(font).foregroundColor(color))
          laidOut[key] = text
          graphics.draw(
            text, at: CGPoint(x: (CGFloat(column) + 0.5) * pitch, y: (CGFloat(row) + 0.5) * pitch), anchor: .center)
        }
      }
    }
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

  /// The block under a cell drawn as a character, or `nil` for a cell with none.
  ///
  /// - Remark: As ascii-sharks draws its sharks: a solid block in the cell's colour, so the cat
  ///   keeps a clear shape on the paper, with the character on top as texture. The background and
  ///   the light-mode ring have no block, only a faint character.
  /// - SideEffects: none
  /// - Parameters:
  ///   - cell: The cell.
  ///   - row: Its row, for the shading.
  /// - Returns: The colour.
  func glyphBlock(of cell: PixelCat.Cell, row: Int) -> Color? {
    switch cell {
    case .empty, .outline, .outside: nil
    default: color(of: cell, row: row)
    }
  }

  /// The character's colour on a cell, or `nil` for a cell whose character is not drawn.
  ///
  /// - Remark: Low-contrast ink, so the characters read as fur and weave, not as text: warm brown
  ///   on the cream body, darkening downwards with the shading; cream on the deep beige tile; the
  ///   background and ring as faint as the dots'. Features (eyes, nose, blush, ears, badge) stay
  ///   solid blocks. Asleep, everything is fainter.
  /// - SideEffects: none
  /// - Parameters:
  ///   - cell: The cell.
  ///   - row: Its row, for the shading.
  /// - Returns: The colour.
  func glyphInk(of cell: PixelCat.Cell, row: Int) -> Color? {
    let fade = asleep ? 0.5 : 1
    let dark = scheme == .dark
    switch cell {
    case .body: return RGBA(0x5c4630, (0.22 + 0.3 * Double(row) / Double(PixelCat.size)) * fade).color
    case .tile, .tab: return RGBA(0xfbf3e6, (dark ? 0.22 : 0.3) * fade).color
    case .empty: return dark ? RGBA(0xfff0dc, 0.1).color : RGBA(0x3c321e, 0.12).color
    case .outline: return dark ? nil : RGBA(0x46371e, 0.35).color
    default: return nil
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
