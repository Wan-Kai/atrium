import SwiftUI

/// A session's state as the lists show it, in the status column before a row's title.
///
/// - Remark: The paper redesign (design-language "手机端 · 首页", "状态标记"): small marks shared by
///   the home, the workspace page, the settings page and the child list. Running is a 12pt deep
///   beige spinner, asking a 9pt orange ring, an error an 8pt red dot, unread a 7pt deep beige dot,
///   idle a 5pt faint dot. Each says its state to VoiceOver except idle. The spinner stands still
///   with Reduce Motion.
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
  /// The width and height of the column it sits in, in points.
  var size: CGFloat = 16
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The mark, centred in its column.
  var body: some View {
    let palette = Palette(scheme: scheme)
    Group {
      switch kind {
      case .asking:
        Circle().strokeBorder(palette.attn, lineWidth: 2).frame(width: 9, height: 9)
          .accessibilityLabel(Text("在问你"))
      case .error:
        Circle().fill(palette.danger).frame(width: 8, height: 8).accessibilityLabel(Text("出错"))
      case .running:
        Spinner(size: 12, line: 2).accessibilityLabel(Text("进行中"))
      case .unread:
        Circle().fill(palette.tint).frame(width: 7, height: 7).accessibilityLabel(Text("未读"))
      case .idle:
        Circle().fill(palette.tertiary).frame(width: 5, height: 5).accessibilityHidden(true)
      }
    }
    .frame(width: size, height: size)
  }
}

/// The deep beige spinner: a faint ring with a quarter of it darker, turning once in 0.95 s.
///
/// - Remark: The paper prototypes' `.spin`; used for running rows and "正在重连". Still under
///   Reduce Motion.
struct Spinner: View {
  /// The diameter.
  var size: CGFloat = 12
  /// The ring's width.
  var line: CGFloat = 2
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion
  /// Whether it has started turning.
  @State private var turning = false

  /// The spinner.
  var body: some View {
    let palette = Palette(scheme: scheme)
    ZStack {
      Circle().stroke(palette.tintSoft, lineWidth: line)
      Circle().trim(from: 0, to: 0.25).stroke(palette.tint, style: StrokeStyle(lineWidth: line, lineCap: .round))
        .rotationEffect(.degrees(turning ? 360 : 0))
    }
    .frame(width: size - line, height: size - line)
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.linear(duration: 0.95).repeatForever(autoreverses: false)) { turning = true }
    }
  }
}
