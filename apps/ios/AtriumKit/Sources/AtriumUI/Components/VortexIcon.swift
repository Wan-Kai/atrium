import SwiftUI

/// The running indicator: a dot vortex in the accent colour (design-language "会话状态").
///
/// - Remark: Drawn with `Canvas` from `VortexPattern`, on the time the system's timeline gives,
///   so every indicator on screen shares one clock and one phase. The levels jump at most a few
///   times per turn, so 30 frames a second is plenty. With Reduce Motion on the timeline pauses on
///   the still frame. Used in lists (home, workspace, children); the conversation's own title row
///   shows the blinking cat instead.
struct VortexIcon: View {
  /// The width and height, in points: 14 in lists, 12 in pills.
  var size: CGFloat = 14
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The vortex at the current moment.
  var body: some View {
    let tint = Palette(scheme: scheme).tint
    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
      let time = reduceMotion ? VortexPattern.stillTime : context.date.timeIntervalSinceReferenceDate
      let levels = VortexPattern.frame(at: time)
      Canvas { graphics, canvasSize in
        let cell = canvasSize.width / CGFloat(VortexPattern.size)
        let diameter = cell * VortexPattern.dotDiameter
        for (dot, level) in zip(VortexPattern.dots, levels) {
          let rect = CGRect(
            x: (CGFloat(dot.column) + 0.5) * cell - diameter / 2,
            y: (CGFloat(dot.row) + 0.5) * cell - diameter / 2,
            width: diameter,
            height: diameter
          )
          graphics.fill(Path(ellipseIn: rect), with: .color(tint.opacity(level)))
        }
      }
    }
    .frame(width: size, height: size)
    .accessibilityLabel(Text("运行中"))
  }
}
