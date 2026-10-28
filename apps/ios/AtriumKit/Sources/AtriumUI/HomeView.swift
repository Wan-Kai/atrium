import AtriumProtocol
import AtriumRemote
import AtriumSync
import SwiftUI

/// The first screen: the title and the Mac, what waits on you, and each project's worktrees.
///
/// - Remark: The paper redesign (design-language "手机端 · 首页", SPEC-0005 "界面" 2026-10-28):
///   "Atrium" in Fraunces italic at the top left with the Mac under it, the "⋯" settings key at
///   the top right; "等你处理" as sticky notes; each project under its serif title, folding, with
///   "N 在跑", one line a worktree and the merged ones folded; the chats with the new chat icon;
///   the pixel cat when there is nothing. Without a connection yet it says so. The workspaces shown
///   are watched for changes.
public struct HomeView: View {
  /// The title shown at the top.
  public static let title = "Atrium"

  /// The connection's sync, once there is a connection.
  @Environment(SyncModel.self) private var sync: SyncModel?
  /// Whether the screen is light or dark, which picks the colours.
  @Environment(\.colorScheme) private var scheme
  /// The projects folded away.
  @State private var folded: Set<ProjectId> = []
  /// The projects whose merged worktrees are opened.
  @State private var openMerged: Set<ProjectId> = []
  /// Whether every chat shows.
  @State private var allChats = false
  /// The pages pushed over the home.
  @State private var path = NavigationPath()
  /// The appearance chosen in settings: "system", "light" or "dark".
  @AppStorage("appearance") private var appearance = "system"

  /// Makes the screen.
  ///
  /// - Remark: Public so the app target can show it.
  /// - SideEffects: none
  public init() {}

