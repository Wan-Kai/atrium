import SwiftUI

/// The phone's colours for one appearance, from design-language "手机端 · 颜色".
///
/// - Remark: Every screen takes its colours from here (`ColorToken` holds the values), so none
///   writes a hex of its own. Written as values instead of an asset catalog so the module builds
///   and tests with `swift build` on macOS, where SwiftPM does not compile asset catalogs.
struct Palette {
  /// Light or dark.
  let scheme: ColorScheme

  /// Picks the colours for an appearance.
  ///
  /// - Remark: Dark is a warm dark grey, not black (design-language).
  /// - SideEffects: none
  /// - Parameter scheme: Light or dark.
  init(scheme: ColorScheme) {
    self.scheme = scheme
  }

  /// A token's colour in this appearance.
  ///
  /// - Remark: For code that picks the token at run time; screens use the named properties below.
  /// - SideEffects: none
  /// - Parameter token: The token.
  /// - Returns: The colour.
  func callAsFunction(_ token: ColorToken) -> Color {
    token.value(in: scheme).color
  }

  var page: Color { self(.page) }
  var surface: Color { self(.surface) }
  var text: Color { self(.text) }
  var text2: Color { self(.text2) }
  var secondary: Color { self(.secondary) }
  var tertiary: Color { self(.tertiary) }
  var line: Color { self(.line) }
  var fill: Color { self(.fill) }
  var fill2: Color { self(.fill2) }
  var ink: Color { self(.ink) }
  var onInk: Color { self(.onInk) }
  var tint: Color { self(.tint) }
  var attn: Color { self(.attn) }
  var attnText: Color { self(.attnText) }
  var attnSoft: Color { self(.attnSoft) }
  var danger: Color { self(.danger) }
  var dangerSoft: Color { self(.dangerSoft) }
  var ok: Color { self(.ok) }
  var okText: Color { self(.okText) }
  var code: Color { self(.code) }
  var addBackground: Color { self(.addBackground) }
  var deleteBackground: Color { self(.deleteBackground) }
  var glassBackground: Color { self(.glassBackground) }
  var glassSolid: Color { self(.glassSolid) }
  var glassRing: Color { self(.glassRing) }
  var glassShadow: Color { self(.glassShadow) }
  var rail: Color { self(.rail) }
  var branch: Color { self(.branch) }
  var node: Color { self(.node) }
}
