import SwiftUI

/// The model sheet's left column of provider icons (design-language "手机端 · 模型 sheet").
///
/// - Remark: The desktop's `ProviderColumns` (`packages/ui/src/chat/model-picker.tsx`) in the phone's
///   colours: icons 4pt apart (the desktop's 2px, a little more for a finger), the picked one on
///   `--surface`, the current model's provider dotted at the top right and one on a plan tagged
///   "套餐" at the bottom right, both inside the button and ringed in the sheet's paper. Icons
///   leaving the column fade and blur before they go, instead of being cut off at its edge.
struct ProviderColumn: View {
  /// The providers, in order.
  let providers: [String]
  /// The one whose models show.
  let picked: String?
  /// The current model's provider.
  let current: String?
  /// Shows a provider's models.
  let choose: (String) -> Void
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// How an icon looks partly out of the column.
  ///
  /// - Remark: See `edge(_:)`.
  struct Edge: Equatable {
    /// Its opacity.
    let opacity: Double
    /// Its blur radius, in points.
    let blur: Double
  }

  /// The column.
  var body: some View {
    let palette = Palette(scheme: scheme)
    ScrollView(showsIndicators: false) {
      VStack(spacing: 4) {
        ForEach(providers, id: \.self) { provider in
          Button {
            choose(provider)
          } label: {
            ProviderIcon(providerId: provider, size: 24)
              .frame(width: 48, height: 44)
              .background(picked == provider ? palette.surface : .clear, in: RoundedRectangle(cornerRadius: 12))
              .overlay(alignment: .topTrailing) {
                if current == provider {
                  Circle().fill(palette.tint).frame(width: 6, height: 6)
                    .background(Circle().fill(palette.note).padding(-1.5))
                    .padding(.top, 6).padding(.trailing, 7)
                    .accessibilityLabel("当前模型")
                }
              }
              .overlay(alignment: .bottomTrailing) {
                if ModelChoice.onPlan(provider) { planTag(palette) }
              }
          }
          .buttonStyle(PressStyle())
          .accessibilityLabel(ModelChoice.providerName(provider))
          .accessibilityAddTraits(picked == provider ? .isSelected : [])
          .scrollTransition(.interactive, axis: .vertical) { content, phase in
            let edge = Self.edge(phase.value)
            return content.opacity(edge.opacity).blur(radius: edge.blur)
          }
        }
      }
      .padding(.vertical, 2)
    }
    .frame(width: 56)
  }

  /// The "套餐" tag at an icon's bottom right (the desktop's `PlanTag`).
  ///
  /// - Remark: 8pt semibold in the sheet's paper on the deep beige, 12pt high, corner 4, ringed in
  ///   the paper so it stands off the icon.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The tag.
  private func planTag(_ palette: Palette) -> some View {
    Text("套餐")
      .font(.system(size: 8, weight: .semibold))
      .tracking(-0.2)
      .foregroundStyle(palette.note)
      .padding(.horizontal, 2.5)
      .frame(height: 12)
      .background(palette.tint, in: RoundedRectangle(cornerRadius: 4))
      .background(RoundedRectangle(cornerRadius: 5.5).fill(palette.note).padding(-1.5))
      .padding(.trailing, 1)
      .padding(.bottom, 3)
      .accessibilityLabel("走套餐")
  }

  /// How an icon looks at a place in its scroll transition.
  ///
  /// - Remark: 0 is fully in view and ±1 just out of it: halfway out it is half clear and slightly
  ///   blurred, and it is gone by the time it leaves.
  /// - SideEffects: none
  /// - Parameter value: The transition's phase value.
  /// - Returns: The opacity and blur.
  static func edge(_ value: Double) -> Edge {
    let out = min(1, abs(value))
    return Edge(opacity: 1 - out, blur: 4 * out)
  }
}
