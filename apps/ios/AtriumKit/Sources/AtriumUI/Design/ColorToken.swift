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
/// - Remark: The paper redesign (2026-10-28): the table in design-language lists the main ones and
///   the sticky notes; the rest (fills, glass, diff rows) come from the paper prototypes
///   (`mobile-conversation-paper-prototype.html`), whose CSS variable each case names. Warm
///   throughout: dark is a dim warm paper, not black.
enum ColorToken: CaseIterable, Sendable {
  /// `--bg`: the page.
  case page
  /// `--note`: a lighter sheet on the page: the user's bubble, sheets.
  case note
  /// `--surf`: a quiet ground on the paper: code, the chosen row, button grounds.
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
  /// `--tint`: the deep beige theme colour: accent, unread, running, chosen.
  case tint
  /// `--tint-soft`: a faint ground of the theme colour.
  case tintSoft
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
  /// A sticky note for something stuck (an error, a sign-in).
  case stickyStuck
  /// The words on a stuck note.
  case stickyStuckInk
  /// A sticky note for something waiting on you (a question).
  case stickyWaiting
  /// The words on a waiting note.
  case stickyWaitingInk
  /// A sticky note for a reminder.
  case stickyReminder
  /// The words on a reminder note.
  case stickyReminderInk

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
    case .page: RGBA(0xf6f2e9)
    case .note: RGBA(0xfffcf5)
    case .surface: RGBA(0xefe9dc)
    case .text: RGBA(0x26221c)
    case .text2: RGBA(0x4d473d)
    case .secondary: RGBA(0x8b8477)
    case .tertiary: RGBA(0xd3cbbb)
    case .line: RGBA(0x46371e, 0.11)
    case .fill: RGBA(0x26221c, 0.06)
    case .fill2: RGBA(0x26221c, 0.035)
    case .ink: RGBA(0x26221c)
    case .onInk: RGBA(0xf6f2e9)
    case .tint: RGBA(0x8a7352)
    case .tintSoft: RGBA(0x8a7352, 0.14)
    case .attn: RGBA(0xc0651c)
    case .attnText: RGBA(0xa9561a)
    case .attnSoft: RGBA(0xc0651c, 0.12)
    case .danger: RGBA(0xc13f35)
    case .dangerSoft: RGBA(0xc13f35, 0.1)
    case .ok: RGBA(0x3d7a4a)
    case .okText: RGBA(0x3d7a4a)
    case .code: RGBA(0xefe9dc)
    case .addBackground: RGBA(0x3d7a4a, 0.12)
    case .deleteBackground: RGBA(0xc13f35, 0.11)
    case .glassBackground: RGBA(0xfffcf5, 0.72)
    case .glassSolid: RGBA(0xfbf7ee)
    case .glassRing: RGBA(0x46371e, 0.11)
    case .glassShadow: RGBA(0x32230a, 0.18)
    case .rail: RGBA(0x3c321e, 0.14)
    case .branch: RGBA(0x3c321e, 0.26)
    case .node: RGBA(0xcbc3b4)
    case .stickyStuck: RGBA(0xf4cdc4)
    case .stickyStuckInk: RGBA(0x3d1913)
    case .stickyWaiting: RGBA(0xf7dfb8)
    case .stickyWaitingInk: RGBA(0x3a2610)
    case .stickyReminder: RGBA(0xdfe0cf)
    case .stickyReminderInk: RGBA(0x262a17)
    }
  }

  /// The dark value.
  private var dark: RGBA {
    switch self {
    case .page: RGBA(0x1c1a16)
    case .note: RGBA(0x25221d)
    case .surface: RGBA(0x2b2822)
    case .text: RGBA(0xeee9df)
    case .text2: RGBA(0xcec7b9)
    case .secondary: RGBA(0x8f887b)
    case .tertiary: RGBA(0x4a453c)
    case .line: RGBA(0xeee9df, 0.09)
    case .fill: RGBA(0xeee9df, 0.07)
    case .fill2: RGBA(0xeee9df, 0.045)
    case .ink: RGBA(0xeee9df)
    case .onInk: RGBA(0x1c1a16)
    case .tint: RGBA(0xc9b28c)
    case .tintSoft: RGBA(0xc9b28c, 0.16)
    case .attn: RGBA(0xe6944a)
    case .attnText: RGBA(0xeda25a)
    case .attnSoft: RGBA(0xe6944a, 0.16)
    case .danger: RGBA(0xec6a5e)
    case .dangerSoft: RGBA(0xec6a5e, 0.14)
    case .ok: RGBA(0x7bbf8a)
    case .okText: RGBA(0x7bbf8a)
    case .code: RGBA(0x2b2822)
    case .addBackground: RGBA(0x7bbf8a, 0.13)
    case .deleteBackground: RGBA(0xec6a5e, 0.13)
    case .glassBackground: RGBA(0x25221d, 0.66)
    case .glassSolid: RGBA(0x2b2822)
    case .glassRing: RGBA(0xeee9df, 0.14)
    case .glassShadow: RGBA(0x000000, 0.5)
    case .rail: RGBA(0xfff0dc, 0.13)
    case .branch: RGBA(0xfff0dc, 0.26)
    case .node: RGBA(0x5f5951)
    case .stickyStuck: RGBA(0xc2948a)
    case .stickyStuckInk: RGBA(0x2a110d)
    case .stickyWaiting: RGBA(0xc4a77c)
    case .stickyWaitingInk: RGBA(0x24180a)
    case .stickyReminder: RGBA(0xa8aa95)
    case .stickyReminderInk: RGBA(0x1d2012)
    }
  }
}
