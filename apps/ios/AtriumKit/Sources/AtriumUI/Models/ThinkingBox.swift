import AtriumProtocol
import SwiftUI

/// The thinking level box: the desktop's `EffortBox` in the phone's colours (design-language "手机端 ·
/// 模型 sheet").
///
/// - Remark: Copied from `packages/ui/src/chat/effort-box.tsx`: 56pt a level (narrower when the
///   sheet is), 38pt high, corner 12, `--surface` under the dots, a faint line between levels, the
///   level's name at the left (sliding up or down as it changes) and "2 / 4" at the right, the hint
///   centred below. A drag moves the edge with the finger and rubber-bands past the ends; letting go
///   springs it to the nearest level (response 0.38 s, damping 0.72) and picks it; a tap (moving
///   3pt at most) jumps to the level under it. The top level lights the dots, twinkling with a sweep
///   every 3.6 s, and rings the box: the desktop's blue-to-peach is the deep beige here, the only
///   difference. With one level there is no box, only its hint, as on the desktop.
struct ThinkingBox: View {
  /// The model's levels, lowest first.
  let levels: [ThinkingLevel]
  /// The session's level.
  let level: ThinkingLevel?
  /// Picks a level.
  let pick: (ThinkingLevel) -> Void
  /// Where the edge is, 0 to 1 (slightly past either end while dragged).
  @State private var edge: Double?
  /// The level shown, which follows a drag before it is picked.
  @State private var shown: Int?
  /// Whether the name last moved up a level.
  @State private var rising = true
  /// The drag under way: where the edge started and whether it has moved past a tap.
  @State private var drag: (start: Double, moved: Bool)?
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The width of one level, in points.
  static let cell: CGFloat = 56
  /// How far a press may move before it is a drag, in points.
  static let tapSlop: CGFloat = 3

