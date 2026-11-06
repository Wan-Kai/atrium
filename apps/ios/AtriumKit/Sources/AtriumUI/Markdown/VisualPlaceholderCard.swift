import SwiftUI

/// The card a reply's `visual` block shows on the phone: the demo's name, then that it opens on the computer.
///
/// - Remark: SPEC-0007 ("手机端") and design-language (2026-11-06): the phone renders no demo. The
///   name gets a title row of its own, cut short when long, and the note a second line, so a long
///   name never pushes the note out.
struct VisualPlaceholderCard: View {
  /// The demo's file name.
  let name: String

  /// Current colours.
  @Environment(\.colorScheme) private var scheme

  /// The card's two lines: the title row, then the note.
  ///
  /// - Remark: Kept apart from the view so the wording is tested.
  /// - SideEffects: none
  /// - Parameter name: The demo's file name.
  /// - Returns: The title, then the note.
  static func lines(name: String) -> [String] { ["演示 · \(name)", "在电脑上查看"] }

  /// The card.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let lines = Self.lines(name: name)
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Image(systemName: "play.circle").foregroundStyle(palette.tint)
        Text(lines[0]).font(Typography.meta).foregroundStyle(palette.text)
          .lineLimit(1).truncationMode(.middle)
      }
      Text(lines[1]).font(Typography.meta).foregroundStyle(palette.secondary)
    }
    .padding(.horizontal, 12).padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(palette.surface, in: RoundedRectangle(cornerRadius: 14))
  }
}
