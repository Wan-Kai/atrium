import AtriumProtocol
import AtriumSync
import SwiftUI

/// Where a new session page starts, for navigation.
///
/// - Remark: The home's `+` (the latest place), a workspace's `+`, the chats' `+`.
struct NewSessionRoute: Hashable {
  /// The workspace, or `nil` for a new chat.
  let container: ContainerId?
}

/// A new session: an empty page that turns into the session's page once its first message is sent.
///
/// - Remark: The final prototype's new session (SPEC-0005 "MP6 定的细节 · MP6d"), in the paper
///   redesign (design-language "手机端 · 新会话"): "×" at the top, "在 <分支> 里要做什么？" (the branch
///   deep beige and mono) or "要聊点什么？", no cat for now; at the bottom the conversation page's
///   two-row input, with the place and the model in its bottom row. Sending makes the session (`create_session` or `create_chat`) and sends
///   the message; the page then becomes that session's page in place. A workspace the Mac cannot
///   find is marked and cannot be sent to.
struct NewSessionPage: View {
  /// Where it starts.
  let route: NewSessionRoute
  /// The connection's sync.
  @Environment(SyncModel.self) private var sync: SyncModel?
  /// Goes back.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// The workspace picked, `nil` for a chat; starts as the route's.
  @State private var container: ContainerId?
  /// The message.
  @State private var text = ""
  /// The session this page made, once it is made.
  @State private var made: SessionId?
  /// Whether this page asked for the start under way.
  @State private var asked = false
  /// Whether this page has asked for a start, so a failure shown is its own.
  @State private var tried = false
  /// Whether the place sheet is open.
  @State private var choosing = false
  /// Whether the input has the keyboard.
  @FocusState private var typing: Bool

  /// Starts at a route.
  ///
  /// - Remark: The place can be changed before sending.
  /// - SideEffects: none
  /// - Parameter route: Where it starts.
  init(route: NewSessionRoute) {
    self.route = route
    _container = State(initialValue: route.container)
  }

  /// The page, or the session's once it is made.
  var body: some View {
    if let made {
      SessionPage(sessionId: made)
    } else {
      draft
        .onChange(of: sync?.core.started) {
          guard asked, let started = sync?.core.started else { return }
          made = started
        }
        .onChange(of: sync?.core.starting) {
          if sync?.core.starting == false, sync?.core.started == nil { asked = false }
        }
    }
  }

