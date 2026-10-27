import AtriumProtocol
import AtriumRemote
import AtriumSync
import SwiftUI

/// Where a workspace's page is, for navigation.
///
/// - Remark: From the home's "还有 N 个" or a workspace's small title.
struct WorkspaceRoute: Hashable {
  /// The workspace.
  let workspaceId: WorkspaceId
}

/// A workspace's small title on the home: its icon, its name, its tag, and a way to its page.
///
/// - Remark: The prototype's `.ws`: 13.5pt, a branch or local icon, the name cut in the middle, a
///   monospaced tag ("未提交 · ↑3", "↑1", "已合并"), and a light chevron; a merged one is faded.
struct WorkspaceHeader: View {
  /// The workspace.
  let workspace: HomeList.WorkspaceGroup
  /// Its changes, once watched.
  let changes: ChangesUpdatedEvent?
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The title.
  var body: some View {
    let palette = Palette(scheme: scheme)
    NavigationLink(value: WorkspaceRoute(workspaceId: workspace.id)) {
      HStack(spacing: 10) {
        Image(systemName: workspace.kind == .local ? "laptopcomputer" : "arrow.triangle.branch")
          .font(.system(size: 13))
          .frame(width: 18)
        Text(workspace.name).lineLimit(1).truncationMode(.middle)
        if let tag = Self.tag(dirty: changes?.dirty ?? false, ahead: changes?.ahead ?? 0, merged: workspace.merged) {
          MonoTag(text: tag, tone: workspace.merged ? .merged : .attention)
        }
        Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(palette.tertiary)
        Spacer(minLength: 0)
      }
      .font(.system(size: 13.5, weight: .medium))
      .foregroundStyle(palette.text2)
      .frame(minHeight: 36)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.top, 10)
    .opacity(workspace.merged ? 0.55 : 1)
  }

  /// A workspace's tag.
  ///
  /// - Remark: "已合并" over everything; else uncommitted and how many commits ahead.
  /// - SideEffects: none
  /// - Parameters:
  ///   - dirty: Whether it has uncommitted changes.
  ///   - ahead: Commits past its base.
  ///   - merged: Whether its branch was merged.
  /// - Returns: The tag, or `nil` for none.
  static func tag(dirty: Bool, ahead: Int, merged: Bool) -> String? {
    if merged { return "已合并" }
    let parts = [dirty ? "未提交" : nil, ahead > 0 ? "↑\(ahead)" : nil].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }
}

/// What the home shows when there is no project.
///
/// - Remark: The prototype's empty states: the cat peeking over a folder when chats exist but no
///   project ("还没有项目"), on its tile when there is nothing at all ("这里还是空的").
struct EmptyHome: View {
  /// Whether there are chats below.
  let hasChats: Bool
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The empty state.
  var body: some View {
    let palette = Palette(scheme: scheme)
    VStack(spacing: Metrics.sm) {
      PixelCatView(scene: hasChats ? .peek : .tile)
        .frame(width: hasChats ? 128 : 160, height: hasChats ? 128 : 160)
      Text(hasChats ? "还没有项目" : "这里还是空的").font(.system(size: 18, weight: .semibold)).foregroundStyle(palette.text)
      Text(
        hasChats
          ? "项目在 Mac 上添加。加好后，这里按项目和工作区列出会话。"
          : "在 Mac 上添加项目，或者点右下角的 + 开一个不绑定项目的对话。"
      )
      .font(.system(size: 14.5))
      .foregroundStyle(palette.secondary)
      .multilineTextAlignment(.center)
      .frame(maxWidth: 280)
      MonoTag(text: "Mac 上的 Atrium › 侧栏 › 项目 +")
    }
    .frame(maxWidth: .infinity)
    .padding(.top, Metrics.xl)
  }
}

