import SwiftUI

/// The Fast bolt: the desktop's `Lightning`, Hugeicons' Flash (design-language "手机端 · 模型 sheet").
///
/// - Remark: Drawn from Hugeicons' path on its 24-unit grid with the desktop's line width (1.75
///   units), so it scales with `size` and takes the foreground colour. Filled, as the desktop draws
///   the bolt that is on and the one after a model's name; outlined, as its Fast key while off.
struct FastBolt: View {
  /// The width and height, in points.
  var size: CGFloat = 15
  /// Whether it is filled.
  var filled = true

  /// Hugeicons' `FlashIcon` (`@hugeicons/core-free-icons`), on the 24-unit grid.
  static let path: CGPath? = SVGPath.cgPath(
    "M5.22576 11.3294L12.224 2.34651C12.7713 1.64397 13.7972 2.08124 13.7972 3.01707V9.96994C13.7972 10.5305 14.1995 10.985 14.6958 10.985H18.0996C18.8729 10.985 19.2851 12.0149 18.7742 12.6706L11.776 21.6535C11.2287 22.356 10.2028 21.9188 10.2028 20.9829V14.0301C10.2028 13.4695 9.80048 13.015 9.3042 13.015H5.90035C5.12711 13.015 4.71494 11.9851 5.22576 11.3294Z"
  )

  /// The bolt.
  var body: some View {
    Canvas { context, canvas in
      guard let path = Self.path else { return }
      let scale = canvas.width / 24
      context.scaleBy(x: scale, y: scale)
      if filled { context.fill(Path(path), with: .foreground) }
      context.stroke(
        Path(path), with: .foreground, style: StrokeStyle(lineWidth: 1.75, lineCap: .round, lineJoin: .round))
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
