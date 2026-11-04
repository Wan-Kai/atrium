import AtriumProtocol
import AtriumRemote
import AtriumSync
import SwiftUI

/// The first screen: the serif title, the connection pill, and the sessions to open.
///
/// - Remark: SPEC-0005 "MP6 定的细节 · MP6b" after the final prototype: the menu key (which opens the
///   drawer), the 40pt serif title and the connection pill; "等你处理"; each project under its
///   serif title, folding, with "N 在跑"; its workspaces under small titles with their tags, three
///   sessions each and "还有 N 个"; the chats, five and "显示全部 N 个"; the pixel cat when there is
///   nothing. Without a connection yet it says so. The workspaces shown are watched for changes.
public struct HomeView: View {
  /// The title shown at the top.
  public static let title = "Atrium"

  /// The connection's sync, once there is a connection.
  @Environment(SyncModel.self) private var sync: SyncModel?
  /// Whether the screen is light or dark, which picks the colours.
  @Environment(\.colorScheme) private var scheme
  /// The projects folded away.
  @State private var folded: Set<ProjectId> = []
  /// Whether every chat shows.
  @State private var allChats = false
  /// Whether the drawer is open.
  @State private var drawer = false
  /// The appearance chosen in the drawer: "system", "light" or "dark".
  @AppStorage("appearance") private var appearance = "system"

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
            .font(.system(size: 40, design: .serif))
            .tracking(-0.3)
            .foregroundStyle(palette.text)
            .padding(.top, Metrics.glassButton + Metrics.xs)
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
      .overlay(alignment: .topLeading) {
        GlassCircleButton(systemImage: "line.3.horizontal", label: "菜单", badge: Self.warns(sync)) { drawer = true }
          .padding(.leading, Metrics.md)
          .accessibilityIdentifier("home.menu")
      }
      .overlay(alignment: .bottomTrailing) {
        if let sync, sync.core.index.ready {
          NewSessionKey(
            route: NewSessionRoute(container: HomeList.newSessionPlace(in: sync.core.index)))
        }
      }
      .hidingNavigationBar()
      .navigationDestination(for: SessionId.self) { SessionPage(sessionId: $0) }
      .navigationDestination(for: NewSessionRoute.self) { NewSessionPage(route: $0) }
      .navigationDestination(for: ChangesRoute.self) { ChangesPage(workspaceId: $0.workspaceId) }
      .navigationDestination(for: WorkspaceRoute.self) { WorkspacePage(workspaceId: $0.workspaceId) }
      .task(id: sync?.home.projects.flatMap { $0.workspaces.map(\.id) }) {
        sync?.watchChanges(sync?.home.projects.flatMap { $0.workspaces.map(\.id) } ?? [])
      }
    }
    .overlay {
      if drawer, let sync { Drawer(sync: sync) { drawer = false } }
    }
    .preferredColorScheme(Self.scheme(appearance))
  }

  /// The colour scheme for the appearance chosen in the drawer.
  ///
  /// - Remark: "跟随系统" leaves it to the system.
  /// - SideEffects: none
  /// - Parameter appearance: "system", "light" or "dark".
  /// - Returns: The scheme, or `nil` to follow the system.
  static func scheme(_ appearance: String) -> ColorScheme? {
    switch appearance {
    case "light": .light
    case "dark": .dark
    default: nil
    }
  }

  /// Whether the menu key carries a dot: the connection has trouble, or the signature runs out soon.
  ///
  /// - Remark: The prototype's `bdot`, and SPEC-0005 "MP6 定的细节 · MP6b" for the signature.
  /// - SideEffects: Reads the App's profile.
  /// - Parameter sync: The connection's sync.
  /// - Returns: Whether it does.
  static func warns(_ sync: SyncModel?) -> Bool {
    let trouble = sync.map { pill(for: $0.status) != .connected && pill(for: $0.status) != .syncing } ?? false
    let expiring = Signing.appExpiry().map { Signing.soon(expiry: $0, now: .now) } ?? false
    return trouble || expiring
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
    if ready && home.projects.isEmpty {
      EmptyHome(hasChats: !home.chats.isEmpty)
    }
    if !home.inbox.isEmpty {
      groupTitle("等你处理", count: home.inbox.count, palette: palette)
      ForEach(home.inbox) { SessionRow(row: $0) }
    }
    ForEach(home.projects) { project in
      Button {
        withAnimation(MotionToken.smooth.resolved(reduceMotion: false).animation) {
          if folded.contains(project.id) { folded.remove(project.id) } else { folded.insert(project.id) }
        }
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(project.name)
            .font(Typography.display(for: project.name, size: 23, cjkSize: 19))
            .foregroundStyle(palette.text)
          Image(systemName: "chevron.down").font(.system(size: 13, weight: .semibold)).foregroundStyle(palette.tertiary)
            .rotationEffect(.degrees(folded.contains(project.id) ? -90 : 0))
          Spacer()
          if project.running > 0 {
            Text("\(project.running) 在跑").font(Typography.meta).foregroundStyle(palette.secondary)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .padding(.top, 38)
      .padding(.bottom, 2)
      if !folded.contains(project.id) {
        ForEach(project.workspaces) { workspace in
          WorkspaceHeader(workspace: workspace, changes: sync?.core.changes[workspace.id])
          if workspace.rows.isEmpty {
            Text("还没有会话").font(.system(size: 14)).foregroundStyle(palette.secondary).padding(.leading, 44)
              .padding(.vertical, Metrics.xs)
          }
          ForEach(workspace.shown) { SessionRow(row: $0) }
            .opacity(workspace.merged ? 0.55 : 1)
          if workspace.more > 0 {
            NavigationLink(value: WorkspaceRoute(workspaceId: workspace.id)) {
              Text("还有 \(workspace.more) 个").font(.system(size: 15)).foregroundStyle(palette.tint)
                .padding(.leading, 28).frame(minHeight: 42)
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
    if !home.chats.isEmpty {
      HStack(alignment: .lastTextBaseline) {
        groupTitle("对话", count: home.chats.count, palette: palette)
        Spacer()
        NavigationLink(value: NewSessionRoute(container: nil)) {
          Image(systemName: "plus").font(.system(size: 17)).foregroundStyle(palette.secondary)
            .frame(width: 44, height: 36)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("新对话")
        .padding(.bottom, 2)
      }
      ForEach(allChats ? home.chats : home.shownChats) { SessionRow(row: $0) }
      if !allChats, home.chats.count > home.shownChats.count {
        Button("显示全部 \(home.chats.count) 个") { allChats = true }
          .font(.system(size: 15)).foregroundStyle(palette.tint).frame(minHeight: 42).buttonStyle(.plain)
      }
    }
  }

  /// A group's small title with its count.
  ///
  /// - Remark: The prototype's `.gl`: 14pt grey, the count tabular.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The title.
  ///   - count: How many it has.
  ///   - palette: The colours.
  /// - Returns: The title.
  private func groupTitle(_ text: String, count: Int, palette: Palette) -> some View {
    Text("\(text) \(count)")
      .font(.system(size: 14))
      .monospacedDigit()
      .foregroundStyle(palette.secondary)
      .padding(.top, 30)
      .padding(.bottom, 6)
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
          HStack(spacing: 5) {
            Text(row.title)
              .font(Typography.rowTitle)
              .foregroundStyle(palette.text)
              .lineLimit(1)
            if row.pinned {
              Image(systemName: "pin.fill")
                .font(.system(size: 11))
                .foregroundStyle(palette.tint)
                .accessibilityLabel("已置顶")
            }
          }
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
