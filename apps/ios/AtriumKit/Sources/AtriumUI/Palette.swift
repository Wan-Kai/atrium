import SwiftUI

/// The phone's colours for one appearance, from design-language "手机端 · 颜色".
///
/// - Remark: Written as values instead of an asset catalog so the module builds and tests with
///   `swift build` on macOS, where SwiftPM does not compile asset catalogs.
struct Palette {
  /// The page background (`--bg`).
  let page: Color
  /// Body text (`--text`).
  let text: Color
  /// Metadata and group titles (`--l2`).
  let secondary: Color

  /// Picks the colours for an appearance.
  ///
  /// - Remark: Dark is a warm dark grey, not black (design-language).
  /// - SideEffects: none
  /// - Parameter scheme: Light or dark.
  init(scheme: ColorScheme) {
    let dark = scheme == .dark
    page = dark ? Self.rgb(0x1c1b19) : Self.rgb(0xfaf9f5)
    text = dark ? Self.rgb(0xf2efe8) : Self.rgb(0x1f1e1c)
    secondary = dark ? Self.rgb(0x9b968c) : Self.rgb(0x86827a)
  }

  /// Makes a colour from a hex value as design-language writes it.
  ///
  /// - Remark: Keeps the values in the code identical to the document's.
  /// - SideEffects: none
  /// - Parameter hex: `0xRRGGBB`.
  /// - Returns: The colour in sRGB.
  static func rgb(_ hex: UInt32) -> Color {
    Color(
      .sRGB,
      red: Double((hex >> 16) & 0xff) / 255,
      green: Double((hex >> 8) & 0xff) / 255,
      blue: Double(hex & 0xff) / 255
    )
  }
}
