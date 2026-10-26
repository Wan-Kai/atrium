import SwiftUI

/// The pill under the home title that says how the phone is connected (design-language "手机端 · 首页").
///
/// - Remark: A quiet filled pill, not glass: it sits in the content. A green dot and the Mac's name
///   when connected; a small spinner while syncing or reconnecting; grey, red or orange dots when the
///   Mac is offline, the relay cannot be reached or the versions differ (prototype `CONN`). The
///   sentence that explains a problem is the screen's, below the pill.
struct ConnectionPill: View {
  /// How the phone is connected.
  ///
  /// - Remark: What the connection layer reports, reduced to what the pill shows.
  enum State: Equatable, Sendable {
    /// Connected and up to date.
    case connected
    /// Connected, catching up.
    case syncing
    /// Trying to connect again.
    case reconnecting
    /// The Mac does not answer.
    case offline
    /// The relay cannot be reached.
    case relayUnreachable
    /// The Mac's Atrium and the app speak different protocol versions.
    case versionMismatch
  }

  /// How the phone is connected.
  let state: State
  /// The Mac's name.
  let hostName: String
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The pill.
  var body: some View {
    let palette = Palette(scheme: scheme)
    HStack(spacing: 7) {
      mark(palette)
      Text(label).lineLimit(1)
    }
    .font(Typography.meta)
    .foregroundStyle(palette.text2)
    .padding(.leading, 10)
    .padding(.trailing, 12)
    .frame(height: 30)
    .background(palette.fill, in: Capsule())
    .accessibilityElement(children: .combine)
  }

  /// The words in the pill.
  private var label: String {
    switch state {
    case .connected: hostName
    case .syncing: "正在同步…"
    case .reconnecting: "正在重连…"
    case .offline: "\(hostName) · 离线"
    case .relayUnreachable: "连不上 relay"
    case .versionMismatch: "版本不一致"
    }
  }

  /// The dot or spinner before the words.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The mark.
  @ViewBuilder
  private func mark(_ palette: Palette) -> some View {
    switch state {
    case .syncing, .reconnecting:
      ProgressView().controlSize(.mini).frame(width: 12, height: 12)
    case .connected: dot(palette.ok)
    case .offline: dot(palette.tertiary)
    case .relayUnreachable: dot(palette.danger)
    case .versionMismatch: dot(palette.attn)
    }
  }

  /// A 7pt dot.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter color: Its colour.
  /// - Returns: The dot.
  private func dot(_ color: Color) -> some View {
    Circle().fill(color).frame(width: 7, height: 7)
  }
}
