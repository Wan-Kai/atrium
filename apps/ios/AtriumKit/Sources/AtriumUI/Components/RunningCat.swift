import SwiftUI

/// The small cat before "进行中" in a conversation's running title row, blinking every 2.6 s.
///
/// - Remark: design-language "标志": an 18pt rounded square with the brand cat's ears and eyes,
///   flat colours, the eyes squashing to 12% and back over the last 8% of each 2.6 s cycle (the
///   desktop's keyframes). It does not blink with Reduce Motion on. The colours are the brand's,
///   the same in light and dark.
struct RunningCat: View {
  /// The width and height, in points.
  var size: CGFloat = 18
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The cat.
  var body: some View {
    Canvas { graphics, canvasSize in
      let unit = canvasSize.width / 18
      graphics.scaleBy(x: unit, y: unit)
      let tile = Path(roundedRect: CGRect(x: 0, y: 0, width: 18, height: 18), cornerRadius: 5)
      graphics.fill(tile, with: .color(BrandColor.blue.color))
      graphics.clip(to: tile)
      graphics.fill(Self.head, with: .color(BrandColor.cream.color))
    }
    .overlay {
      eyes
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  /// The two eyes, blinking unless Reduce Motion is on.
  private var eyes: some View {
    let unit = size / 18
    let pair = HStack(spacing: unit * 1.8) {
      Ellipse().frame(width: unit * 2, height: unit * 3)
      Ellipse().frame(width: unit * 2, height: unit * 3)
    }
    .foregroundStyle(BrandColor.ink.color)
    .position(x: size / 2, y: unit * 10.6)
    return Group {
      if reduceMotion {
        pair
      } else {
        pair.keyframeAnimator(initialValue: 1.0, repeating: true) { view, scale in
          view.scaleEffect(x: 1, y: scale)
        } keyframes: { _ in
          LinearKeyframe(1.0, duration: 2.392)
          LinearKeyframe(0.12, duration: 0.078)
          LinearKeyframe(1.0, duration: 0.13)
        }
      }
    }
  }

  /// The head and ears, in the 18-unit square (the desktop's SVG path).
  private static let head: Path = {
    var path = Path()
    path.move(to: CGPoint(x: 3.5, y: 18))
    path.addLine(to: CGPoint(x: 3.5, y: 8.5))
    path.addLine(to: CGPoint(x: 5, y: 3.6))
    path.addLine(to: CGPoint(x: 8, y: 6.2))
    path.addLine(to: CGPoint(x: 10, y: 6.2))
    path.addLine(to: CGPoint(x: 13, y: 3.6))
    path.addLine(to: CGPoint(x: 14.5, y: 8.5))
    path.addLine(to: CGPoint(x: 14.5, y: 18))
    path.closeSubpath()
    return path
  }()
}

/// The brand cat's three colours (design-language "标志").
///
/// - Remark: The same in light and dark, as the brand is; the pixel cat has its own palette.
enum BrandColor {
  /// The grey-blue background, `#6c86cc`.
  static let blue = RGBA(0x6c86cc)
  /// The cream body, `#fbf5ec`.
  static let cream = RGBA(0xfbf5ec)
  /// The ink of the features, `#1f2537`.
  static let ink = RGBA(0x1f2537)
}