/// A workspace's page: where it is, its changes, and all its sessions.
///
/// - Remark: The prototype's workspace page (SPEC-0005 "MP6 定的细节 · MP6b"): the project name, the
///   branch with its icon, "本地工作区" or "worktree" with its tag, the changes row into the change
///   list, then "会话 N"; an empty workspace says "这个工作区还没有会话".
struct WorkspacePage: View {
  /// The workspace.
  let workspaceId: WorkspaceId
  /// The connection's sync.
  @Environment(SyncModel.self) private var sync: SyncModel?
  /// Goes back.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The page.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let group = sync?.home.projects.flatMap(\.workspaces).first { $0.id == workspaceId }
    let workspace = sync?.core.index.workspaces.first { $0.id == workspaceId }
    let project = sync?.core.index.projects.first { $0.id == workspace?.projectId }
    let changes = sync?.core.changes[workspaceId]
    ScrollView {
      VStack(alignment: .leading, spacing: 4) {
        Text(project?.name ?? "").font(Typography.display(for: project?.name ?? "", size: 17, cjkSize: 15))
          .foregroundStyle(palette.secondary)
        HStack(spacing: Metrics.xs) {
          Image(systemName: workspace?.kind == .local ? "laptopcomputer" : "arrow.triangle.branch").font(
            .system(size: 20))
          Text(group?.name ?? "").font(.system(size: 25, weight: .semibold)).lineLimit(2)
        }
        .foregroundStyle(palette.text)
        HStack(spacing: 6) {
          Text(workspace?.kind == .local ? "本地工作区" : "worktree").font(.system(size: 13.5))
            .foregroundStyle(palette.secondary)
          if let tag = WorkspaceHeader.tag(
            dirty: changes?.dirty ?? false, ahead: changes?.ahead ?? 0, merged: group?.merged ?? false)
          {
            MonoTag(text: tag, tone: group?.merged == true ? .merged : .attention)
          }
        }
        NavigationLink(value: ChangesRoute(workspaceId: workspaceId)) {
          HStack(spacing: Metrics.sm) {
            Image(systemName: "plusminus").font(.system(size: 17)).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
              Text("改动").font(.system(size: 16))
              Text(Self.changesLine(dirty: changes?.dirty)).font(.system(size: 13.5))
                .foregroundStyle(palette.secondary)
            }
            Spacer()
            if let stat = changes?.stat {
              Text("+\(ChangeList.short(stat.added))").foregroundStyle(palette.okText)
              Text("−\(ChangeList.short(stat.removed))").foregroundStyle(palette.danger)
            }
            Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(palette.tertiary)
          }
          .font(.system(size: 13, design: .monospaced))
          .foregroundStyle(palette.text)
          .frame(minHeight: 56)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 20)
        Text("会话 \(group?.rows.count ?? 0)").font(.system(size: 14)).monospacedDigit().foregroundStyle(
          palette.secondary
        )
        .padding(.top, 30).padding(.bottom, 6)
        if group?.rows.isEmpty ?? true {
          Text("这个工作区还没有会话").font(.system(size: 15)).foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity).padding(.top, Metrics.xl)
          NavigationLink(value: NewSessionRoute(container: workspaceId)) {
            Text("在这里新建会话").font(.system(size: 15)).foregroundStyle(palette.tint)
          }
          .buttonStyle(.plain)
          .frame(maxWidth: .infinity).frame(minHeight: 42)
        }
        ForEach(group?.rows ?? []) { SessionRow(row: $0) }
      }
      .padding(.horizontal, Metrics.page)
      .padding(.top, Metrics.glassButton + Metrics.lg)
      .padding(.bottom, Metrics.xl)
    }
    .background(palette.page.ignoresSafeArea())
    .overlay(alignment: .topLeading) {
      GlassCircleButton(systemImage: "chevron.left", label: "返回") { dismiss() }.padding(.leading, Metrics.md)
    }
    .overlay(alignment: .bottomTrailing) { NewSessionKey(route: NewSessionRoute(container: workspaceId)) }
    .hidingNavigationBar()
  }
}