  /// The box, its heading and its hint.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let count = levels.count
    let committed = committedIndex
    let index = min(max(0, shown ?? committed), max(0, count - 1))
    let full = count > 1 && index == count - 1
    VStack(spacing: 0) {
      HStack {
        Text(count > 1 ? "推理强度 · 按住左右拖动" : "推理强度")
        Spacer()
      }
      .font(.system(size: 11))
      .foregroundStyle(palette.secondary)
      .padding(.horizontal, 10)
      .padding(.bottom, 6)
      if count > 1 {
        box(palette: palette, index: index, full: full)
        Text(ModelChoice.levelHint(levels[index], levels: levels))
          .font(.system(size: 11))
          .foregroundStyle(palette.secondary)
          .frame(minHeight: 16)
          .padding(.horizontal, 10)
          .padding(.top, 8)
          .padding(.bottom, 4)
      } else {
        Text(ModelChoice.levelHint(.off, levels: levels))
          .font(.system(size: 11))
          .foregroundStyle(palette.secondary)
          .padding(.horizontal, 10)
          .padding(.top, 4)
          .padding(.bottom, 8)
      }
    }
    .onChange(of: committed) { _, next in
      guard drag == nil else { return }
      shown = next
      settle(at: next)
    }
  }

  /// The level the session has, as a place in `levels`; the default when it has none.
  private var committedIndex: Int {
    let current = level ?? ModelChoice.level(after: nil, levels: levels)
    return current.flatMap { levels.firstIndex(of: $0) } ?? 0
  }

  /// The dotted box with its dividers, name and count.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - palette: The colours.
  ///   - index: The level shown.
  ///   - full: Whether the top level shows.
  /// - Returns: The box.
  private func box(palette: Palette, index: Int, full: Bool) -> some View {
    let count = levels.count
    let rest = Double(committedIndex + 1) / Double(count)
    return GeometryReader { proxy in
      let width = proxy.size.width
      ZStack(alignment: .leading) {
        EffortDots(coverage: edge ?? rest, full: full, still: reduceMotion)
        ForEach(1..<count, id: \.self) { divider in
          Rectangle().fill(palette.tertiary).opacity(0.7)
            .frame(width: 1)
            .padding(.vertical, 10)
            .position(x: width * CGFloat(divider) / CGFloat(count), y: proxy.size.height / 2)
        }
        Text(ModelChoice.levelName(levels[index]))
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(full ? palette.tint : palette.text)
          .shadow(color: palette.surface, radius: 4)
          .id(index)
          .transition(
            reduceMotion
              ? .opacity
              : .asymmetric(
                insertion: .move(edge: rising ? .bottom : .top).combined(with: .opacity), removal: .opacity)
          )
          .padding(.leading, 12)
        Text("\(index + 1) / \(count)")
          .font(.system(size: 11)).monospacedDigit()
          .foregroundStyle(full ? palette.tint : palette.secondary)
          .frame(maxWidth: .infinity, alignment: .trailing)
          .padding(.trailing, 12)
      }
      .clipShape(RoundedRectangle(cornerRadius: 12))
      .contentShape(RoundedRectangle(cornerRadius: 12))
      .gesture(dragGesture(width: width, count: count))
    }
    .frame(width: Self.cell * CGFloat(count), height: 38)
    .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(full ? palette.tint.opacity(0.5) : .clear, lineWidth: 1))
    .shadow(color: full ? palette.tint.opacity(0.45) : .clear, radius: 9)
    .frame(maxWidth: .infinity)
    .accessibilityElement()
    .accessibilityLabel("推理强度")
    .accessibilityValue(ModelChoice.levelName(levels[index]))
    .accessibilityAdjustableAction { direction in
      let next = index + (direction == .increment ? 1 : -1)
      guard levels.indices.contains(next) else { return }
      show(next, commit: true)
      settle(at: next)
    }
  }

  /// The drag and tap on the box.
  ///
  /// - Remark: The desktop's pointer handling: the edge follows the finger, the name follows the
  ///   nearest level, and letting go picks it; a press that barely moved picks the level under it.
  /// - SideEffects: none
  /// - Parameters:
  ///   - width: The box's width.
  ///   - count: How many levels.
  /// - Returns: The gesture.
  private func dragGesture(width: CGFloat, count: Int) -> some Gesture {
    DragGesture(minimumDistance: 0)
      .onChanged { value in
        let start = drag?.start ?? edge ?? Double(committedIndex + 1) / Double(count)
        let moved = (drag?.moved ?? false) || abs(value.translation.width) > Self.tapSlop
        drag = (start, moved)
        guard moved, width > 0 else { return }
        let position = Self.rubber(start + Double(value.translation.width / width))
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) { edge = position }
        show(Self.nearestLevel(position, count: count), commit: false)
      }
      .onEnded { value in
        let moved = drag?.moved ?? false
        drag = nil
        let index =
          moved
          ? Self.nearestLevel(edge ?? 0, count: count)
          : Self.tappedLevel(Double(value.location.x / max(1, width)), count: count)
        show(index, commit: true)
        settle(at: index)
      }
  }

  /// Shows a level, and picks it when asked.
  ///
  /// - Remark: The name slides the way the level moved, as the desktop's.
  /// - SideEffects: Changes the level shown; may pick a level.
  /// - Parameters:
  ///   - index: The level's place.
  ///   - commit: Whether to pick it.
  private func show(_ index: Int, commit: Bool) {
    let clamped = min(max(0, index), levels.count - 1)
    let before = shown ?? committedIndex
    if clamped != before {
      rising = clamped > before
      withAnimation(reduceMotion ? nil : .timingCurve(0.2, 0.9, 0.25, 1.15, duration: 0.42)) { shown = clamped }
    }
    if commit, levels[clamped] != level { pick(levels[clamped]) }
  }

  /// Springs the edge to rest at a level.
  ///
  /// - Remark: Response 0.38 s, damping 0.72; at once under Reduce Motion.
  /// - SideEffects: Changes the edge.
  /// - Parameter index: The level's place.
  private func settle(at index: Int) {
    let rest = Double(index + 1) / Double(levels.count)
    withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.72)) { edge = rest }
  }

  /// Pulls a coverage past either end back, harder the further it goes (the desktop's `rubber`).
  ///
  /// - Remark: The rubber band at the ends of a drag.
  /// - SideEffects: none
  /// - Parameter value: The raw coverage.
  /// - Returns: The damped coverage.
  static func rubber(_ value: Double) -> Double {
    if value < 0 { return -(1 - 1 / (-value * 3 + 1)) / 3 }
    if value > 1 { return 1 + (1 - 1 / ((value - 1) * 3 + 1)) / 3 }
    return value
  }

  /// The level nearest a coverage (the desktop's `nearestLevel`).
  ///
  /// - Remark: Level `i` covers `(i + 1) / count` of the box.
  /// - SideEffects: none
  /// - Parameters:
  ///   - coverage: The coverage, possibly past either end.
  ///   - count: How many levels.
  /// - Returns: The level's place.
  static func nearestLevel(_ coverage: Double, count: Int) -> Int {
    max(0, Int((min(1, max(0, coverage)) * Double(count)).rounded()) - 1)
  }

  /// The level under a tap (the desktop's click).
  ///
  /// - Remark: The box is split evenly by the levels.
  /// - SideEffects: none
  /// - Parameters:
  ///   - fraction: Where along the box, 0 to 1.
  ///   - count: How many levels.
  /// - Returns: The level's place.
  static func tappedLevel(_ fraction: Double, count: Int) -> Int {
    min(count - 1, max(0, Int((fraction * Double(count)).rounded(.up)) - 1))
  }
}

