import SwiftUI

/// The new chat icon: a speech bubble with a plus in it (I1, design-language "手机端 · 首页").
///
/// - Remark: Drawn from the prototype's path on a 22-unit grid, stroked at 1.6 units, so it scales
///   with `size` and takes the foreground colour.
struct NewChatIcon: View {
  /// The width and height, in points.
  var size: CGFloat = 22

  /// The bubble's outline and the plus, on the 22-unit grid.
  private static let path: CGPath? = SVGPath.cgPath(
    "M4 6.2A2.7 2.7 0 0 1 6.7 3.5h8.6A2.7 2.7 0 0 1 18 6.2v6.1a2.7 2.7 0 0 1-2.7 2.7H10l-3.6 3c-.4.3-.9 0-.9-.4V15h0A2.7 2.7 0 0 1 4 12.3zM11 6.6v5.3M8.35 9.25h5.3"
  )

  /// The icon.
  var body: some View {
    Canvas { context, canvas in
      guard let path = Self.path else { return }
      let scale = canvas.width / 22
      context.scaleBy(x: scale, y: scale)
      context.stroke(
        Path(path), with: .foreground, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
