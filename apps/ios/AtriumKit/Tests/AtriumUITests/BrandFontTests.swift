import CoreText
import Testing

@testable import AtriumUI

@Suite("Brand fonts")
struct BrandFontTests {
  /// Whether a registered font has a glyph for every character of a text.
  ///
  /// - Remark: A font CoreText cannot find falls back to another, which would pass a plain lookup,
  ///   so the PostScript name is checked too.
  /// - SideEffects: none
  /// - Parameters:
  ///   - name: The PostScript name.
  ///   - text: The characters.
  /// - Returns: Whether the font is the one asked for and covers the text.
  private func covers(_ name: String, _ text: String) -> Bool {
    let font = CTFontCreateWithName(name as CFString, 20, nil)
    guard CTFontCopyPostScriptName(font) as String == name else { return false }
    let units = Array(text.utf16)
    var glyphs = [CGGlyph](repeating: 0, count: units.count)
    return CTFontGetGlyphsForCharacters(font, units, &glyphs, units.count) && !glyphs.contains(0)
  }

  @Test("registers the title's Fraunces with Atrium's letters and the digits")
  func fraunces() {
    BrandFonts.register()
    #expect(covers(BrandFonts.title, "Atrium0123456789"))
  }

  @Test("registers the question card's Syne with the letters of agent")
  func syne() {
    BrandFonts.register()
    #expect(covers(BrandFonts.agent, "agent"))
  }

  @Test("registering twice does no harm")
  func twice() {
    BrandFonts.register()
    BrandFonts.register()
    #expect(covers(BrandFonts.title, "Atrium"))
  }
}
