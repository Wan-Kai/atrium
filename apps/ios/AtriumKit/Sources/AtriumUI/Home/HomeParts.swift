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
      PixelCatView(scene: hasChats ? .peek : .tile, size: hasChats ? 128 : 160)
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
        Text(project?.name ?? "").font(Typography.display(for: project?.name ?? "", size: 16, cjkSize: 14))
          .foregroundStyle(palette.secondary)
        Text(group?.name ?? "").font(.system(size: 22, weight: .semibold, design: .monospaced))
          .foregroundStyle(palette.text).lineLimit(2)
        HStack(spacing: 8) {
          Text(workspace?.kind == .local ? "本地工作区" : "worktree").font(.system(size: 12.5))
            .foregroundStyle(palette.secondary)
          if let tag = WorkspaceHeader.tag(
            dirty: changes?.dirty ?? false, ahead: changes?.ahead ?? 0, merged: group?.merged ?? false)
          {
            Text(tag).font(.system(size: 11, weight: .medium, design: .monospaced))
              .foregroundStyle(group?.merged == true ? palette.ok : palette.attn)
          }
        }
        NavigationLink(value: ChangesRoute(workspaceId: workspaceId)) {
          ChangesCard(changes: changes)
        }
        .buttonStyle(PressStyle(scale: 0.985))
        .padding(.top, 18)
        Text("会话 \(group?.rows.count ?? 0)").font(.system(size: 12.5, weight: .semibold)).monospacedDigit()
          .foregroundStyle(palette.secondary)
          .padding(.top, 26).padding(.bottom, 2)
        if group?.rows.isEmpty ?? true {
          Text("这个工作区还没有会话").font(.system(size: 15)).foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity).padding(.top, Metrics.xl)
          NavigationLink(value: NewSessionRoute(container: workspaceId)) {
            Text("在这里新建会话").font(.system(size: 15, weight: .medium)).foregroundStyle(palette.tint)
          }
          .buttonStyle(.plain)
          .frame(maxWidth: .infinity).frame(minHeight: 42)
        }
        ForEach(Array((group?.rows ?? []).enumerated()), id: \.element.id) { place, row in
          SessionRow(row: row, divided: place > 0)
        }
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

/// The workspace page's changes, as a card into the change list.
///
/// - Remark: design-language "手机端 · 工作区页": a `--note` card with the lines changed in Fraunces
///   italic, "+A −D" and whether anything is uncommitted, and a bar of added against removed. The
///   host sends line counts, not files, so the big number is lines (listed for acceptance).
struct ChangesCard: View {
  /// The workspace's changes, once watched.
  let changes: ChangesUpdatedEvent?
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The card.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let added = changes?.stat?.added ?? 0
    let removed = changes?.stat?.removed ?? 0
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("\(added + removed)").font(Typography.brand(size: 40)).foregroundStyle(palette.text)
        Text("行改动").font(.system(size: 13)).foregroundStyle(palette.secondary)
        Spacer()
        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(palette.tertiary)
      }
      GeometryReader { proxy in
        let total = max(1, added + removed)
        HStack(spacing: 2) {
          Capsule().fill(palette.ok).frame(width: proxy.size.width * CGFloat(added) / CGFloat(total))
          Capsule().fill(palette.danger).frame(width: proxy.size.width * CGFloat(removed) / CGFloat(total))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Capsule().fill(palette.surface))
      }
      .frame(height: 4)
      HStack(spacing: 8) {
        Text("+\(ChangeList.short(added))").foregroundStyle(palette.ok)
        Text("−\(ChangeList.short(removed))").foregroundStyle(palette.danger)
        Text(WorkspacePage.changesLine(dirty: changes?.dirty)).foregroundStyle(palette.secondary)
      }
      .font(.system(size: 12.5, design: .monospaced))
    }
    .padding(16)
    .background(palette.note, in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(palette.line, lineWidth: 0.5))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("改动：\(added + removed) 行，\(WorkspacePage.changesLine(dirty: changes?.dirty))")
  }
}