  /// The empty page.
  private var draft: some View {
    let palette = Palette(scheme: scheme)
    let workspace = container.flatMap { id in sync?.core.index.workspaces.first { $0.id == id } }
    let missing = container.map { sync?.core.missingContainers.contains($0) ?? false } ?? false
    let place = container.flatMap { id in sync.map { HomeList.place(of: id, in: $0.core.index) } } ?? "新对话"
    let ready =
      sync?.status == .connected && sync?.core.synced == true && !missing && !(sync?.core.starting ?? false)
      && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return VStack(spacing: 0) {
      Spacer()
      VStack(spacing: 14) {
        Group {
          if !missing, container != nil {
            Text("在 ")
              + Text(workspace?.branch ?? workspace?.alias ?? "这个工作区").font(
                .system(size: 19, weight: .medium, design: .monospaced)
              )
              .foregroundColor(palette.tint)
              + Text(" 里要做什么？")
          } else {
            Text(Self.sentence(branch: nil, missing: missing).replacingOccurrences(of: "，", with: "，\n"))
          }
        }
        .font(.system(size: missing ? 18 : 21, weight: .semibold))
        .foregroundStyle(missing ? palette.attn : palette.text)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 320)
        if tried, let failure = sync?.core.startFailure, !missing, !asked {
          Text(failure == .outcomeUnknown ? "没能确认是否新建好，看看首页有没有它" : "没能新建（\(failure.rawValue)）")
            .font(Typography.meta).foregroundStyle(palette.danger)
        }
      }
      Spacer()
      VStack(alignment: .leading, spacing: 0) {
        TextField("写下第一条消息", text: $text, axis: .vertical)
          // Messages name files, branches and commands; autocorrect would rewrite them.
          .autocorrectionDisabled()
          .lineLimit(1...5)
          .font(.system(size: 15.5))
          .focused($typing)
          .padding(.horizontal, 16)
          .padding(.top, 12)
          .padding(.bottom, 8)
          .accessibilityIdentifier("new.input")
        HStack(spacing: 6) {
          Button {
            typing = false
            choosing = true
          } label: {
            HStack(spacing: 5) {
              if missing { Text("!").font(.system(size: 13, weight: .bold)).foregroundStyle(palette.attn) }
              Image(systemName: container == nil ? "bubble.left" : "arrow.triangle.branch").font(.system(size: 11))
              Text(place).lineLimit(1).truncationMode(.middle)
              Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(
                palette.secondary)
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(missing ? palette.attn : palette.text)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(palette.fill, in: Capsule())
            .overlay(Capsule().strokeBorder(missing ? palette.attn : .clear, lineWidth: 1.2))
          }
          .buttonStyle(PressStyle())
          .accessibilityIdentifier("new.place")
          if let sync, sync.core.modelsWorkspace == container, let model = sync.core.models?.defaultModel {
            HStack(spacing: 5) {
              ProviderIcon(providerId: model.providerId, size: 15)
              Text(
                sync.core.models?.models.first { $0.providerId == model.providerId && $0.modelId == model.modelId }?
                  .name
                  ?? model.modelId
              )
              .lineLimit(1)
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(palette.text)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(palette.fill, in: Capsule())
          }
          Spacer(minLength: 4)
          Button {
            asked = true
            tried = true
            sync?.startSession(in: container, text: text)
          } label: {
            Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold))
              .foregroundStyle(ready ? palette.onInk : palette.secondary)
              .frame(width: 36, height: 36)
              .background(ready ? palette.ink : palette.fill, in: Circle())
          }
          .buttonStyle(PressStyle())
          .disabled(!ready)
          .accessibilityLabel("发送")
          .accessibilityIdentifier("new.send")
        }
        .padding(.leading, 8)
        .padding(.trailing, 6)
        .padding(.bottom, 6)
      }
      .atriumGlass(in: RoundedRectangle(cornerRadius: 24))
      .padding(.horizontal, 14)
      .padding(.bottom, Metrics.xs)
    }
    .background(palette.page.ignoresSafeArea())
    .overlay(alignment: .topLeading) {
      // Not while its start is under way: the session it makes would be opened with no page to close it.
      GlassCircleButton(systemImage: "xmark", label: "关闭") { dismiss() }.padding(.leading, Metrics.md)
        .disabled(asked && sync?.core.starting == true)
    }
    .hidingNavigationBar()
    .sheet(isPresented: $choosing) {
      if let sync {
        LocationSheet(sync: sync, picked: container) { picked in
          container = picked
          typing = true
        }
      }
    }
    .task(id: ModelsKey(container: container, synced: sync?.core.synced == true)) {
      sync?.listModels(workspaceId: container, refresh: false)
    }
  }

  /// The page's question.
  ///
  /// - Remark: "在 <分支> 里要做什么？", "要聊点什么？" for a chat, and the warning for a workspace the
  ///   Mac cannot find.
  /// - SideEffects: none
  /// - Parameters:
  ///   - branch: The workspace's branch or name, `nil` for a chat.
  ///   - missing: Whether the Mac cannot find the workspace.
  /// - Returns: The words.
  static func sentence(branch: String?, missing: Bool = false) -> String {
    if missing { return "这个工作区在 Mac 上找不到了，换一个位置" }
    guard let branch else { return "要聊点什么？" }
    return "在 \(branch) 里要做什么？"
  }
}

/// What the draft's model list is for: the place, and whether it can be asked yet.
///
/// - Remark: The list is asked again when the place changes or the sync finishes (the MP6 review).
private struct ModelsKey: Hashable {
  /// The place.
  let container: ContainerId?
  /// Whether synced.
  let synced: Bool
}

/// The sheet that picks where a new session goes.
///
/// - Remark: The prototype's "放在哪里": search, the three latest places, each project's workspaces
///   (merged ones left out, ones the Mac cannot find greyed with "找不到了"), and "新对话"; the
///   note says new worktrees are made on the Mac.
struct LocationSheet: View {
  /// The connection's sync.
  let sync: SyncModel
  /// The place picked now, `nil` for a new chat.
  let picked: ContainerId?
  /// Picks a place.
  let choose: (ContainerId?) -> Void
  /// What the search field holds.
  @State private var query = ""
  /// Closes the sheet.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// One project's workspaces.
  ///
  /// - Remark: In the home's order.
  struct ProjectPlaces: Equatable {
    /// The project.
    let id: ProjectId
    /// The project's name.
    let name: String
    /// Its workspaces that can take a session.
    let workspaces: [Workspace]
  }

