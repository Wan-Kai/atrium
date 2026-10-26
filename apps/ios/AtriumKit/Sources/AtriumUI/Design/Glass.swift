import SwiftUI

/// Liquid Glass for things that float over the content, with the ring every piece of glass has.
///
/// - Remark: design-language "手机端 · 原则": glass only on what floats (round buttons, pills, the
///   composer's shell, sheets, menus, the diff toolbar, banners), never on content. A 0.5pt ring
///   (`--g-ring`) keeps it visible over pure white or black content. With Reduce Transparency on
///   it becomes a solid fill with the same ring, so nothing behind shows through.
private struct GlassSurface<S: InsettableShape>: ViewModifier {
  /// The outline.
  let shape: S
  /// Whether it reacts to touches (buttons); the system then lifts and lights it under the finger.
  let interactive: Bool
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether the person turned on Reduce Transparency.
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

  /// Draws the glass, or the solid fill, under the content and the ring over it.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter content: What sits on the glass.
  /// - Returns: The content on glass.
  func body(content: Content) -> some View {
    let palette = Palette(scheme: scheme)
    let ring = shape.strokeBorder(palette.glassRing, lineWidth: 0.5)
    if reduceTransparency {
      content
        .background(palette.glassSolid, in: shape)
        .overlay(ring.allowsHitTesting(false))
    } else {
      content
        .glassEffect(.regular.interactive(interactive), in: shape)
        .overlay(ring.allowsHitTesting(false))
    }
  }
}

extension View {
  /// Puts the view on Liquid Glass of a shape, with the thin ring.
  ///
  /// - Remark: The only way screens make glass, so the ring and the Reduce Transparency fallback
  ///   are never forgotten; see `GlassSurface`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - shape: The outline.
  ///   - interactive: Whether it is pressed, like a button.
  /// - Returns: The view on glass.
  func atriumGlass(in shape: some InsettableShape, interactive: Bool = false) -> some View {
    modifier(GlassSurface(shape: shape, interactive: interactive))
  }
}
