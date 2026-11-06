import SwiftUI

/// A turn's process: a header line, and the rail of its steps that folds away under it.
///
/// - Remark: design-language "手机端 · 对话" and "消息流 · 过程轨道". While the turn runs the header
///   is the blinking cat and a shimmering "进行中" with the time so far, and the rail is open. Once
///   done, the header is "› 用时 N" and the rail folds: its height closes over 0.4 s on the fold
///   curve, the rows fade out bottom up and rise 6pt (0.22 s smooth, each 14 ms after the one
///   below, at most 120 ms), the chevron turns with snappy, and 160 ms in the summary of what the
///   process did fades in from 4pt to the left. Opening plays it backwards: the summary fades out in
///   0.12 s, the rows fade in top down 40 ms in (0.26 s, 14 ms apart, at most 120 ms). Rows that
///   arrive while it is shown grow in (`RailRowView`). With Reduce Motion everything only fades.
///   When to fold (1 s after the turn ends, per design-language) is the screen's call: it owns the
///   clock; this view only animates `expanded`.
struct ProcessRailView: View {
  /// The rows.
  let rows: [RailRow]
  /// Whether the turn still runs.
  let running: Bool
  /// The time so far while it runs ("1:12"); after, how it ended and took ("用时 48 秒",
  /// "已停止，用时 1 分 40 秒").
  let duration: String
  /// What the process did, shown when folded.
  let summary: [String]
  /// Whether the rail is open.
  @Binding var expanded: Bool
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion
  /// The rail's measured height, for folding it.
  @State private var railHeight: CGFloat = 0
  /// The rows already there when the view appeared, which do not grow in.
  @State private var initialRows: Set<String>?

  /// The header and the rail.
  var body: some View {
    let palette = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 2) {
      header(palette)
      rail
        .frame(height: expanded ? railHeight : 0, alignment: .top)
        .clipped()
        .animation(reduceMotion ? nil : Motion.fold(reduceMotion: false).animation, value: expanded)
        .accessibilityHidden(!expanded)
      if !expanded {
        let steers = rows.filter { $0.node == .steer }
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(steers.enumerated()), id: \.element.id) { index, row in
            RailRowView(row: row, isFirst: index == 0, isLast: index == steers.count - 1)
          }
        }
        .transition(.opacity)
      }
    }
    .onAppear { initialRows = initialRows ?? Set(rows.map(\.id)) }
  }

  /// The rows, measured at their full height.
  private var rail: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
        RailRowView(
          row: row, isFirst: index == 0, isLast: index == rows.count - 1,
          entering: initialRows.map { !$0.contains(row.id) } ?? false
        )
        .modifier(FoldStagger(expanded: expanded, index: index, count: rows.count))
      }
    }
    .fixedSize(horizontal: false, vertical: true)
    .onGeometryChange(for: CGFloat.self) {
      $0.size.height
    } action: {
      railHeight = $0
    }
    .animation(reduceMotion ? nil : MotionToken.smooth.resolved(reduceMotion: false).animation, value: rows.map(\.id))
  }

  /// The header line.
  ///
  /// - Remark: See the type. Tapping it opens or closes the rail.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The header.
  private func header(_ palette: Palette) -> some View {
    let waiting = running && rows.contains { $0.node == .asking }
    return Button {
      expanded.toggle()
    } label: {
      HStack(spacing: 6) {
        if waiting {
          Image(systemName: "questionmark.circle")
            .font(.system(size: 17))
            .foregroundStyle(palette.attn)
            .frame(width: 18)
          Text("等你回答").fontWeight(.medium).foregroundStyle(palette.attn)
          Text("· " + duration).monospacedDigit().foregroundStyle(palette.secondary)
        } else if running {
          RunningCat()
          ShimmerText(text: "进行中", base: palette.secondary, light: palette.text, still: reduceMotion)
          Text("· " + duration).monospacedDigit().foregroundStyle(palette.secondary)
        } else {
          Image(systemName: "chevron.right")
            .font(.system(size: 11, weight: .semibold))
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .animation(reduceMotion ? nil : MotionToken.snappy.resolved(reduceMotion: false).animation, value: expanded)
          Text(duration)
          if !summary.isEmpty {
            Text("· " + summary.joined(separator: " · "))
              .lineLimit(1)
              .opacity(expanded ? 0 : 1)
              .offset(x: expanded && !reduceMotion ? -4 : 0)
              .animation(
                expanded
                  ? .easeOut(duration: 0.12)
                  : Motion.fold(reduceMotion: reduceMotion).animation.delay(reduceMotion ? 0 : 0.16),
                value: expanded)
          }
        }
        Spacer(minLength: 0)
      }
      .font(Typography.meta)
      .foregroundStyle(palette.secondary)
      .frame(minHeight: 30)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressStyle(scale: 0.985))
    .disabled(running)
    .accessibilityLabel(Text(waiting ? "等你回答 \(duration)" : running ? "进行中 \(duration)" : duration))
  }
}

/// Fades and lifts one row as the rail folds or opens, staggered by its place.
///
/// - Remark: See `ProcessRailView`.
private struct FoldStagger: ViewModifier {
  /// Whether the rail is open.
  let expanded: Bool
  /// The row's place from the top.
  let index: Int
  /// How many rows there are.
  let count: Int
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// Applies the fade, the lift and their delay.
  ///
  /// - Remark: Folding goes bottom up, opening top down.
  /// - SideEffects: none
  /// - Parameter content: The row.
  /// - Returns: The row, animated.
  func body(content: Content) -> some View {
    let motion = MotionToken.smooth.resolved(reduceMotion: reduceMotion)
    let animation: Animation =
      reduceMotion
      ? motion.animation
      : expanded
        ? .smooth(duration: 0.26).delay(0.04 + min(0.12, Double(index) * 0.014))
        : .smooth(duration: 0.22).delay(min(0.12, Double(count - 1 - index) * 0.014))
    content
      .opacity(expanded ? 1 : 0)
      .offset(y: expanded || !motion.allowsSpatialMotion ? 0 : -6)
      .animation(animation, value: expanded)
  }
}

/// Words with a band of light sweeping across them every 1.9 s, for "进行中".
///
/// - Remark: design-language "动效 · 扫光文字", as the desktop: the words in the quiet colour, a
///   band of the text colour a third as wide as the gradient (32%–68%, full between 47% and 53%)
///   moving across a 220% width. With Reduce Motion the words stand plain.
private struct ShimmerText: View {
  /// The words.
  let text: String
  /// Their quiet colour.
  let base: Color
  /// The colour of the band.
  let light: Color
  /// Whether to hold still.
  let still: Bool

  /// The shimmering words.
  var body: some View {
    Text(text)
      .foregroundStyle(base)
      .overlay {
        if !still {
          TimelineView(.animation(paused: still)) { context in
            let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.9) / 1.9
            Text(text).foregroundStyle(light).mask { band(phase) }
          }
        }
      }
  }

  /// The moving band, as a mask.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter phase: How far through the sweep, 0 to 1.
  /// - Returns: The mask.
  private func band(_ phase: Double) -> some View {
    GeometryReader { proxy in
      let width = proxy.size.width * 2.2
      LinearGradient(
        stops: [
          .init(color: .clear, location: 0.32), .init(color: .black, location: 0.47),
          .init(color: .black, location: 0.53), .init(color: .clear, location: 0.68),
        ],
        startPoint: .leading, endPoint: .trailing
      )
      .frame(width: width)
      .offset(x: (1 - phase * 2) * proxy.size.width - (width - proxy.size.width) / 2)
    }
  }
}
