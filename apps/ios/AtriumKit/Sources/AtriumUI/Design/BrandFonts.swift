import CoreText
import Foundation

/// The two fonts the App carries, cut down to the characters they set (design-language "手机端 · 字体").
///
/// - Remark: Fraunces italic (opsz 72, weight 560, SOFT 50) for the title "Atrium" and the big
///   digits; Syne 700 for "agent" on the question card, as on the desktop. Both are OFL; each is a
///   static instance holding only those characters (about 5 KB and 2 KB), renamed so they cannot
///   clash with a full copy installed on the device. Registered for the process from the module's
///   resources, since a Swift package cannot list fonts in the App's Info.plist.
nonisolated enum BrandFonts {
  /// The title font's PostScript name.
  static let title = "AtriumFraunces-Italic"
  /// The question card's "agent" font's PostScript name.
  static let agent = "AtriumSyne-Bold"

  /// Registers both fonts once.
  ///
  /// - Remark: Safe to call from anywhere and again; the work is done on the first call. A font
  ///   that fails to register leaves its text in the fallback font, which is shown, not thrown.
  /// - SideEffects: Registers fonts with CoreText for this process, once.
  static func register() {
    _ = registered
  }

  /// The one-time registration.
  private static let registered: Void = {
    for file in ["AtriumFraunces", "AtriumSyne"] {
      guard let url = Bundle.module.url(forResource: file, withExtension: "ttf", subdirectory: "fonts") else {
        continue
      }
      CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
  }()
}
