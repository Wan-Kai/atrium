import AtriumProtocol
import AtriumSync
import SwiftUI

/// Where the change list of a workspace is, for navigation.
///
/// - Remark: Pushed from a workspace's page or a turn's "改了 N 个文件".
struct ChangesRoute: Hashable {
  /// The workspace.
  let workspaceId: WorkspaceId
}

/// A workspace's changed files.
///
/// - Remark: The final prototype's change list (SPEC-0005 "MP6 定的细节 · MP6a"): the branch and
///   file count on top, a serif count with the lines added and removed and the range ("未提交" /
///   "对比基础分支"), a bar of added against removed, chips by kind, then the files grouped by
///   directory (folding) or, after the sort key, "按改动量排 · 不分组". Rows are 32pt with the file's
///   type icon, its name and its counts. Opening the page watches its diff; leaving it stops.
struct ChangesPage: View {
  /// The workspace.
  let workspaceId: WorkspaceId
  /// The connection's sync.
  @Environment(SyncModel.self) private var sync: SyncModel?
  /// Goes back.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// The clock the toast waits on.
  @Environment(\.atriumClock) private var clock
  /// What the list compares.
  @State private var mode = DiffMode.uncommitted
  /// The chip picked.
  @State private var filter = ChangeList.Filter.all
  /// Whether the list goes by size instead of directory.
  @State private var bySize = false
  /// The directories folded away.
  @State private var folded: Set<String> = []
  /// The file opened, by its place in the order shown.
  @State private var opened: DiffRoute?
  /// The toast showing, if any.
  @State private var toast: String?

