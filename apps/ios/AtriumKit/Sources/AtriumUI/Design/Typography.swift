import SwiftUI

/// The phone's type scale and the rule for the serif (design-language "手机端 · 字体").
///
/// - Remark: Sizes in points as the document gives them; screens take fonts from here instead of
///   writing sizes. Body text is the system font (SF Pro with PingFang for Chinese, which iOS picks
///   by itself); code is SF Mono.
enum Typography {
  /// Reply body: 16.5pt.
  static let reply = Font.system(size: 16.5)
  /// The line height of a reply, as a multiple of its size.
  static let replyLineHeight = 1.65
  /// A session row's title: 16pt.
  static let rowTitle = Font.system(size: 16)
  /// Metadata under a row, and group titles: 13pt.
  static let meta = Font.system(size: 13)
  /// A step of the process rail: 12.5pt.
  static let step = Font.system(size: 12.5)
  /// A command or path on the rail: 12pt mono.
  static let stepMono = Font.system(size: 12, design: .monospaced)
  /// Code in a reply: 12.5pt mono.
  static let code = Font.system(size: 12.5, design: .monospaced)
  /// Diff lines: 11.5pt mono.
  static let diff = Font.system(size: 11.5, design: .monospaced)
  /// Small mono tags such as "未提交 · ↑3": 11.5pt medium.
  static let tag = Font.system(size: 11.5, weight: .medium, design: .monospaced)

  /// The title "Atrium" and the big digits: Fraunces italic.
  ///
  /// - Remark: design-language "手机端 · 字体": only "Atrium" and 0–9 are in the bundled cut, so
  ///   anything else must not use it. A fixed size: the title does not follow Dynamic Type.
  /// - SideEffects: Registers the bundled fonts on first use.
  /// - Parameter size: The size in points.
  /// - Returns: The font.
  static func brand(size: CGFloat) -> Font {
    BrandFonts.register()
    return .custom(BrandFonts.title, fixedSize: size)
  }

  /// "agent" on the question card: Syne 700, as on the desktop.
  ///
  /// - Remark: Only the letters of "agent" are in the bundled cut.
  /// - SideEffects: Registers the bundled fonts on first use.
  /// - Parameter size: The size in points.
  /// - Returns: The font.
  static func agent(size: CGFloat) -> Font {
    BrandFonts.register()
    return .custom(BrandFonts.agent, fixedSize: size)
  }

  /// The font for a name shown large, by what it is written in.
  ///
  /// - Remark: New York only goes on Latin text and numbers ("Atrium", English project names,
  ///   the big counts, the pairing code); a name with Chinese in it would mix a serif Latin with a
  ///   sans Chinese glyph, so it takes PingFang semibold, a little smaller to look the same size
  ///   (prototype: 23pt serif, 19pt Chinese). No Chinese serif is bundled.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The text to show.
  ///   - size: The serif size.
  ///   - cjkSize: The size when it falls back; defaults to about 83% of `size`.
  /// - Returns: The font.
  static func display(for text: String, size: CGFloat, cjkSize: CGFloat? = nil) -> Font {
    if isLatinOnly(text) {
      return .system(size: size, weight: .regular, design: .serif)
    }
    return .system(size: cjkSize ?? (size * 0.83).rounded(), weight: .semibold)
  }

  /// Tells whether a text is only Latin letters, digits, punctuation and spaces.
  ///
  /// - Remark: The serif's rule (see `display(for:size:cjkSize:)`). A whitelist, not "has no
  ///   Chinese": Latin-1, Latin Extended A and B, Latin Extended Additional and general
  ///   punctuation pass; Chinese, Japanese, Korean, Cyrillic and emoji do not, so anything the serif
  ///   may lack falls back. Stricter than the prototype, which only looked for CJK.
  /// - SideEffects: none
  /// - Parameter text: The text.
  /// - Returns: Whether the serif may show it.
  static func isLatinOnly(_ text: String) -> Bool {
    text.unicodeScalars.allSatisfy { scalar in
      switch scalar.value {
      case 0x0000...0x024F, 0x1E00...0x1EFF, 0x2000...0x206F: true
      default: false
      }
    }
  }
}

/// Sets the display font of a name by what it is written in.
///
/// - Remark: A modifier cannot read the text of the view it wraps, so the text is passed again;
///   see `Typography.display(for:size:cjkSize:)`.
private struct DisplayFont: ViewModifier {
  /// The text the view shows.
  let text: String
  /// The serif size.
  let size: CGFloat
  /// The fallback size, if not the default.
  let cjkSize: CGFloat?

  /// Applies the font.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter content: The view.
  /// - Returns: The view with the font.
  func body(content: Content) -> some View {
    content.font(Typography.display(for: text, size: size, cjkSize: cjkSize))
  }
}

extension View {
  /// Sets the serif for a Latin name, or PingFang semibold when it has other characters.
  ///
  /// - Remark: design-language "手机端 · 字体"; see `Typography.display(for:size:cjkSize:)`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The text the view shows.
  ///   - size: The serif size.
  ///   - cjkSize: The fallback size, if not about 83% of `size`.
  /// - Returns: The view with the font.
  func displayFont(for text: String, size: CGFloat, cjkSize: CGFloat? = nil) -> some View {
    modifier(DisplayFont(text: text, size: size, cjkSize: cjkSize))
  }
}
