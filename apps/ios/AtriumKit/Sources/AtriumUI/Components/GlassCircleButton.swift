import SwiftUI

/// A round floating button on Liquid Glass: back, more, the menu, the "+" (design-language "手机端 · 原则").
///
/// - Remark: 44pt at the top, 58pt for the "+" at the bottom right; the glass is interactive, so
///   the system lifts it slightly and lights it under the finger. An optional orange badge says the
///   host has a problem (the menu button). The icon is an SF Symbol.
struct GlassCircleButton: View {
  /// The SF Symbol's name.
  let systemImage: String
  /// What VoiceOver reads.
  let label: String
  /// The diameter.
  var size: CGFloat = Metrics.glassButton
  /// Whether to show the orange dot.
  var badge = false
  /// What a tap does.
  let action: () -> Void
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The button.
  var body: some View {
    let palette = Palette(scheme: scheme)
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.system(size: size > Metrics.glassButton ? 22 : 18, weight: .medium))
        .foregroundStyle(palette.text)
        .frame(width: size, height: size)
        .atriumGlass(in: Circle(), interactive: true)
        .overlay(alignment: .topTrailing) {
          if badge {
            Circle()
              .fill(palette.attn)
              .frame(width: 8, height: 8)
              .padding(2)
              .background(palette.page, in: Circle())
              .offset(x: -6, y: 6)
          }
        }
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text(label))
  }
}
