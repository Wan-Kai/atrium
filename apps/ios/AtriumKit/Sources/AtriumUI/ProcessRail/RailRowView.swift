import SwiftUI

/// One row of the process rail: its piece of the line, its node, and its words.
///
/// - Remark: design-language "消息流 · 过程轨道", in the phone's warm colours: a 30pt column for the
///   rail, the line at x = 10.5, the node centred on the first line of words (y = 15); a dead end and
///   a steer sit off the line at x = 19.5 while the main line runs on beside them. The line is drawn
///   per row and a halo in the page colour round each node cuts it, as the prototype does. A row
///   that is new grows in: the node pops from 0.3 with bouncy, the line above it grows down in
///   0.24 s, the words rise 6pt and fade in with smooth 60 ms later; with Reduce Motion they only
///   fade.
struct RailRowView: View {
  /// The row.
  let row: RailRow
  /// Whether it is the first row, so the line starts at its node.
  let isFirst: Bool
  /// Whether it is the last row, so the line stops at its node.
  let isLast: Bool
  /// Whether it just arrived and should grow in.
  let entering: Bool
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// Whether the entrance has played (or did not need to).
  @State private var shown: Bool
  /// Whether this row's full plain-text content is open.
  @State private var detailExpanded = false

  /// Makes the row.
  ///
  /// - Remark: A row that is not entering starts shown, so nothing plays.
  /// - SideEffects: none
  /// - Parameters:
  ///   - row: The row.
  ///   - isFirst: Whether it is the first.
  ///   - isLast: Whether it is the last.
  ///   - entering: Whether it just arrived.
  init(row: RailRow, isFirst: Bool, isLast: Bool, entering: Bool = false) {
    self.row = row
    self.isFirst = isFirst
    self.isLast = isLast
    self.entering = entering
    _shown = State(initialValue: !entering)
  }