  /// The page.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let diff = sync?.core.diff
    let list = ChangeList(diff?.files ?? [])
    let shown =
      bySize ? list.bySize(filter) : list.groups(filter).filter { !folded.contains($0.directory) }.flatMap(\.files)
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        header(list, palette)
        if let diff, diff.error == nil, !diff.tooLarge, !diff.files.isEmpty {
          ratio(list, palette)
          chips(list, palette)
          if bySize {
            ForEach(Array(shown.enumerated()), id: \.element.path) { place, file in
              row(file, showDirectory: true, palette) { opened = DiffRoute(files: shown, place: place) }
            }
          } else {
            ForEach(list.groups(filter)) { group in
              directoryRow(group, palette)
              if !folded.contains(group.directory) {
                ForEach(group.files, id: \.path) { file in
                  row(file, showDirectory: false, palette) {
                    opened = DiffRoute(files: shown, place: shown.firstIndex { $0.path == file.path } ?? 0)
                  }
                }
              }
            }
          }
        } else {
          Text(Self.emptyText(diff))
            .font(.system(size: 15))
            .foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity)
            .padding(.top, 60)
        }
      }
      .padding(.top, Metrics.glassButton + Metrics.lg)
      .padding(.bottom, Metrics.xl)
    }
    .background(palette.page.ignoresSafeArea())
    .overlay(alignment: .top) { topBar(list, palette) }
    .overlay(alignment: .top) {
      if let toast {
        Text(toast).font(.system(size: 13.5)).foregroundStyle(palette.text).padding(.horizontal, Metrics.md)
          .frame(height: 38).atriumGlass(in: Capsule()).padding(.top, 62).transition(.opacity)
      }
    }
    .hidingNavigationBar()
    .navigationDestination(item: $opened) { route in DiffPage(route: route) }
    .onAppear { sync?.watchDiff(DiffTarget(workspaceId: workspaceId, mode: mode)) }
    .onDisappear { if opened == nil { sync?.watchDiff(nil) } }
    .onChange(of: mode) { sync?.watchDiff(DiffTarget(workspaceId: workspaceId, mode: mode)) }
    .task(id: toast) {
      guard toast != nil else { return }
      try? await clock.sleep(for: .seconds(1.9))
      if !Task.isCancelled { toast = nil }
    }
  }

  /// The floating top bar: back, the branch and file count, and the sort key.
  ///
  /// - Remark: The sort key is tinted while sorting by size.
  /// - SideEffects: none
  /// - Parameters:
  ///   - list: The files.
  ///   - palette: The colours.
  /// - Returns: The bar.
  private func topBar(_ list: ChangeList, _ palette: Palette) -> some View {
    ZStack {
      VStack(spacing: 1) {
        Text(branch ?? "改动").font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.text).lineLimit(1)
        Text("\(list.files.count) 个文件").font(.system(size: 11.5)).foregroundStyle(palette.secondary)
      }
      .padding(.horizontal, Metrics.glassButton + Metrics.lg)
      HStack {
        GlassCircleButton(systemImage: "chevron.left", label: "返回") { dismiss() }
        Spacer()
        GlassCircleButton(systemImage: "arrow.up.arrow.down", label: bySize ? "按目录分组" : "按改动量排") {
          bySize.toggle()
          toast = bySize ? "按改动量排 · 不分组" : "按目录分组"
        }
        .foregroundStyle(bySize ? palette.tint : palette.text)
      }
      .padding(.horizontal, Metrics.md)
    }
    .frame(height: 56)
    .background(
      LinearGradient(
        stops: [.init(color: palette.page, location: 0.8), .init(color: palette.page.opacity(0), location: 1)],
        startPoint: .top, endPoint: .bottom
      )
      .padding(.bottom, -Metrics.md)
      .ignoresSafeArea(edges: .top))
  }

  /// The workspace's branch, from the list.
  private var branch: String? {
    sync?.core.index.workspaces.first { $0.id == workspaceId }?.branch
  }

  /// The project and branch, the serif count, the lines and the range.
  ///
  /// - Remark: The prototype's `.cproj` and `.csum`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - list: The files.
  ///   - palette: The colours.
  /// - Returns: The header.
  private func header(_ list: ChangeList, _ palette: Palette) -> some View {
    let workspace = sync?.core.index.workspaces.first { $0.id == workspaceId }
    let project = sync?.core.index.projects.first { $0.id == workspace?.projectId }?.name
    return VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 4) {
        Text("\(project ?? "") · ").font(.system(size: 16, design: .serif)).foregroundStyle(palette.secondary)
        Text(branch ?? "").font(.system(size: 14, design: .monospaced)).foregroundStyle(palette.secondary)
      }
      .lineLimit(1)
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("\(list.files.count)").font(.system(size: 40, design: .serif)).foregroundStyle(palette.text)
        Text("个文件").font(.system(size: 15)).foregroundStyle(palette.text2)
        Text("+\(ChangeList.short(list.added))").foregroundStyle(palette.okText)
        Text("−\(ChangeList.short(list.removed))").foregroundStyle(palette.danger)
        Spacer(minLength: 0)
        Menu {
          Picker("范围", selection: $mode) {
            Text("未提交的改动").tag(DiffMode.uncommitted)
            Text("对比基础分支").tag(DiffMode.base)
          }
        } label: {
          HStack(spacing: 3) {
            Text(mode == .uncommitted ? "未提交" : "对比基础分支")
            Image(systemName: "chevron.down").font(.system(size: 11))
          }
          .font(.system(size: 14.5))
          .foregroundStyle(palette.tint)
        }
      }
      .font(.system(size: 13, design: .monospaced))
    }
    .padding(.horizontal, Metrics.page)
  }

  /// The bar of lines added against lines removed.
  ///
  /// - Remark: 3pt, green then red, a 2pt gap.
  /// - SideEffects: none
  /// - Parameters:
  ///   - list: The files.
  ///   - palette: The colours.
  /// - Returns: The bar.
  private func ratio(_ list: ChangeList, _ palette: Palette) -> some View {
    GeometryReader { proxy in
      let total = max(1, list.added + list.removed)
      let width = proxy.size.width - 2
      HStack(spacing: 2) {
        Capsule().fill(palette.ok).frame(width: width * CGFloat(list.added) / CGFloat(total))
        Capsule().fill(palette.danger)
      }
    }
    .frame(height: 3)
    .padding(.horizontal, Metrics.page)
    .padding(.top, 14)
  }

  /// The chips by kind, with their counts.
  ///
  /// - Remark: Ink when picked; a coloured dot for added, modified and deleted.
  /// - SideEffects: none
  /// - Parameters:
  ///   - list: The files.
  ///   - palette: The colours.
  /// - Returns: The chips.
  private func chips(_ list: ChangeList, _ palette: Palette) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(ChangeList.Filter.allCases, id: \.self) { kind in
          Button {
            filter = kind
          } label: {
            HStack(spacing: 6) {
              if let dot = dot(kind, palette) { Circle().fill(dot).frame(width: 6, height: 6) }
              Text("\(kind.title) \(list.count(kind))").monospacedDigit()
            }
            .font(.system(size: 13.5))
            .foregroundStyle(filter == kind ? palette.onInk : palette.text2)
            .padding(.horizontal, Metrics.sm)
            .frame(height: 32)
            .background(filter == kind ? palette.ink : palette.fill, in: Capsule())
          }
          .buttonStyle(PressStyle())
        }
      }
      .padding(.horizontal, Metrics.page)
    }
    .padding(.top, Metrics.md)
    .padding(.bottom, Metrics.xs)
  }

  /// A chip's dot colour.
  ///
  /// - Remark: None for "全部".
  /// - SideEffects: none
  /// - Parameters:
  ///   - kind: The chip.
  ///   - palette: The colours.
  /// - Returns: The colour.
  private func dot(_ kind: ChangeList.Filter, _ palette: Palette) -> Color? {
    switch kind {
    case .all: nil
    case .added: palette.ok
    case .modified: palette.attn
    case .deleted: palette.danger
    }
  }

  /// A directory's heading, which folds its files.
  ///
  /// - Remark: The prototype's `.dh`: 32pt, monospaced 12pt, a chevron, the count on the right.
  /// - SideEffects: none
  /// - Parameters:
  ///   - group: The directory.
  ///   - palette: The colours.
  /// - Returns: The heading.
  private func directoryRow(_ group: ChangeList.Group, _ palette: Palette) -> some View {
    Button {
      if folded.contains(group.directory) { folded.remove(group.directory) } else { folded.insert(group.directory) }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
          .rotationEffect(.degrees(folded.contains(group.directory) ? -90 : 0))
        Text(group.directory).font(.system(size: 12, weight: .medium, design: .monospaced)).lineLimit(1)
          .truncationMode(.middle)
        Spacer()
        Text("\(group.files.count)").font(.system(size: 11.5)).monospacedDigit()
      }
      .foregroundStyle(palette.secondary)
      .padding(.horizontal, Metrics.page)
      .frame(height: 32)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.top, Metrics.sm)
  }

  /// One file: its icon, name, directory when sorted by size, and its counts.
  ///
  /// - Remark: 32pt, no separator; a deleted file is struck through and grey.
  /// - SideEffects: none
  /// - Parameters:
  ///   - file: The file.
  ///   - showDirectory: Whether to show its directory after its name.
  ///   - palette: The colours.
  ///   - open: Opens its diff.
  /// - Returns: The row.
  private func row(_ file: DiffFile, showDirectory: Bool, _ palette: Palette, open: @escaping () -> Void)
    -> some View
  {
    Button(action: open) {
      HStack(spacing: 10) {
        FileIconView(path: file.path)
        Text(ChangeList.name(file))
          .font(.system(size: 14.5))
          .strikethrough(file.status == .deleted)
          .foregroundStyle(file.status == .deleted ? palette.secondary : palette.text)
          .lineLimit(1)
          .truncationMode(.middle)
        if showDirectory {
          Text(ChangeList.directory(file)).font(.system(size: 12)).foregroundStyle(palette.secondary).lineLimit(1)
            .truncationMode(.head)
        }
        Spacer(minLength: 4)
        Text(file.added > 0 ? "+\(file.added)" : "").foregroundStyle(palette.okText).frame(
          minWidth: 30, alignment: .trailing)
        Text(file.removed > 0 ? "−\(file.removed)" : "").foregroundStyle(palette.danger)
          .frame(minWidth: 30, alignment: .trailing)
      }
      .font(.system(size: 11.5, design: .monospaced))
      .padding(.horizontal, Metrics.page)
      .frame(height: 32)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  /// What the page says when there are no files to list.
  ///
  /// - Remark: SPEC-0005 "MP6 定的细节 · MP6a".
  /// - SideEffects: none
  /// - Parameter diff: The diff, `nil` while it loads.
  /// - Returns: The words.
  static func emptyText(_ diff: DiffUpdatedEvent?) -> String {
    guard let diff else { return "正在读取改动…" }
    switch diff.error {
    case .notGit?: return "这里不是 Git 仓库"
    case .failed?: return "读不出改动"
    case nil: return diff.tooLarge ? "改动太多，在 Mac 上看" : "没有改动"
    }
  }
}