extension WorkspacePage {
  /// The changes row's second line.
  ///
  /// - Remark: Before the first `changes_updated` nothing is known, so it does not claim the
  ///   workspace is clean (the MP6 review).
  /// - SideEffects: none
  /// - Parameter dirty: Whether there are uncommitted changes, `nil` before the first answer.
  /// - Returns: The words.
  static func changesLine(dirty: Bool?) -> String {
    switch dirty {
    case nil: "正在读取改动…"
    case true?: "未提交"
    case false?: "没有未提交的改动"
    }
  }
}

/// The drawer the menu key opens: the Mac, this phone, the appearance and about.
///
/// - Remark: The prototype's drawer (SPEC-0005 "MP6 定的细节 · MP6b"): glass, 318pt wide, sliding in
///   from the left over a 16% shade; only the menu key opens it, the shade or "×" closes it. Latency
///   and "上次同步" are left out of the first version. "忘掉这台 Mac" asks first.
struct Drawer: View {
  /// The connection's sync.
  let sync: SyncModel
  /// Closes the drawer.
  let close: () -> Void
  /// The appearance the person chose.
  @AppStorage("appearance") private var appearance = "system"
  /// Whether "忘掉这台 Mac" is being confirmed.
  @State private var forgetting = false
  /// Whether "重新配对" is being confirmed.
  @State private var repairing = false
  /// The relay, this phone and the App's version.
  @Environment(\.pairingDetails) private var details
  /// Forgets the Mac.
  @Environment(\.forgetMac) private var forgetMac
  /// Whether the drawer has slid in.
  @State private var shown = false
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The drawer.
  var body: some View {
    let palette = Palette(scheme: scheme)
    ZStack(alignment: .leading) {
      Color.black.opacity(shown ? 0.16 : 0).ignoresSafeArea().onTapGesture(perform: dismiss)
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          HStack {
            Text("Atrium").font(.system(size: 30, design: .serif)).foregroundStyle(palette.text)
            Spacer()
            GlassCircleButton(systemImage: "xmark", label: "关闭", size: 36, action: dismiss)
          }
          .padding(.top, 60).padding(.horizontal, 18).padding(.leading, 6)
          section("主机", palette)
          HStack(spacing: Metrics.sm) {
            Image(systemName: "laptopcomputer").font(.system(size: 24)).frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
              Text(sync.hostName).font(.system(size: 16.5, weight: .semibold))
              HStack(spacing: 6) {
                Circle().fill(sync.status == .connected ? palette.ok : palette.attn).frame(width: 7, height: 7)
                Text(Self.statusText(sync.status)).font(.system(size: 13)).foregroundStyle(palette.secondary)
              }
            }
          }
          .foregroundStyle(palette.text)
          .padding(.horizontal, 24)
          if let details { row("relay", details.relay, palette) }
          if let details { row("这台手机", details.deviceName, palette) }
          row("加密", "端到端", palette)
          if let expiry = Signing.appExpiry() {
            VStack(alignment: .leading, spacing: 4) {
              MonoTag(
                text: Signing.text(expiry: expiry, now: .now),
                tone: Signing.soon(expiry: expiry, now: .now) ? .attention : .plain)
              Text("到期前在 Mac 上重新安装，否则 App 会打不开。").font(.system(size: 13)).foregroundStyle(palette.secondary)
            }
            .padding(.horizontal, 24).padding(.top, Metrics.xs)
          }
          HStack(spacing: 22) {
            Button("重新配对") { repairing = true }.foregroundStyle(palette.tint)
            Button("忘掉这台 Mac") { forgetting = true }.foregroundStyle(palette.danger)
          }
          .font(.system(size: 14.5, weight: .medium))
          .buttonStyle(.plain)
          .padding(.horizontal, 24).padding(.top, Metrics.md)
          section("外观", palette)
          Picker("外观", selection: $appearance) {
            Text("跟随系统").tag("system")
            Text("浅色").tag("light")
            Text("深色").tag("dark")
          }
          .pickerStyle(.segmented)
          .padding(.horizontal, 24)
          Text("减弱动态效果跟随系统设置。").font(.system(size: 13)).foregroundStyle(palette.secondary)
            .padding(.horizontal, 24).padding(.top, 6)
          section("关于", palette)
          if let details { row("版本", details.appVersion, palette) }
          row("协议", "\(protocolVersion)", palette)
          Text("经你自己的 relay 连回 Mac，中间看不到内容。没有推送：回到 App 时先告诉你谁在等你。")
            .font(.system(size: 13)).foregroundStyle(palette.secondary).padding(.horizontal, 24).padding(.top, 6)
        }
        .padding(.bottom, Metrics.xl)
      }
      .frame(width: 318)
      .atriumGlass(in: RoundedRectangle(cornerRadius: 44))
      .padding(8)
      .offset(x: shown || reduceMotion ? 0 : -340)
      .opacity(shown ? 1 : 0)
    }
    .onAppear {
      withAnimation(
        reduceMotion ? .easeOut(duration: 0.18) : MotionToken.smooth.resolved(reduceMotion: false).animation
      ) {
        shown = true
      }
    }
    .confirmationDialog("忘掉这台 Mac？", isPresented: $forgetting, titleVisibility: .visible) {
      Button("忘掉", role: .destructive) {
        close()
        forgetMac?()
      }
    } message: {
      Text("手机上的密钥、缓存和草稿都会删掉。")
    }
    .confirmationDialog("重新配对？", isPresented: $repairing, titleVisibility: .visible) {
      Button("重新配对", role: .destructive) {
        close()
        forgetMac?()
      }
    } message: {
      Text("会先忘掉这台 Mac，手机上的密钥、缓存和草稿都会删掉，然后扫 Mac 上新的配对码。")
    }
  }

  /// Slides the drawer out, then closes it.
  ///
  /// - Remark: The shade fades with it.
  /// - SideEffects: Animates; closes the drawer.
  private func dismiss() {
    withAnimation(reduceMotion ? .easeOut(duration: 0.18) : MotionToken.smooth.resolved(reduceMotion: false).animation)
    {
      shown = false
    } completion: {
      close()
    }
  }

  /// A section's small title.
  ///
  /// - Remark: The prototype's `.sl`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The title.
  ///   - palette: The colours.
  /// - Returns: The title.
  private func section(_ text: String, _ palette: Palette) -> some View {
    Text(text).font(.system(size: 13.5)).foregroundStyle(palette.secondary).padding(.horizontal, 24)
      .padding(.top, 22).padding(.bottom, 6)
  }

  /// A key and its value.
  ///
  /// - Remark: The prototype's `.kv`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - key: The key.
  ///   - value: The value.
  ///   - palette: The colours.
  /// - Returns: The row.
  private func row(_ key: String, _ value: String, _ palette: Palette) -> some View {
    HStack {
      Text(key).foregroundStyle(palette.text)
      Spacer()
      Text(value).foregroundStyle(palette.text2)
    }
    .font(.system(size: 14.5))
    .padding(.horizontal, 24)
    .padding(.vertical, 7)
  }

  /// The host's status in the drawer's words.
  ///
  /// - Remark: The prototype's lines, without the latency.
  /// - SideEffects: none
  /// - Parameter status: The status.
  /// - Returns: The words.
  static func statusText(_ status: ConnectionStatus) -> String {
    switch HomeView.pill(for: status) {
    case .connected: "已连接"
    case .syncing: "正在同步…"
    case .reconnecting: "正在重连"
    case .offline: "离线"
    case .relayUnreachable: "连不上 relay"
    case .versionMismatch: "版本不一致"
    }
  }
}
