import SwiftUI

/// A small monospaced tag: "未提交 · ↑3", "已合并", or a path to follow on the Mac.
///
/// - Remark: The prototype's `.mk`: 11.5pt medium SF Mono, 18pt high, 6pt corners, on a quiet
///   fill; the uncommitted tone is orange on its soft fill, the merged tone green.
struct MonoTag: View {
  /// The tag's colours.
  ///
  /// - Remark: The three tones the prototype uses.
  enum Tone: Equatable, Sendable {
    /// Grey on a quiet fill.
    case plain
    /// Orange: uncommitted, ahead.
    case attention
    /// Green: merged.
    case merged
  }

  /// The words.
  let text: String
  /// The colours.
  var tone: Tone = .plain
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The tag.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let (foreground, background): (Color, Color) =
      switch tone {
      case .plain: (palette.secondary, palette.fill)
      case .attention: (palette.attnText, palette.attnSoft)
      case .merged: (palette.okText, palette.ok.opacity(0.11))
      }
    Text(text)
      .font(Typography.tag)
      .lineLimit(1)
      .foregroundStyle(foreground)
      .padding(.horizontal, 6)
      .frame(height: 18)
      .background(background, in: RoundedRectangle(cornerRadius: Metrics.radiusSmall))
  }
}
