import SwiftUI

/// The placeholder first screen: the serif title on the warm page colour.
///
/// - Remark: MP1 only proves the app builds, signs and opens (roadmap MP1); the real home
///   screen comes in MP4 and MP6. Colours and the serif title follow design-language "手机端".
public struct HomeView: View {
  /// The title shown at the top.
  public static let title = "Atrium"

  /// Whether the screen is light or dark, which picks the colours.
  @Environment(\.colorScheme) private var scheme

  /// Makes the screen.
  ///
  /// - Remark: Public so the app target can show it.
  /// - SideEffects: none
  public init() {}

  /// The title and a line saying the app is not connected yet.
  public var body: some View {
    let palette = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 8) {
      Text(Self.title)
        .font(.system(size: 34, weight: .semibold, design: .serif))
        .foregroundStyle(palette.text)
        .accessibilityIdentifier("home.title")
      Text("还没连上 Mac")
        .font(.system(size: 15))
        .foregroundStyle(palette.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .padding(.horizontal, 20)
    .padding(.top, 24)
    .background(palette.page.ignoresSafeArea())
  }
}