/// The thinking box's dots: the desktop's `paintDots` for the box (`packages/ui/src/design/dots.ts`).
///
/// - Remark: 3.6pt dots 6pt apart, centred; they reach from the left to the coverage with a soft
///   edge, shaded by value noise of seed 1. Below the top they are ink; at the top they take the deep
///   beige (the desktop's brand gradient), twinkle, and a sweep crosses them every 3.6 s. Animatable,
///   so the edge springs; frames run only while the top level shows and motion is allowed. Time is
///   the timeline's own date, so the sweeps keep a steady 3.6 s beat rather than starting 250 ms
///   after the top level shows as the desktop's do.
struct EffortDots: View, Animatable {
  /// How far the dots reach, 0 to 1.
  var coverage: Double
  /// Whether the top level shows.
  let full: Bool
  /// Whether to keep still (Reduce Motion).
  let still: Bool
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The coverage, for animation.
  var animatableData: Double {
    get { coverage }
    set { coverage = newValue }
  }

  /// One dot.
  ///
  /// - Remark: In the box's points.
  struct Dot: Equatable {
    /// Its top left corner.
    let origin: CGPoint
    /// Its opacity.
    let alpha: Double
  }

  /// The dots, painted.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let dark = scheme == .dark
    TimelineView(.animation(paused: !full || still)) { timeline in
      Canvas { graphics, size in
        let elapsed = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 36_000) * 1000
        let now = still ? 0 : elapsed
        let sweep = full && !still ? Self.sweep(elapsed) : nil
        let ink: Color = dark ? .white : .black
        for dot in Self.dots(
          width: size.width, height: size.height, coverage: coverage, full: full, dark: dark, now: now, sweep: sweep)
        {
          let rect = CGRect(origin: dot.origin, size: CGSize(width: Self.size, height: Self.size))
          graphics.fill(
            Path(roundedRect: rect, cornerRadius: Self.radius),
            with: .color((full ? palette.tint : ink).opacity(dot.alpha))
          )
        }
      }
    }
    .accessibilityHidden(true)
  }

  /// The distance between dots.
  static let pitch: Double = 6
  /// A dot's width and height.
  static let size: Double = 3.6
  /// A dot's corner.
  static let radius: Double = 1

  /// Where the dots are and how strong, as the desktop's `paintDots` with the box variant.
  ///
  /// - Remark: Same order (row by row), same skipping of dots fainter than 0.015, so the tests can
  ///   compare with the desktop's output.
  /// - SideEffects: none
  /// - Parameters:
  ///   - width: The box's width.
  ///   - height: Its height.
  ///   - coverage: How far the dots reach.
  ///   - full: Whether the top level shows.
  ///   - dark: Whether the appearance is dark.
  ///   - now: Milliseconds, for the twinkle.
  ///   - sweep: Where a sweep is, 0 to 1, or `nil`.
  /// - Returns: The dots.
  static func dots(
    width: Double, height: Double, coverage: Double, full: Bool, dark: Bool, now: Double, sweep: Double?
  ) -> [Dot] {
    let columns = Int((width / pitch).rounded(.up))
    let rows = Int((height / pitch).rounded(.up))
    guard columns > 0, rows > 0 else { return [] }
    let left = (width - Double(columns - 1) * pitch - size) / 2
    let top = (height - Double(rows - 1) * pitch - size) / 2
    let feather = 0.09
    var result: [Dot] = []
    for row in 0..<rows {
      for column in 0..<columns {
        let x = (Double(column) + 0.5) / Double(columns)
        let reach = max(0, min(1, (coverage - x) / feather + 0.5))
        if reach <= 0 { continue }
        let tone =
          0.5 + 0.5
          * (0.6 * noise(Double(column) / 3, Double(row) / 3) + 0.4
            * noise(Double(column) / 1.3 + 9, Double(row) / 1.3 + 4))
        let alpha: Double
        if full {
          let twinkle = 0.8 + 0.2 * sin(now / 280 + hash(column, row) * 6.28)
          var boost = 0.0
          if let sweep {
            let centre = -0.4 + sweep * 1.8
            let off = x - centre - (Double(row) / Double(rows) - 0.5) * 0.35
            boost = max(0, 1 - abs(off) / 0.16)
          }
          alpha = min(0.95, (dark ? 0.4 : 0.32) * tone * twinkle * reach + boost * 0.6 * tone)
        } else {
          alpha = (dark ? 0.32 : 0.24) * tone * reach * (0.7 + 0.3 * coverage)
        }
        if alpha < 0.015 { continue }
        result.append(
          Dot(origin: CGPoint(x: left + Double(column) * pitch, y: top + Double(row) * pitch), alpha: alpha))
      }
    }
    return result
  }

  /// Where a sweep is at a time after the top level began showing (the desktop's `sweepProgress`).
  ///
  /// - Remark: One every 3.6 s, taking 0.9 s, eased in and out.
  /// - SideEffects: none
  /// - Parameter elapsed: Milliseconds since the first sweep may start.
  /// - Returns: How far it has gone, 0 to 1, or `nil` between sweeps.
  static func sweep(_ elapsed: Double) -> Double? {
    guard elapsed >= 0 else { return nil }
    let into = elapsed.truncatingRemainder(dividingBy: 3600)
    guard into < 900 else { return nil }
    let x = into / 900
    return x < 0.5 ? 2 * x * x : 1 - pow(-2 * x + 2, 2) / 2
  }

  /// A dot's random value from its place, seed 1 (the desktop's `hasher`).
  ///
  /// - Remark: The same 32-bit integer steps as the JavaScript, so the dots fall the same.
  /// - SideEffects: none
  /// - Parameters:
  ///   - x: The column.
  ///   - y: The row.
  /// - Returns: 0 to 1.
  static func hash(_ x: Int, _ y: Int) -> Double {
    let sum = Int64(x) * 374_761_393 + Int64(y) * 668_265_263 + 2_147_483_647
    var value = UInt32(truncatingIfNeeded: sum)
    value = (value ^ (value >> 13)) &* 1_274_126_177
    return Double(value ^ (value >> 16)) / 4_294_967_295
  }

  /// Smooth value noise over the hash (the desktop's `valueNoise`).
  ///
  /// - Remark: Bilinear between the four corners' hashes, eased with smoothstep.
  /// - SideEffects: none
  /// - Parameters:
  ///   - x: Where across.
  ///   - y: Where down.
  /// - Returns: 0 to 1.
  static func noise(_ x: Double, _ y: Double) -> Double {
    let xi = Int(x.rounded(.down))
    let yi = Int(y.rounded(.down))
    let smooth = { (t: Double) in t * t * (3 - 2 * t) }
    let xf = smooth(x - Double(xi))
    let yf = smooth(y - Double(yi))
    let a = hash(xi, yi)
    let b = hash(xi + 1, yi)
    let c = hash(xi, yi + 1)
    let d = hash(xi + 1, yi + 1)
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf
  }
}
