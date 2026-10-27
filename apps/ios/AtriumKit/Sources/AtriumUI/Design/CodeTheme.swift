import AtriumRender
import SwiftUI

/// The phone's quiet syntax colours, matching the final prototype in both appearances.
///
/// - Remark: Highlighters return scopes, not platform colours; the design layer owns their look.
///   Keywords are warm red, constants blue, strings green, comments metadata grey.
enum CodeTheme {
  /// Colours token runs without using HTML or a web view.
  ///
  /// - Remark: Kept separate from highlighting so an appearance change need not parse again.
  /// - SideEffects: none
  /// - Parameters:
  ///   - tokens: The tokens in source order.
  ///   - scheme: The current appearance.
  /// - Returns: Coloured text with unchanged characters.
  static func attributed(_ tokens: [CodeToken], scheme: ColorScheme) -> AttributedString {
    let palette = Palette(scheme: scheme)
    let dark = scheme == .dark
    var result = AttributedString()
    for token in tokens {
      var part = AttributedString(token.text)
      part.foregroundColor =
        switch token.scope {
        case .keyword: RGBA(dark ? 0xff8f7a : 0xb5402c).color
        case .constant, .property: RGBA(dark ? 0x9cc5ff : 0x1f5fa8).color
        case .string: RGBA(dark ? 0x8fd29f : 0x2c7a3e).color
        case .comment: palette.secondary
        case .title: palette.text2
        case .addition: palette.okText
        case .deletion: palette.danger
        case nil: palette.text2
        }
      result += part
    }
    return result
  }
}
