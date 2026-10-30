import SwiftUI

/// The fog under the conversation page's title: blur that grows toward the top, under a paper veil.
///
/// - Remark: design-language "对话页 · 标题下的雾" (prototype C, 2026-10-30). The thin frosted edge
///   it replaces blurred too late, so words sliding behind the title made it hard to read. Three
///   materials stacked, each masked shorter: every one blurs what the ones below already blurred,
///   so the blur thickens toward the top. With Reduce Transparency only the paper is drawn, solid
///   until it fades. The page shows it once it has scrolled ``from``.
struct TitleFog: View {
  /// One blur layer: solid from the top of the screen to `solid`, gone at `clear`, in points.
  ///
  /// - Remark: design-language "对话页 · 标题下的雾" lists the three.
  struct Layer: Equatable {
    /// Where it starts to fade.
    let solid: CGFloat
    /// Where it is gone.
    let clear: CGFloat
  }

  /// How far down the fog reaches from the top of the screen.
  static let height: CGFloat = 160
  /// The blur layers, thinnest and longest first.
  static let layers = [Layer(solid: 104, clear: 160), Layer(solid: 96, clear: 136), Layer(solid: 88, clear: 112)]
  /// The paper veil's opacity at the top, and at ``paperFrom``, after which it fades to nothing.
  static let paper: (top: Double, held: Double) = (0.62, 0.52)
  /// Where the paper veil starts to fade.
  static let paperFrom: CGFloat = 100
  /// How far the page scrolls before the fog shows: at the top nothing is under the title yet, and
  /// the fog would only veil the first lines and the "older turns" row.
  static let from: CGFloat = 16

  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Transparency is on.
  @Environment(\.atriumReduceTransparency) private var reduceTransparency

  /// The fog, ``height`` tall from the top of the screen.
  var body: some View {
    let palette = Palette(scheme: scheme)
    ZStack {
      if !reduceTransparency {
        ForEach(Self.layers, id: \.solid) { layer in
          Rectangle().fill(.ultraThinMaterial).mask(Self.fade(layer))
        }
      }
      LinearGradient(
        stops: [
          .init(color: palette.page.opacity(reduceTransparency ? 1 : Self.paper.top), location: 0),
          .init(
            color: palette.page.opacity(reduceTransparency ? 1 : Self.paper.held),
            location: Self.paperFrom / Self.height),
          .init(color: palette.page.opacity(0), location: 1),
        ],
        startPoint: .top, endPoint: .bottom)
    }
    .frame(height: Self.height)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// A layer's mask: opaque down to its solid point, then fading out.
  ///
  /// - Remark: Locations are fractions of ``height``.
  /// - SideEffects: none
  /// - Parameter layer: The layer.
  /// - Returns: The gradient.
  private static func fade(_ layer: Layer) -> LinearGradient {
    LinearGradient(
      stops: [
        .init(color: .black, location: 0), .init(color: .black, location: layer.solid / height),
        .init(color: .clear, location: layer.clear / height),
      ],
      startPoint: .top, endPoint: .bottom)
  }
}
