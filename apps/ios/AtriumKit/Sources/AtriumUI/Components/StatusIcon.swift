import SwiftUI

/// A session's state as the lists show it, in the status column before a row's title.
///
/// - Remark: design-language "会话状态" and "手机端 · 首页": state is told by shape, not only
///   colour. Asking you and error take the desktop's shapes (a question mark and an exclamation
///   mark in a circle), running is the dot vortex, finished-unread a 7pt blue dot; idle draws
///   nothing. SF Symbols stand in for the desktop's Hugeicons, as the native set on iOS.
struct StatusIcon: View {
  /// What the icon shows.
  ///
  /// - Remark: The list states of design-language "会话状态" the phone uses.
  enum Kind: Equatable, Sendable {
    /// The agent asks you something.
    case asking
    /// The run failed.
    case error
    /// The run goes on.
    case running
    /// The run finished and you have not looked.
    case unread
    /// Nothing to say.
    case idle
  }

  /// What to show.
  let kind: Kind
  /// The width and height, in points.
  var size: CGFloat = 15
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The icon, or nothing when idle.
  var body: some View {
    let palette = Palette(scheme: scheme)
    Group {
      switch kind {
      case .asking:
        Image(systemName: "questionmark.circle")
          .resizable()
          .foregroundStyle(palette.attn)
          .accessibilityLabel(Text("在问你"))
      case .error:
        Image(systemName: "exclamationmark.circle")
          .resizable()
          .foregroundStyle(palette.danger)
          .accessibilityLabel(Text("出错"))
      case .running:
        VortexIcon(size: size - 1)
      case .unread:
        Circle()
          .fill(palette.tint)
          .frame(width: 7, height: 7)
          .accessibilityLabel(Text("未读"))
      case .idle:
        Color.clear.accessibilityHidden(true)
      }
    }
    .fontWeight(.medium)
    .frame(width: size, height: size)
  }
}
