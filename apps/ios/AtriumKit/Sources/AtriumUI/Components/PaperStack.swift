import SwiftUI

/// Draws the home empty state's stack of blank sheets (design-language "首页空状态插图").
///
/// - Remark: Drawn from option D of the paper prototype on its 132×108 grid, so it scales with
///   `width`: two `--surface` sheets turned -6° and 4°, the `--note` sheet on top with its bottom
///   right corner turned down, a faint shadow under them. It settles in when it appears, as a sheet
///   laid down, unless Reduce Motion is on.
struct PaperStack: View {
  /// The width, in points; the height follows at 108/132.
  var width: CGFloat = 132
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion
  /// Whether the sheets have settled.
  @State private var settled = false

  /// The sheets.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let edge = PaperStack.edge(in: scheme).color
    let shown = settled || reduceMotion
    Canvas { graphics, canvas in
      var context = graphics
      context.scaleBy(x: canvas.width / 132, y: canvas.width / 132)
      let stroke = StrokeStyle(lineWidth: 1, lineJoin: .round)
      context.fill(
        Path(ellipseIn: CGRect(x: 20, y: 97, width: 92, height: 8)), with: .color(PaperStack.shadow(in: scheme).color))
      for degrees in [-6.0, 4.0] {
        let sheet = Path(roundedRect: CGRect(x: 30, y: 14, width: 72, height: 84), cornerRadius: 2)
          .applying(
            CGAffineTransform(translationX: 66, y: 56).rotated(by: degrees * .pi / 180).translatedBy(x: -66, y: -56))
        context.fill(sheet, with: .color(palette.surface))
        context.stroke(sheet, with: .color(edge), style: stroke)
      }
      var top = Path()
      top.addLines([
        CGPoint(x: 30, y: 12), CGPoint(x: 102, y: 12), CGPoint(x: 102, y: 78), CGPoint(x: 84, y: 96),
        CGPoint(x: 30, y: 96),
      ])
      top.closeSubpath()
      context.fill(top, with: .color(palette.note))
      context.stroke(top, with: .color(edge), style: stroke)
      var corner = Path()
      corner.move(to: CGPoint(x: 102, y: 78))
      corner.addLine(to: CGPoint(x: 86, y: 80))
      corner.addQuadCurve(to: CGPoint(x: 84, y: 82), control: CGPoint(x: 84, y: 80))
      corner.addLine(to: CGPoint(x: 84, y: 96))
      corner.closeSubpath()
      context.fill(corner, with: .color(palette.surface))
      context.stroke(corner, with: .color(edge), style: stroke)
    }
    .frame(width: width, height: width * 108 / 132)
    .opacity(shown ? 1 : 0)
    .rotationEffect(.degrees(shown ? 0 : -2), anchor: UnitPoint(x: 0.5, y: 0.9))
    .offset(y: shown ? 0 : -8)
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.7)) { settled = true }
    }
    .accessibilityHidden(true)
  }

  /// The sheets' edge colour in an appearance.
  ///
  /// - Remark: Light uses `--text-tertiary`; in dark that is too close to the paper for the edges to
  ///   show, so dark uses `--text-secondary` at 55% (design-language "首页空状态插图").
  /// - SideEffects: none
  /// - Parameter scheme: Light or dark.
  /// - Returns: The colour.
  static func edge(in scheme: ColorScheme) -> RGBA {
    scheme == .dark ? RGBA(ColorToken.secondary.value(in: .dark).hex, 0.55) : ColorToken.tertiary.value(in: .light)
  }

  /// The shadow under the stack in an appearance.
  ///
  /// - Remark: The prototype's `--shadow`: a warm brown in light, black in dark.
  /// - SideEffects: none
  /// - Parameter scheme: Light or dark.
  /// - Returns: The colour.
  static func shadow(in scheme: ColorScheme) -> RGBA {
    scheme == .dark ? RGBA(0x000000, 0.45) : RGBA(0x3c2d14, 0.12)
  }
}
