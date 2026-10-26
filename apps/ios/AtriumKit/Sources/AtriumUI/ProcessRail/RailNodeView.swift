import SwiftUI

/// The mark on the rail for a row (design-language "过程轨道 · 节点"), centred where it is placed.
///
/// - Remark: Done is a 6pt `--node` dot; text said mid-turn a 7pt accent dot; folded read-only
///   calls a 14pt magnifier; going on an accent dot inside a 16pt open arc turning every 0.9 s; a
///   steer an 8pt hollow accent ring; a dead end a 10pt ×; a compaction two 13 × 1.5pt ticks across
///   the line; the agent's questions an orange dot, with a ring spreading from 0.6 to 1.4 times every
///   1.6 s while they wait. Each sits on a halo of the page colour that cuts the line around it.
///   With Reduce Motion the arc and the ring hold still. When a live step finishes, the arc closes
///   into the dot (snappy).
struct RailNodeView: View {
  /// The node.
  let node: RailRow.Node
  /// The colours.
  let palette: Palette
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The mark.
  var body: some View {
    ZStack {
      switch node {
      case .dot: dot(6, palette.node, halo: 4)
      case .said: dot(7, palette.tint, halo: 2)
      case .ask: dot(6, palette.attn, halo: 4)
      case .asking:
        dot(6, palette.attn, halo: 4)
        SpreadingRing(color: palette.attn, still: reduceMotion)
      case .live:
        dot(6, palette.tint, halo: 6)
        TurningArc(color: palette.tint, still: reduceMotion)
          .transition(reduceMotion ? .opacity : .scale(scale: 0.4).combined(with: .opacity))
      case .search:
        Image(systemName: "magnifyingglass")
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(palette.secondary)
          .frame(width: 14, height: 14)
          .background(palette.page, in: Circle().inset(by: -2))
      case .steer:
        Circle()
          .strokeBorder(palette.tint, lineWidth: 1.5)
          .frame(width: 8, height: 8)
          .background(palette.page, in: Circle().inset(by: -3))
      case .dead:
        Image(systemName: "xmark")
          .font(.system(size: 8, weight: .semibold))
          .foregroundStyle(palette.secondary)
          .frame(width: 10, height: 10)
          .background(palette.page, in: Circle().inset(by: -2))
      case .compaction:
        VStack(spacing: 3) {
          Capsule().frame(width: 13, height: 1.5)
          Capsule().frame(width: 13, height: 1.5)
        }
        .foregroundStyle(palette.secondary)
        .padding(.vertical, 2)
        .background(palette.page)
      }
    }
    .motion(.snappy, value: node)
    .accessibilityHidden(true)
  }

  /// A solid dot with a halo of the page colour.
  ///
  /// - Remark: The halo is what breaks the line around the node.
  /// - SideEffects: none
  /// - Parameters:
  ///   - size: The diameter.
  ///   - color: Its colour.
  ///   - halo: How far the page colour reaches beyond it.
  /// - Returns: The dot.
  private func dot(_ size: CGFloat, _ color: Color, halo: CGFloat) -> some View {
    Circle()
      .fill(color)
      .frame(width: size, height: size)
      .background(palette.page, in: Circle().inset(by: -halo))
  }
}

/// The open arc round a live step, turning once every 0.9 s.
///
/// - Remark: Timeline-derived rotation resumes when Reduce Motion changes without an appearance flag.
private struct TurningArc: View {
  /// Its colour.
  let color: Color
  /// Whether it holds still (Reduce Motion), at 30°.
  let still: Bool
  /// The arc.
  var body: some View {
    TimelineView(.animation(paused: still)) { context in
      let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9
      Circle()
        .trim(from: 0, to: 0.75)
        .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
        .frame(width: 14.5, height: 14.5)
        .rotationEffect(.degrees(still ? 30 : phase * 360))
    }
  }
}

/// The ring that spreads out of a question waiting for you.
///
/// - Remark: 0.6 to 1.4 times its size and fading, every 1.6 s; held at half opacity when still.
private struct SpreadingRing: View {
  /// Its colour.
  let color: Color
  /// Whether it holds still.
  let still: Bool
  /// The ring.
  var body: some View {
    TimelineView(.animation(paused: still)) { context in
      let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
      let eased = 1 - pow(1 - phase, 3)
      Circle()
        .stroke(color, lineWidth: 1.5)
        .frame(width: 10, height: 10)
        .scaleEffect(still ? 1 : 0.6 + eased * 0.8)
        .opacity(still ? 0.5 : 1 - eased)
    }
  }
}