  /// The row.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let motion = MotionToken.smooth.resolved(reduceMotion: reduceMotion)
    VStack(alignment: .leading, spacing: 6) {
      if let detail = row.detail, !detail.isEmpty {
        Button {
          detailExpanded.toggle()
        } label: {
          HStack(spacing: 4) {
            words(palette)
            Image(systemName: detailExpanded ? "chevron.down" : "chevron.right")
              .font(.system(size: 10))
              .foregroundStyle(palette.tertiary)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(detailExpanded ? "已展开" : "已收起")
        if detailExpanded {
          Text(verbatim: detail)
            .font(row.objectIsCode ? Typography.stepMono : Typography.step)
            .foregroundStyle(palette.text2)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(palette.code, in: RoundedRectangle(cornerRadius: 8))
        }
      } else {
        words(palette)
      }
      ForEach(Array(row.answers.enumerated()), id: \.offset) { _, answer in
        Text(verbatim: answer)
          .font(Typography.step)
          .foregroundStyle(palette.secondary)
          .textSelection(.enabled)
      }
    }
    .padding(.leading, 30)
    .padding(.vertical, 5)
    .frame(maxWidth: .infinity, minHeight: 30, alignment: .topLeading)
    .opacity(shown ? 1 : 0)
    .offset(y: shown || !motion.allowsSpatialMotion ? 0 : 6)
    .background(alignment: .topLeading) {
      GeometryReader { proxy in
        RailMarks(
          row: row, height: proxy.size.height, isFirst: isFirst, isLast: isLast, shown: shown, palette: palette)
      }
    }
    .onAppear {
      guard !shown else { return }
      withAnimation(motion.animation.delay(reduceMotion ? 0 : 0.06)) { shown = true }
    }
    .accessibilityElement(children: .contain)
  }

  /// The verb, the object and the end, on one line.
  ///
  /// - Remark: Verb `--text-2`, object `--l2` after a `--l3` "·", commands in 12pt mono, the end on
  ///   the right in 12pt; a dead end is all `--l2`, a steer's verb the accent, a question's verb
  ///   orange while it waits.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The words.
  private func words(_ palette: Palette) -> some View {
    let verbColor: Color =
      switch row.node {
      case .dead: palette.secondary
      case .steer: palette.tint
      case .asking: palette.attnText
      case .said: palette.text
      default: palette.text2
      }
    return HStack(alignment: .firstTextBaseline, spacing: 5) {
      Text(row.verb)
        .foregroundStyle(verbColor)
        .fontWeight(row.node == .asking || row.node == .said ? .medium : .regular)
        .lineLimit(1)
        .layoutPriority(1)
      if !row.object.isEmpty {
        Text("·").foregroundStyle(palette.tertiary)
        Text(row.object)
          .font(row.objectIsCode ? Typography.stepMono : Typography.step)
          .foregroundStyle(palette.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      Spacer(minLength: 8)
      if let end = row.end {
        endText(end, palette).font(.system(size: 12)).lineLimit(1).layoutPriority(1)
      }
    }
    .font(Typography.step)
    .frame(minHeight: 20)
  }

  /// The right-hand end, coloured by its tone.
  ///
  /// - Remark: Counts are "+N" green and "−M" red; a failure red; the rest quiet.
  /// - SideEffects: none
  /// - Parameters:
  ///   - end: The words.
  ///   - palette: The colours.
  /// - Returns: The text.
  private func endText(_ end: String, _ palette: Palette) -> Text {
    switch row.endTone {
    case .quiet: Text(end).foregroundStyle(palette.secondary)
    case .bad: Text(end).foregroundStyle(palette.danger)
    case .counts(let added, let removed):
      Text(
        "\(Text("+\(added)").foregroundStyle(palette.okText)) \(Text("−\(removed)").foregroundStyle(palette.danger))")
    }
  }
}

/// The line, the branch curves and the node of one rail row.
///
/// - Remark: See `RailRowView`. Coordinates are the desktop's, in points.
private struct RailMarks: View {
  /// The row.
  let row: RailRow
  /// The row's height.
  let height: CGFloat
  /// Whether it is the first row.
  let isFirst: Bool
  /// Whether it is the last row.
  let isLast: Bool
  /// Whether the entrance has played.
  let shown: Bool
  /// The colours.
  let palette: Palette
  /// Whether Reduce Motion is on.
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// The marks.
  var body: some View {
    let bouncy = MotionToken.bouncy.resolved(reduceMotion: reduceMotion)
    ZStack(alignment: .topLeading) {
      mainLine
      if row.node == .dead { deadEndCurve }
      if row.node == .steer { steerCurves }
      RailNodeView(node: row.node, palette: palette)
        .scaleEffect(shown || !bouncy.allowsScale ? 1 : 0.3)
        .opacity(shown ? 1 : 0)
        .animation(bouncy.animation, value: shown)
        .position(x: row.isBranch ? 19.5 : 10.5, y: 15)
    }
    .frame(width: 30, height: height, alignment: .topLeading)
  }

  /// The main line through the row.
  ///
  /// From its top (or its node, for the first) to its bottom (or its node, for the last); it grows
  /// down in 0.24 s when the row enters.
  private var mainLine: some View {
    let top: CGFloat = isFirst ? 15 : 0
    let bottom: CGFloat = isLast ? 15 : height
    return Rectangle()
      .fill(palette.rail)
      .frame(width: 1, height: max(0, bottom - top))
      .scaleEffect(x: 1, y: shown || reduceMotion ? 1 : 0, anchor: .top)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: shown)
      .offset(x: 10, y: top)
  }

  /// A dead end leaves the line with a dashed curve (2 on, 3 off) down to its ×.
  private var deadEndCurve: some View {
    Path { path in
      path.move(to: CGPoint(x: 10.5, y: 1))
      path.addCurve(to: CGPoint(x: 19.5, y: 10), control1: CGPoint(x: 10.5, y: 8), control2: CGPoint(x: 19.5, y: 6))
    }
    .stroke(palette.branch, style: StrokeStyle(lineWidth: 1, dash: [2, 3]))
  }

  /// A steer drops in from above, fading in, and curves back into the line below its ring.
  private var steerCurves: some View {
    ZStack(alignment: .topLeading) {
      Path { path in
        path.move(to: CGPoint(x: 19.5, y: -3))
        path.addLine(to: CGPoint(x: 19.5, y: 10))
      }
      .stroke(
        LinearGradient(
          colors: [palette.tint.opacity(0), palette.tint.opacity(0.7)], startPoint: .top, endPoint: .bottom),
        lineWidth: 1)
      Path { path in
        path.move(to: CGPoint(x: 19.5, y: 20))
        path.addCurve(to: CGPoint(x: 10.5, y: 33), control1: CGPoint(x: 19.5, y: 27), control2: CGPoint(x: 10.5, y: 25))
      }
      .stroke(palette.branch, lineWidth: 1)
    }
  }
}
