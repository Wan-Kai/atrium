import SwiftUI

/// The frosted edge at the top or bottom of a scrolling page, where content passes under the bars.
///
/// - Remark: design-language "手机端 · 原则": content sliding under the top bar or the input blurs
///   but still shows the paper through, rather than vanishing under a solid fade: a thin material
///   that fades out away from the edge, with a 46% veil of the page colour. With Reduce Transparency
///   the veil is solid.
struct GlassEdge: View {
  /// Which edge it sits on.
  let edge: VerticalEdge
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Transparency is on.
  @Environment(\.atriumReduceTransparency) private var reduceTransparency

  /// The edge.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let toward: UnitPoint = edge == .top ? .top : .bottom
    let away: UnitPoint = edge == .top ? .bottom : .top
    let fade = LinearGradient(
      stops: [
        .init(color: .black, location: 0), .init(color: .black, location: 0.55), .init(color: .clear, location: 1),
      ],
      startPoint: toward, endPoint: away)
    ZStack {
      if !reduceTransparency {
        Rectangle().fill(.ultraThinMaterial)
      }
      palette.page.opacity(reduceTransparency ? 1 : 0.46)
    }
    .mask(fade)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}
