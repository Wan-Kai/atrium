import SwiftUI

/// One colour as design-language writes it: a hex value and an opacity.
///
/// - Remark: Kept as numbers, not `Color`, so tests can compare them with the document's table and
///   the module builds on macOS, where SwiftPM does not compile asset catalogs.
struct RGBA: Equatable, Sendable {
  /// `0xRRGGBB`.
  let hex: UInt32
  /// From 0 to 1.
  let opacity: Double

  /// Makes a colour.
  ///
  /// - Remark: Opaque unless said otherwise, as most of the table is.
  /// - SideEffects: none
  /// - Parameters:
  ///   - hex: `0xRRGGBB`.
  ///   - opacity: From 0 to 1.
  init(_ hex: UInt32, _ opacity: Double = 1) {
    self.hex = hex
    self.opacity = opacity
  }

  /// The colour for SwiftUI, in sRGB.
  var color: Color {
    Color(
      .sRGB,
      red: Double((hex >> 16) & 0xff) / 255,
      green: Double((hex >> 8) & 0xff) / 255,
      blue: Double(hex & 0xff) / 255,
      opacity: opacity
    )
  }
}

/// The phone's colours, each with its light and dark value (design-language "手机端 · 颜色").
///
/// - Remark: The table in design-language lists the main ones; the rest (lines, fills, glass, diff
///   rows) come from the final prototype `mobile-app-final-prototype.html`, whose CSS variable each
///   case names. Warm throughout: dark is a warm dark grey, not black.
enum ColorToken: CaseIterable, Sendable {
  /// `--bg`: the page.
  case page
  /// `--surf`: the user's bubble.
  case surface
  /// `--text`: body text and titles.
  case text
  /// `--text-2`: secondary body text.
  case text2
  /// `--l2`: metadata and group titles.
  case secondary
  /// `--l3`: fainter lines, placeholders, the "·" between metadata.
  case tertiary
  /// `--line`: hairlines.
  case line
  /// `--fill`: quiet fills such as the connection pill and inline code.
  case fill
  /// `--fill2`: an even quieter fill.
  case fill2
  /// `--ink`: dark solid buttons.
  case ink
  /// `--on-ink`: what sits on `ink`.
  case onInk
  /// `--tint`: accent, unread, running.
  case tint
  /// `--attn`: asking you.
  case attn
  /// `--attn-text`: words that ask you.
  case attnText
  /// `--attn-soft`: the background of an "uncommitted" tag.
  case attnSoft
  /// `--danger`: errors.
  case danger
  /// `--danger-soft`: the background behind an error.
  case dangerSoft
  /// `--ok`: added, passed.
  case ok
  /// `--ok-text`: words that say so.
  case okText
  /// `--code`: code blocks.
  case code
  /// `--add-bg`: an added diff line.
  case addBackground
  /// `--del-bg`: a deleted diff line.
  case deleteBackground
  /// `--g-bg`: the tint of glass where the system draws none.
  case glassBackground
  /// The solid colour glass becomes with Reduce Transparency on.
  case glassSolid
  /// `--g-ring`: the thin ring around every piece of glass.
  case glassRing
  /// `--g-sh`: the shadow under floating glass.
  case glassShadow
  /// `--rail`: the process rail's line.
  case rail
  /// `--branch`: curves that leave and join the rail.
  case branch
  /// `--node`: a finished step's dot.
  case node

  /// The value in an appearance.
  ///
  /// - Remark: One switch per appearance keeps each row of the document's table on one line here.
  /// - SideEffects: none
  /// - Parameter scheme: Light or dark.
  /// - Returns: The colour.
  func value(in scheme: ColorScheme) -> RGBA {
    scheme == .dark ? dark : light
  }

  /// The light value.
  private var light: RGBA {
    switch self {
    case .page: RGBA(0xfaf9f5)
    case .surface: RGBA(0xf3f1eb)
    case .text: RGBA(0x1f1e1c)
    case .text2: RGBA(0x3d3b37)
    case .secondary: RGBA(0x86827a)
    case .tertiary: RGBA(0xcbc6bc)
    case .line: RGBA(0x3c321e, 0.1)
    case .fill: RGBA(0x3c321e, 0.055)
    case .fill2: RGBA(0x3c321e, 0.035)
    case .ink: RGBA(0x1f1e1c)
    case .onInk: RGBA(0xfaf9f5)
    case .tint: RGBA(0x2f6fed)
    case .attn: RGBA(0xd97a1e)
    case .attnText: RGBA(0xb3600b)
    case .attnSoft: RGBA(0xd97a1e, 0.11)
    case .danger: RGBA(0xd4463d)
    case .dangerSoft: RGBA(0xd4463d, 0.09)
    case .ok: RGBA(0x2f8a46)
    case .okText: RGBA(0x2c7a3e)
    case .code: RGBA(0xf2efe8)
    case .addBackground: RGBA(0x2f8a46, 0.1)
    case .deleteBackground: RGBA(0xd4463d, 0.085)
    case .glassBackground: RGBA(0xfcfbf7, 0.7)
    case .glassSolid: RGBA(0xf6f4ee)
    case .glassRing: RGBA(0x3c321e, 0.07)
    case .glassShadow: RGBA(0x463214, 0.14)
    case .rail: RGBA(0x3c321e, 0.14)
    case .branch: RGBA(0x3c321e, 0.26)
    case .node: RGBA(0xcbc3b4)
    }
  }

  /// The dark value.
  private var dark: RGBA {
    switch self {
    case .page: RGBA(0x1c1b19)
    case .surface: RGBA(0x252421)
    case .text: RGBA(0xf2efe8)
    case .text2: RGBA(0xd9d5cc)
    case .secondary: RGBA(0x9b968c)
    case .tertiary: RGBA(0x504c46)
    case .line: RGBA(0xfff0dc, 0.09)
    case .fill: RGBA(0xfff5e1, 0.07)
    case .fill2: RGBA(0xfff5e1, 0.045)
    case .ink: RGBA(0xf2efe8)
    case .onInk: RGBA(0x1c1b19)
    case .tint: RGBA(0x8fb0ff)
    case .attn: RGBA(0xe08a35)
    case .attnText: RGBA(0xeda25a)
    case .attnSoft: RGBA(0xe08a35, 0.15)
    case .danger: RGBA(0xef6b5f)
    case .dangerSoft: RGBA(0xef6b5f, 0.13)
    case .ok: RGBA(0x4caf68)
    case .okText: RGBA(0x74c98a)
    case .code: RGBA(0x24231f)
    case .addBackground: RGBA(0x4caf68, 0.13)
    case .deleteBackground: RGBA(0xef6b5f, 0.12)
    case .glassBackground: RGBA(0x383632, 0.62)
    case .glassSolid: RGBA(0x2e2c29)
    case .glassRing: RGBA(0xfff5e6, 0.08)
    case .glassShadow: RGBA(0x000000, 0.5)
    case .rail: RGBA(0xfff0dc, 0.13)
    case .branch: RGBA(0xfff0dc, 0.26)
    case .node: RGBA(0x5f5951)
    }
  }
}
