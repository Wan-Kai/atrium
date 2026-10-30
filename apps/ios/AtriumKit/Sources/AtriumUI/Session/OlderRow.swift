import SwiftUI

/// The top row of a conversation that has older turns on the Mac: a small spinner and "正在载入更早的"
/// while they load, empty otherwise.
///
/// - Remark: SPEC-0005 "MP4a 定的细节" 9 (prototype A). The page fetches when this row shows, so it
///   keeps its height when empty and the content does not jump when the spinner comes.
struct OlderRow: View {
  /// Whether older turns are on their way.
  let loading: Bool
  @Environment(\.colorScheme) private var scheme

  /// The row.
  ///
  /// - Remark: Centred, in the meta size, like the page's other notices.
  /// - SideEffects: none
  var body: some View {
    let palette = Palette(scheme: scheme)
    HStack(spacing: 6) {
      if loading {
        ProgressView().controlSize(.mini).frame(width: 12, height: 12)
        Text("正在载入更早的").font(Typography.meta).foregroundStyle(palette.tertiary)
      }
    }
    .frame(maxWidth: .infinity, minHeight: 18)
    .accessibilityElement(children: .combine)
  }
}