  /// The home, with session pages pushed on top.
  public var body: some View {
    let palette = Palette(scheme: scheme)
    NavigationStack(path: $path) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          masthead(palette)
          if let sync {
            if sync.core.stale {
              Text("下面是 \(sync.hostName) 上次在线时的状态。").font(.system(size: 13)).foregroundStyle(palette.secondary)
                .padding(.top, 4)
                .accessibilityIdentifier("home.stale")
            }
            sections(sync.home, ready: sync.core.index.ready, stale: sync.core.stale, palette: palette)
          } else {
            Text("还没连上 Mac")
              .font(.system(size: 15))
              .foregroundStyle(palette.secondary)
              .padding(.top, Metrics.xs)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Metrics.page)
        .padding(.bottom, 120)
      }
      .background(palette.page.ignoresSafeArea())
      .overlay(alignment: .topTrailing) {
        GlassCircleButton(systemImage: "ellipsis", label: "设置", badge: Self.warns(sync)) {
          path.append(SettingsRoute(from: nil))
        }
        .padding(.trailing, Metrics.md)
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
      .navigationDestination(for: SettingsRoute.self) { SettingsPage(route: $0) }
      .task(id: sync?.home.projects.flatMap { $0.workspaces.map(\.id) }) {
        sync?.watchChanges(sync?.home.projects.flatMap { $0.workspaces.map(\.id) } ?? [])
      }
    }
    .environment(\.openSettings) { path.append(SettingsRoute(from: $0)) }
    .environment(\.switchConversation) { sessionId in
      path.removeLast(min(2, path.count))
      path.append(sessionId)
    }
    .preferredColorScheme(Self.scheme(appearance))
  }

  /// The top left: "Atrium" and the Mac under it.
  ///
  /// - Remark: design-language "手机端 · 首页 · 顶栏"; see `HostLine`.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The masthead.
  @ViewBuilder
  private func masthead(_ palette: Palette) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(Self.title)
        .font(Typography.brand(size: 38))
        .foregroundStyle(palette.text)
        .accessibilityIdentifier("home.title")
      if let sync {
        HostLine(state: Self.pill(for: sync.status), hostName: sync.hostName)
          .accessibilityIdentifier("home.connection")
      }
    }
    .padding(.top, 10)
    .frame(minHeight: 50, alignment: .leading)
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
  /// - Remark: Before the first list arrives there is nothing to group; the line under the title
  ///   says why. "等你处理" is hidden without notes.
  /// - SideEffects: none
  /// - Parameters:
  ///   - home: What to list.
  ///   - ready: Whether the list has arrived.
  ///   - stale: Whether it is what the Mac last said.
  ///   - palette: The colours.
  /// - Returns: The groups.
  @ViewBuilder
  private func sections(_ home: HomeList, ready: Bool, stale: Bool, palette: Palette) -> some View {
    if ready && home.projects.isEmpty && home.notes.isEmpty {
      EmptyHome(hasChats: !home.chats.isEmpty)
    }
    if !home.notes.isEmpty {
      NoteStrip(home: home, stale: stale)
    }
    ForEach(home.projects) { project in
      ProjectTitle(project: project, folded: folded.contains(project.id)) {
        withAnimation(MotionToken.smooth.resolved(reduceMotion: false).animation) {
          if folded.contains(project.id) { folded.remove(project.id) } else { folded.insert(project.id) }
        }
      }
      if !folded.contains(project.id) {
        ForEach(Array(project.lines.enumerated()), id: \.element.id) { place, line in
          WorktreeRow(line: line, changes: sync?.core.changes[line.id], merged: false, divided: place > 0)
        }
        if project.merged > 0 {
          Button {
            withAnimation(MotionToken.smooth.resolved(reduceMotion: false).animation) {
              if openMerged.contains(project.id) {
                openMerged.remove(project.id)
              } else {
                openMerged.insert(project.id)
              }
            }
          } label: {
            HStack(spacing: 6) {
              Text("另外 \(project.merged) 个已合并").foregroundStyle(palette.secondary)
              Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(
                palette.tint
              )
              .rotationEffect(.degrees(openMerged.contains(project.id) ? 90 : 0))
            }
            .font(.system(size: 12.5))
            .padding(.leading, 26)
            .frame(height: 34)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          if openMerged.contains(project.id) {
            ForEach(project.mergedLines) { line in
              WorktreeRow(line: line, changes: sync?.core.changes[line.id], merged: true, divided: true)
            }
          }
        }
      }
    }
    if !home.chats.isEmpty {
      HStack(spacing: 6) {
        Text("对话").font(.system(size: 19, weight: .semibold, design: .serif)).foregroundStyle(palette.text)
        Spacer()
        NavigationLink(value: NewSessionRoute(container: nil)) {
          NewChatIcon(size: 22).foregroundStyle(palette.tint).frame(width: 34, height: 34)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("新对话")
      }
      .frame(height: 34)
      .padding(.top, 20)
      ForEach(Array((allChats ? home.chats : home.shownChats).enumerated()), id: \.element.id) { place, row in
        ChatRow(row: row, divided: place > 0)
      }
      if !allChats, home.chats.count > home.shownChats.count {
        Button("显示全部 \(home.chats.count) 个") { allChats = true }
          .font(.system(size: 13)).foregroundStyle(palette.tint).frame(minHeight: 34).buttonStyle(.plain)
          .padding(.leading, 26)
      }
    }
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

/// One session's row: the workspace page's list.
///
/// - Remark: The paper rows (design-language "手机端 · 工作区页"): 52pt, the status mark in a 16pt
///   column, the title, and the time at the end; a tap opens the session.
struct SessionRow: View {
  /// What to show.
  let row: HomeList.Row
  /// Whether a hairline goes above it.
  var divided = false
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The row.
  var body: some View {
    let palette = Palette(scheme: scheme)
    NavigationLink(value: row.id) {
      HStack(spacing: 8) {
        StatusIcon(kind: Self.kind(row.status))
        Text(row.title).font(.system(size: 15.5, weight: .medium)).foregroundStyle(palette.text).lineLimit(1)
        Spacer(minLength: 6)
        RowTime(row: row)
      }
      .frame(minHeight: 52)
      .overlay(alignment: .top) { if divided { Rectangle().fill(palette.line).frame(height: 0.5) } }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("home.session.\(row.id)")
  }

  /// The status icon for a row's mark.
  ///
  /// - Remark: No mark is idle: a faint dot.
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

/// A chat's row on the home: 42pt, one line.
///
/// - Remark: design-language "手机端 · 首页 · 对话组".
struct ChatRow: View {
  /// What to show.
  let row: HomeList.Row
  /// Whether a hairline goes above it.
  var divided = false
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The row.
  var body: some View {
    let palette = Palette(scheme: scheme)
    NavigationLink(value: row.id) {
      HStack(spacing: 8) {
        StatusIcon(kind: SessionRow.kind(row.status))
        Text(row.title).font(.system(size: 14.5)).foregroundStyle(palette.text).lineLimit(1)
        Spacer(minLength: 6)
        RowTime(row: row)
      }
      .padding(.leading, 2)
      .frame(height: 42)
      .overlay(alignment: .top) { if divided { Rectangle().fill(palette.line).frame(height: 0.5) } }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("home.session.\(row.id)")
  }
}

/// The time at the end of a row: "进行中" in the tint while it runs, else how long ago it changed.
///
/// - Remark: The prototype shows a run's timer; the list does not carry when a run started, so a
///   running row says "进行中" instead (listed for acceptance).
struct RowTime: View {
  /// The row.
  let row: HomeList.Row
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The time.
  var body: some View {
    let palette = Palette(scheme: scheme)
    if row.status == .running {
      Text("进行中").font(.system(size: 12, weight: .semibold)).foregroundStyle(palette.tint)
    } else {
      TimelineView(.everyMinute) { time in
        Text(HomeList.ago(row.updatedAt, now: Int(time.date.timeIntervalSince1970 * 1000)))
          .font(.system(size: 12)).monospacedDigit().foregroundStyle(palette.secondary)
      }
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