  /// The sheet.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let groups = Self.workspaces(in: sync.core.index)
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        Text("放在哪里").font(.system(size: 17, weight: .semibold)).foregroundStyle(palette.text)
          .frame(maxWidth: .infinity).padding(.vertical, Metrics.md)
        HStack {
          Image(systemName: "magnifyingglass").foregroundStyle(palette.secondary)
          TextField("搜索工作区", text: $query)
        }
        .padding(.horizontal, Metrics.sm).frame(height: 38)
        .background(palette.fill, in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, Metrics.md)
        let matching = groups.map { group in
          ProjectPlaces(
            id: group.id, name: group.name,
            workspaces: group.workspaces.filter {
              query.isEmpty || HomeList.place(of: $0.id, in: sync.core.index).localizedCaseInsensitiveContains(query)
            })
        }
        .filter { !$0.workspaces.isEmpty }
        if matching.isEmpty, !query.isEmpty {
          Text("没有匹配的工作区").font(.system(size: 14)).foregroundStyle(palette.secondary).padding(Metrics.lg)
        }
        let recent = HomeList.recentWorkspaces(in: sync.core.index).compactMap { id in
          sync.core.index.workspaces.first { $0.id == id }
        }
        if query.isEmpty, !recent.isEmpty {
          Text("最近").font(.system(size: 13.5)).foregroundStyle(palette.secondary).padding(.horizontal, Metrics.lg)
            .padding(.top, 18).padding(.bottom, 4)
          ForEach(recent, id: \.id) { workspace in
            placeRow(
              HomeList.place(of: workspace.id, in: sync.core.index), icon: "clock", id: workspace.id, palette: palette)
          }
        }
        ForEach(matching, id: \.id) { group in
          Text(group.name).font(Typography.display(for: group.name, size: 18, cjkSize: 15)).foregroundStyle(
            palette.text
          )
          .padding(.horizontal, Metrics.lg).padding(.top, 22).padding(.bottom, 4)
          ForEach(group.workspaces, id: \.id) { workspace in
            placeRow(
              workspace.branch ?? workspace.alias ?? workspace.dir,
              icon: workspace.kind == .local ? "laptopcomputer" : "arrow.triangle.branch",
              id: workspace.id, palette: palette)
          }
        }
        Text("对话").font(.system(size: 13.5)).foregroundStyle(palette.secondary).padding(.horizontal, Metrics.lg)
          .padding(.top, 22).padding(.bottom, 4)
        placeRow("新对话", icon: "bubble.left", id: nil, note: "不绑定项目", palette: palette)
        Text("新建 worktree 要在 Mac 上做。").font(.system(size: 13)).foregroundStyle(palette.secondary)
          .padding(Metrics.lg)
      }
    }
    .background(palette.surface)
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }

  /// One place: its icon, its name, a note, and a check when picked.
  ///
  /// - Remark: A workspace the Mac cannot find is faded and cannot be picked.
  /// - SideEffects: none
  /// - Parameters:
  ///   - name: The name.
  ///   - icon: Its symbol.
  ///   - id: The workspace, or `nil` for a new chat.
  ///   - note: The grey words after it.
  ///   - palette: The colours.
  /// - Returns: The row.
  private func placeRow(_ name: String, icon: String, id: ContainerId?, note: String? = nil, palette: Palette)
    -> some View
  {
    let missing = id.map { sync.core.missingContainers.contains($0) } ?? false
    return Button {
      choose(id)
      dismiss()
    } label: {
      HStack(spacing: Metrics.sm) {
        Image(systemName: icon).font(.system(size: 15)).frame(width: 20)
        Text(name).font(.system(size: 16)).lineLimit(1).truncationMode(.middle)
        if let note { Text(note).font(.system(size: 13)).foregroundStyle(palette.secondary) }
        Spacer()
        if missing {
          Text("找不到了").font(.system(size: 12.5)).foregroundStyle(palette.attnText)
        } else if picked == id {
          Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold))
        }
      }
      .foregroundStyle(palette.text)
      .padding(.horizontal, Metrics.lg)
      .frame(minHeight: 48)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(missing)
    .opacity(missing ? 0.5 : 1)
  }

  /// Each project's workspaces a new session can go in.
  ///
  /// - Remark: Archived and merged ones are left out; the home's order.
  /// - SideEffects: none
  /// - Parameter index: The list.
  /// - Returns: The projects with their workspaces.
  static func workspaces(in index: IndexState) -> [ProjectPlaces] {
    index.projects.map { project in
      ProjectPlaces(
        id: project.id, name: project.name,
        workspaces: index.workspaces.filter {
          $0.projectId == project.id && $0.archivedAt == nil && $0.merge?.verdict != .merged
        })
    }
    .filter { !$0.workspaces.isEmpty }
  }
}

/// The round "+" at the bottom right that opens a new session.
///
/// - Remark: The prototype's 58pt glass "+" (design-language "手机端 · 原则"), on the home and on a
///   workspace's page.
struct NewSessionKey: View {
  /// Where the new session starts.
  let route: NewSessionRoute
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The key.
  var body: some View {
    let palette = Palette(scheme: scheme)
    NavigationLink(value: route) {
      Image(systemName: "plus")
        .font(.system(size: 22, weight: .medium))
        .foregroundStyle(palette.text)
        .frame(width: 58, height: 58)
        .atriumGlass(in: Circle(), interactive: true)
    }
    .buttonStyle(PressStyle())
    .accessibilityLabel("新建会话")
    .accessibilityIdentifier("new.key")
    .padding(.trailing, Metrics.page)
    .padding(.bottom, Metrics.xs)
  }
}
