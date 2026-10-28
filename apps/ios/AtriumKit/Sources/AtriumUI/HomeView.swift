import AtriumProtocol
import AtriumRemote
import AtriumSync
import SwiftUI

/// The first screen: the serif title, the connection pill, and the sessions to open.
///
/// - Remark: MP4a's simple rows (SPEC-0005 "MP4a 定的细节 · 界面"): "等你处理", then each project's
///   workspaces with their sessions, then the chats' sessions. The full layout, folding and
///   "还有 N 个" come in MP6. Without a connection yet it says so. Colours and the serif title
///   follow design-language "手机端".
public struct HomeView: View {
  /// The title shown at the top.
  public static let title = "Atrium"

  /// The connection's sync, once there is a connection.
  @Environment(SyncModel.self) private var sync: SyncModel?
  /// Whether the screen is light or dark, which picks the colours.
  @Environment(\.colorScheme) private var scheme

  /// Makes the screen.
  ///
  /// - Remark: Public so the app target can show it.
  /// - SideEffects: none
  public init() {}

  /// The home, with session pages pushed on top.
  public var body: some View {
    let palette = Palette(scheme: scheme)
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          Text(Self.title)
            .font(.system(size: 34, weight: .semibold, design: .serif))
            .foregroundStyle(palette.text)
            .accessibilityIdentifier("home.title")
          if let sync {
            ConnectionPill(state: Self.pill(for: sync.status), hostName: sync.hostName)
              .padding(.top, Metrics.xs)
              .accessibilityIdentifier("home.connection")
            if sync.core.stale {
              Text("不是最新").font(Typography.meta).foregroundStyle(palette.tertiary)
                .padding(.top, Metrics.xxs)
                .accessibilityIdentifier("home.stale")
            }
            sections(sync.home, ready: sync.core.index.ready, palette: palette)
          } else {
            Text("还没连上 Mac")
              .font(.system(size: 15))
              .foregroundStyle(palette.secondary)
              .padding(.top, Metrics.xs)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Metrics.page)
        .padding(.top, Metrics.lg)
      }
      .background(palette.page.ignoresSafeArea())
      .hidingNavigationBar()
      .navigationDestination(for: SessionId.self) { SessionPage(sessionId: $0) }
    }
  }

  /// The groups of the list.
  ///
  /// - Remark: Before the first list arrives there is nothing to group; the pill says why.
  /// - SideEffects: none
  /// - Parameters:
  ///   - home: What to list.
  ///   - ready: Whether the list has arrived.
  ///   - palette: The colours.
  /// - Returns: The groups.
  @ViewBuilder
  private func sections(_ home: HomeList, ready: Bool, palette: Palette) -> some View {
    if ready && home.isEmpty {
      Text("Mac 上还没有项目和对话")
        .font(Typography.meta)
        .foregroundStyle(palette.secondary)
        .padding(.top, Metrics.lg)
    }
    if !home.inbox.isEmpty {
      groupTitle("等你处理", palette: palette)
      ForEach(home.inbox) { SessionRow(row: $0) }
    }
    ForEach(home.projects) { project in
      HStack(alignment: .firstTextBaseline) {
        Text(project.name)
          .font(Typography.display(for: project.name, size: 23, cjkSize: 19))
          .foregroundStyle(palette.text)
        Spacer()
        if project.running > 0 {
          Text("\(project.running) 在跑").font(Typography.meta).foregroundStyle(palette.secondary)
        }
      }
      .padding(.top, Metrics.xl)
      ForEach(project.workspaces) { workspace in
        groupTitle(workspace.name, palette: palette)
        ForEach(workspace.rows) { SessionRow(row: $0) }
      }
    }
    if !home.chats.isEmpty {
      groupTitle("对话", palette: palette)
      ForEach(home.chats) { SessionRow(row: $0) }
    }
  }

  /// A group's small title.
  ///
  /// - Remark: 13pt in the meta grey (design-language "手机端 · 字体").
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The title.
  ///   - palette: The colours.
  /// - Returns: The title.
  private func groupTitle(_ text: String, palette: Palette) -> some View {
    Text(text)
      .font(Typography.meta)
      .foregroundStyle(palette.secondary)
      .padding(.top, Metrics.lg)
      .padding(.bottom, Metrics.xxs)
  }

  /// What the pill shows for a connection status.
  ///
  /// - Remark: Connecting counts as syncing; no network as reconnecting; a phone revoked, replaced
  ///   or never confirmed as offline, the line at the bottom saying why.
  /// - SideEffects: none
  /// - Parameter status: The connection's status.
  /// - Returns: The pill's state.
  static func pill(for status: ConnectionStatus) -> ConnectionPill.State {
    switch status {
    case .connected: .connected
    case .connecting, .syncing: .syncing
    case .reconnecting, .noNetwork: .reconnecting
    case .relayUnreachable: .relayUnreachable
    case .versionMismatch: .versionMismatch
    case .hostOffline, .revoked, .superseded, .pairingIncomplete: .offline
    }
  }
}

/// One session's row on the home screen.
///
/// - Remark: The status column first (design-language "手机端 · 首页"), then the title and, in the
///   inbox, the second line; a tap opens the session.
struct SessionRow: View {
  /// What to show.
  let row: HomeList.Row
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The row.
  var body: some View {
    let palette = Palette(scheme: scheme)
    NavigationLink(value: row.id) {
      HStack(alignment: .firstTextBaseline, spacing: Metrics.sm) {
        StatusIcon(kind: Self.kind(row.status))
          .frame(width: 18)
        VStack(alignment: .leading, spacing: 2) {
          Text(row.title)
            .font(Typography.rowTitle)
            .foregroundStyle(palette.text)
            .lineLimit(1)
          if let detail = row.detail {
            Text(detail).font(Typography.meta).foregroundStyle(palette.secondary).lineLimit(1)
          }
        }
        Spacer(minLength: 0)
      }
      .frame(minHeight: Metrics.minimumHit)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("home.session.\(row.id)")
  }

  /// The status icon for a row's mark.
  ///
  /// - Remark: No mark draws nothing.
  /// - SideEffects: none
  /// - Parameter status: The mark.
  /// - Returns: The icon's kind.
  static func kind(_ status: HomeList.Status?) -> StatusIcon.Kind {
    switch status {
    case .asking: .asking
    case .error: .error
    case .running: .running
    case nil: .idle
    }
  }
}

extension View {
  /// Hides the navigation bar: the phone's pages float their own glass buttons instead.
  ///
  /// - Remark: design-language "手机端 · 原则": no navigation bar. macOS, where the package's tests
  ///   run, has no navigation bar to hide.
  /// - SideEffects: none
  /// - Returns: The view.
  func hidingNavigationBar() -> some View {
    #if os(iOS)
      toolbar(.hidden, for: .navigationBar)
    #else
      self
    #endif
  }
}
