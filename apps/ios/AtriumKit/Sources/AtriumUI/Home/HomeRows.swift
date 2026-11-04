import AtriumProtocol
import AtriumSync
import SwiftUI

/// The line under "Atrium": how the Mac is.
///
/// - Remark: design-language "手机端 · 首页 · 顶栏": a deep beige dot and the Mac's name when
///   connected; a spinner and "正在同步" while catching up; a spinner, "正在重连" and a deep beige
///   "重试" while reconnecting; an orange dot and the reason when the person must act (the relay
///   cannot be reached, the versions differ), grey when the Mac is offline. "重试" tries now.
struct HostLine: View {
  /// How the phone is connected.
  let state: ConnectionPill.State
  /// The Mac's name.
  let hostName: String
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Tries the connection again now.
  @Environment(\.reconnectNow) private var reconnectNow

  /// The line.
  var body: some View {
    let palette = Palette(scheme: scheme)
    HStack(spacing: 6) {
      switch state {
      case .connected:
        Circle().fill(palette.tint).frame(width: 6, height: 6)
        Text(hostName)
      case .syncing:
        Spinner(size: 11, line: 1.6)
        Text("正在同步")
      case .reconnecting:
        Spinner(size: 11, line: 1.6)
        Text("正在重连 ·")
        retry(palette)
      case .offline:
        Circle().fill(palette.tertiary).frame(width: 6, height: 6)
        Text("\(hostName) · 离线 ·")
        retry(palette)
      case .relayUnreachable:
        Circle().fill(palette.attn).frame(width: 6, height: 6)
        Text("连不上 relay ·").foregroundStyle(palette.attn)
        retry(palette)
      case .versionMismatch:
        Circle().fill(palette.attn).frame(width: 6, height: 6)
        Text("版本不一致，两边都升到最新").foregroundStyle(palette.attn)
      }
    }
    .font(.system(size: 12.5))
    .foregroundStyle(palette.secondary)
    .lineLimit(1)
  }

  /// "重试", when there is a connection to retry.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The button, or nothing.
  @ViewBuilder
  private func retry(_ palette: Palette) -> some View {
    if let reconnectNow {
      Button("重试") { reconnectNow() }
        .buttonStyle(.plain)
        .fontWeight(.semibold)
        .foregroundStyle(palette.tint)
        .accessibilityIdentifier("home.retry")
    }
  }
}

/// A project's title row: the fold chevron, the serif name, and "N 在跑" or "空闲".
///
/// - Remark: design-language "手机端 · 首页 · 项目": 34pt high, 20pt above it.
struct ProjectTitle: View {
  /// The project.
  let project: HomeList.ProjectGroup
  /// Whether it is folded.
  let folded: Bool
  /// What a tap does.
  let toggle: () -> Void
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The row.
  var body: some View {
    let palette = Palette(scheme: scheme)
    Button(action: toggle) {
      HStack(spacing: 6) {
        Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(palette.secondary)
          .frame(width: 16)
          .rotationEffect(.degrees(folded ? -90 : 0))
        Text(project.name)
          .font(Typography.display(for: project.name, size: 19, cjkSize: 17))
          .fontWeight(.semibold)
          .foregroundStyle(palette.text)
          .lineLimit(1)
        Spacer()
        if project.running > 0 {
          Text("\(project.running) 在跑").font(.system(size: 12, weight: .semibold)).foregroundStyle(palette.tint)
        } else {
          Text("空闲").font(.system(size: 12, weight: .medium)).foregroundStyle(palette.secondary)
        }
      }
      .frame(height: 34)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.top, 20)
    .accessibilityAddTraits(.isHeader)
    .accessibilityValue(folded ? "已折叠" : "已展开")
  }
}

/// One worktree's line under its project: two lines, 50pt, into its workspace page.
///
/// - Remark: design-language "手机端 · 首页 · 项目": the status mark of its leading session in a
///   16pt column; the branch (mono 13.5pt) and its tag ("未提交 · ↑3" orange, "已合并" green) on
///   the first line; the leading session's title on the second, with "等 N 个在跑" in the tint for
///   the others running; the time at the end. A hairline above all but the first. Merged ones are
///   faded.
struct WorktreeRow: View {
  /// The line.
  let line: HomeList.WorktreeLine
  /// Its changes, once watched.
  let changes: ChangesUpdatedEvent?
  /// Whether its branch was merged.
  let merged: Bool
  /// Whether a hairline goes above it.
  let divided: Bool
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The row.
  var body: some View {
    let palette = Palette(scheme: scheme)
    NavigationLink(value: WorkspaceRoute(workspaceId: line.id)) {
      HStack(spacing: 8) {
        StatusIcon(kind: SessionRow.kind(line.lead?.status))
        VStack(alignment: .leading, spacing: 3) {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(line.name).font(.system(size: 13.5, weight: .medium, design: .monospaced))
              .foregroundStyle(palette.text).lineLimit(1).truncationMode(.middle)
            if let tag = WorkspaceHeader.tag(dirty: changes?.dirty ?? false, ahead: changes?.ahead ?? 0, merged: merged)
            {
              Text(tag).font(.system(size: 10.5, weight: .medium, design: .monospaced))
                .foregroundStyle(merged ? palette.ok : palette.attn).lineLimit(1).fixedSize()
            }
          }
          Group {
            if let lead = line.lead {
              let also = Text(line.alsoRunning > 0 ? " 等 \(line.alsoRunning) 个在跑" : "").foregroundColor(palette.tint)
              Text("\(Text(lead.title).foregroundColor(palette.secondary))\(also)")
            } else {
              Text("还没有会话").foregroundColor(palette.tertiary)
            }
          }
          .font(.system(size: 13))
          .lineLimit(1)
        }
        Spacer(minLength: 6)
        if let lead = line.lead { RowTime(row: lead) }
      }
      .padding(.leading, 2)
      .frame(height: 50)
      .overlay(alignment: .top) { if divided { Rectangle().fill(palette.line).frame(height: 0.5) } }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .opacity(merged ? 0.55 : 1)
    .accessibilityIdentifier("home.worktree.\(line.id)")
  }
}
