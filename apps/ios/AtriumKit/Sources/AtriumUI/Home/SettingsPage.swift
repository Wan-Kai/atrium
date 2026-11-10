import AtriumProtocol
import AtriumSync
import SwiftUI

/// Where the settings page is, for navigation.
///
/// - Remark: Pushed from the "⋯" key of the home (`from` is `nil`) or of a conversation (its id),
///   so it comes in from the right and swipes back like any page.
struct SettingsRoute: Hashable {
  /// The conversation it was opened from, whose worktree's conversations it lists first.
  let from: SessionId?
}

/// The settings page: this worktree's conversations, the Mac, this phone, and forgetting the Mac.
///
/// - Remark: design-language "手机端 · 设置页" (SPEC-0005 "界面" 2026-10-28; prototype
///   `mobile-settings-prototype.html`): full screen, one row a thing, the name on the left and the
///   value on the right, no cards or fills. Replaces the drawer; "重新配对" did the same as
///   "忘掉这台 Mac" and is gone. Latency and "上次同步" are not shown.
struct SettingsPage: View {
  /// Where it was opened from.
  let route: SettingsRoute
  /// The connection's sync.
  @Environment(SyncModel.self) private var sync: SyncModel?
  /// The relay, this phone and the App's version.
  @Environment(\.pairingDetails) private var details
  /// Forgets the Mac.
  @Environment(\.forgetMac) private var forgetMac
  /// Tries the connection again now.
  @Environment(\.reconnectNow) private var reconnectNow
  /// Opens another conversation in place of the one settings was opened from.
  @Environment(\.switchConversation) private var switchConversation
  /// Goes back.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// The appearance the person chose.
  @AppStorage("appearance") private var appearance = "system"
  /// Whether "忘掉这台 Mac" is being confirmed.
  @State private var forgetting = false

  /// The page.
  var body: some View {
    let palette = Palette(scheme: scheme)
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if let from = route.from, let sync {
          conversations(from: from, sync: sync, palette: palette)
        }
        if let sync { mac(sync, palette) }
        phone(palette)
        forget(palette)
        Text("Atrium \(details?.appVersion ?? "") · 协议 \(protocolVersion)")
          .font(.system(size: 11.5)).monospacedDigit()
          .foregroundStyle(scheme == .dark ? palette.secondary : palette.tertiary)
          .frame(maxWidth: .infinity)
          .padding(.top, 30)
      }
      .padding(.horizontal, 22)
      .padding(.top, 64)
      .padding(.bottom, 60)
    }
    .background(palette.page.ignoresSafeArea())
    .overlay(alignment: .top) { topBar(palette) }
    .hidingNavigationBar()
    .alert("忘掉这台 Mac？", isPresented: $forgetting) {
      Button("取消", role: .cancel) {}
      Button("忘掉", role: .destructive) {
        dismiss()
        forgetMac?()
      }
    } message: {
      Text("手机上的密钥、缓存和草稿都会删掉，之后要重新扫码配对。")
    }
  }

  /// The back key and the centred title, over a fading top edge.
  ///
  /// - Remark: As the conversation page's top bar.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The bar.
  private func topBar(_ palette: Palette) -> some View {
    ZStack {
      Text("设置").font(.system(size: 16, weight: .semibold)).foregroundStyle(palette.text)
      HStack {
        GlassCircleButton(systemImage: "chevron.left", label: "返回") { dismiss() }
        Spacer()
      }
      .padding(.horizontal, Metrics.md)
    }
    .frame(height: 44)
    .padding(.bottom, 14)
    .background {
      LinearGradient(
        colors: [palette.page, palette.page.opacity(0)], startPoint: UnitPoint(x: 0.5, y: 0.6), endPoint: .bottom
      )
      .ignoresSafeArea(edges: .top)
    }
  }

  /// A group's small title.
  ///
  /// - Remark: 12.5pt semibold grey, with an optional lighter note after it.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The title.
  ///   - note: What follows it, if anything.
  ///   - mono: Whether the note is mono (a branch).
  ///   - first: Whether it is the page's first group.
  ///   - palette: The colours.
  /// - Returns: The title.
  private func groupTitle(
    _ text: String, note: String? = nil, mono: Bool = false, first: Bool = false, palette: Palette
  ) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(text).fontWeight(.semibold)
      if let note { Text(note).font(mono ? .system(size: 11.5, design: .monospaced) : .system(size: 12.5)) }
    }
    .font(.system(size: 12.5))
    .foregroundStyle(palette.secondary)
    .padding(.top, first ? 0 : 28)
    .padding(.bottom, 2)
    .accessibilityAddTraits(.isHeader)
  }

  /// The conversations of the worktree settings was opened from, and "新对话".
  ///
  /// - Remark: Its own conversations, not their children; a tap switches to one without leaving the
  ///   worktree; the current one says "当前".
  /// - SideEffects: none
  /// - Parameters:
  ///   - from: The conversation open now.
  ///   - sync: The connection's sync.
  ///   - palette: The colours.
  /// - Returns: The group.
  @ViewBuilder
  private func conversations(from: SessionId, sync: SyncModel, palette: Palette) -> some View {
    let siblings = HomeList.siblings(of: from, in: sync.core.index)
    let current = sync.core.index.sessions.first { $0.sessionId == from }
    let parent = current?.parent?.sessionId ?? from
    let workspace = sync.core.index.workspaces.first { $0.id == current?.containerId }
    groupTitle("对话", note: workspace?.branch, mono: true, first: true, palette: palette)
    if let chat = sync.core.index.chats.first(where: { $0.id == current?.containerId }) {
      pinRow(chat, sync: sync, palette: palette)
    }
    ForEach(siblings, id: \.sessionId) { session in
      Button {
        if session.sessionId != parent { switchConversation?(session.sessionId) }
      } label: {
        SiblingRow(session: session, current: session.sessionId == parent)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("settings.conversation.\(session.sessionId)")
    }
    NavigationLink(value: NewSessionRoute(container: workspace?.id)) {
      HStack(spacing: 6) {
        NewChatIcon(size: 18)
        Text("新对话").fontWeight(.medium)
      }
      .font(.system(size: 15.5))
      .foregroundStyle(palette.tint)
      .frame(maxWidth: .infinity, minHeight: 48)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("settings.new")
  }

  /// Pins the chat the conversation lives in, or unpins it: the first row of "对话".
  ///
  /// - Remark: SPEC-0005 "对话的置顶与顺序" (2026-11-04, when the redesign met pinning): the
  ///   conversation page's "⋯" opens this page instead of a menu, so pinning moved here. Only for a
  ///   chat, as pinning is a chat's; the row says which way it will go, and the home's list moves.
  /// - SideEffects: Sends `pin_chat` or `unpin_chat` when tapped.
  /// - Parameters:
  ///   - chat: The chat.
  ///   - sync: The connection's sync.
  ///   - palette: The colours.
  /// - Returns: The row.
  private func pinRow(_ chat: Chat, sync: SyncModel, palette: Palette) -> some View {
    let pinned = chat.pinnedAt != nil
    return Button {
      sync.setChatPinned(chat.id, !pinned)
    } label: {
      HStack(spacing: 10) {
        Image(systemName: pinned ? "pin.slash" : "pin").font(.system(size: 15)).frame(width: 20)
        Text(Self.pinLabel(pinned: pinned)).fontWeight(.medium)
        Spacer()
      }
      .font(.system(size: 15.5))
      .foregroundStyle(palette.tint)
      .frame(minHeight: 48)
      .overlay(alignment: .bottom) { Rectangle().fill(palette.line).frame(height: 0.5) }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("settings.pin")
  }

  /// What the pinning row says: which way a tap will go.
  ///
  /// - Remark: The same words as the desktop's "···" item, from the chat's side.
  /// - SideEffects: none
  /// - Parameter pinned: Whether the chat is pinned now.
  /// - Returns: The label.
  static func pinLabel(pinned: Bool) -> String {
    pinned ? "取消置顶" : "置顶这个对话"
  }

  /// The Mac: its name and how it is, and one line on the relay and the encryption.
  ///
  /// - Remark: When the person must act (the relay cannot be reached, the Mac is offline) the line
  ///   says why and offers "重试"; versions that differ cannot be retried.
  /// - SideEffects: none
  /// - Parameters:
  ///   - sync: The connection's sync.
  ///   - palette: The colours.
  /// - Returns: The group.
  @ViewBuilder
  private func mac(_ sync: SyncModel, _ palette: Palette) -> some View {
    let state = HomeView.pill(for: sync.status)
    groupTitle("Mac", first: route.from == nil, palette: palette)
    HStack(spacing: 10) {
      Image(systemName: "laptopcomputer").font(.system(size: 15)).foregroundStyle(palette.secondary).frame(width: 20)
      Text(sync.hostName).lineLimit(1)
      Spacer()
      macStatus(state, palette)
    }
    .font(.system(size: 15.5))
    .foregroundStyle(palette.text)
    .frame(minHeight: 48)
    Group {
      switch state {
      case .relayUnreachable:
        let relay = Text("\(details?.relay ?? "relay") ").font(.system(size: 11.5, design: .monospaced))
        Text("\(relay)连不上：手机没网，或 relay 没开")
      case .offline:
        Text("Mac 没有应答：可能睡着了，或 Atrium 没开")
      case .versionMismatch:
        Text("手机和 Mac 上的 Atrium 版本不一致，两边都升到最新")
      default:
        let relay = Text(details?.relay ?? "relay").font(.system(size: 11.5, design: .monospaced))
        Text("经 \(relay) · \(Image(systemName: "lock")) 端到端加密，relay 看不到内容")
      }
    }
    .font(.system(size: 12.5))
    .foregroundStyle(palette.secondary)
    .lineSpacing(2)
    if state == .relayUnreachable || state == .offline || state == .reconnecting, let reconnectNow {
      Button("重试") { reconnectNow() }
        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(palette.tint).buttonStyle(.plain)
        .padding(.top, 2)
        .accessibilityIdentifier("settings.retry")
    }
  }

  /// The Mac row's status on the right.
  ///
  /// - Remark: See `mac(_:_:)`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - state: How the phone is connected.
  ///   - palette: The colours.
  /// - Returns: The status.
  @ViewBuilder
  private func macStatus(_ state: ConnectionPill.State, _ palette: Palette) -> some View {
    HStack(spacing: 6) {
      switch state {
      case .connected:
        Circle().fill(palette.tint).frame(width: 7, height: 7)
        Text("已连接").foregroundStyle(palette.tint).fontWeight(.medium)
      case .syncing:
        Spinner(size: 12, line: 1.8)
        Text("正在同步").foregroundStyle(palette.secondary)
      case .reconnecting:
        Spinner(size: 12, line: 1.8)
        Text("正在重连").foregroundStyle(palette.secondary)
      case .offline:
        Circle().fill(palette.tertiary).frame(width: 7, height: 7)
        Text("离线").foregroundStyle(palette.secondary)
      case .relayUnreachable:
        Circle().fill(palette.attn).frame(width: 7, height: 7)
        Text("连不上 relay").foregroundStyle(palette.attn).fontWeight(.semibold)
      case .versionMismatch:
        Circle().fill(palette.attn).frame(width: 7, height: 7)
        Text("版本不一致").foregroundStyle(palette.attn).fontWeight(.semibold)
      }
    }
    .font(.system(size: 15))
  }

  /// This phone: its signature and the appearance.
  ///
  /// - Remark: The signature row only where the App carries a profile (not the simulator); a day or
  ///   less left turns it orange with a line on how to reinstall. Appearance is one key going round.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The group.
  @ViewBuilder
  private func phone(_ palette: Palette) -> some View {
    groupTitle("这台手机", note: details?.deviceName, palette: palette)
    if let expiry = Signing.appExpiry() {
      let soon = Signing.soon(expiry: expiry, now: .now)
      HStack {
        Text("签名")
        Spacer()
        Text(Signing.value(expiry: expiry, now: .now)).monospacedDigit()
          .foregroundStyle(soon ? palette.attn : palette.secondary)
          .fontWeight(soon ? .semibold : .regular)
      }
      .font(.system(size: 15.5))
      .foregroundStyle(palette.text)
      .frame(minHeight: soon ? 40 : 48)
      if soon {
        Text("到期后 App 打不开，在 Mac 上跑 pnpm ios:install 重装，配对会留着。")
          .font(.system(size: 12.5)).foregroundStyle(palette.secondary).padding(.bottom, 12)
      }
      Rectangle().fill(palette.line).frame(height: 0.5)
    }
    HStack {
      Text("外观")
      Spacer()
      Button {
        appearance = Self.next(appearance)
      } label: {
        HStack(spacing: 6) {
          Image(systemName: Self.symbol(appearance)).font(.system(size: 13))
          Text(Self.label(appearance)).fontWeight(.medium)
        }
        .font(.system(size: 14))
        .foregroundStyle(palette.text)
        .padding(.leading, 10)
        .padding(.trailing, 12)
        .frame(height: 32)
        .background(palette.surface, in: Capsule())
      }
      .buttonStyle(PressStyle())
      .accessibilityLabel("外观：\(Self.label(appearance))")
      .accessibilityHint("轻点换成\(Self.label(Self.next(appearance)))")
      .accessibilityIdentifier("settings.appearance")
    }
    .font(.system(size: 15.5))
    .foregroundStyle(palette.text)
    .frame(minHeight: 48)
  }

  /// "忘掉这台 Mac" and what it does.
  ///
  /// - Remark: Asks first with the system's alert.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The group.
  @ViewBuilder
  private func forget(_ palette: Palette) -> some View {
    Button("忘掉这台 Mac") { forgetting = true }
      .font(.system(size: 15.5, weight: .medium))
      .foregroundStyle(palette.danger)
      .buttonStyle(.plain)
      .frame(minHeight: 48, alignment: .leading)
      .padding(.top, 28)
      .disabled(forgetMac == nil)
      .accessibilityIdentifier("settings.forget")
    Text("删掉这台手机上的密钥、缓存和草稿，回到扫码配对。")
      .font(.system(size: 12.5)).foregroundStyle(palette.secondary)
  }

  /// The appearance after this one: system, light, dark, then system again.
  ///
  /// - Remark: design-language "手机端 · 设置页": one key going round.
  /// - SideEffects: none
  /// - Parameter appearance: "system", "light" or "dark".
  /// - Returns: The next one.
  static func next(_ appearance: String) -> String {
    switch appearance {
    case "light": "dark"
    case "dark": "system"
    default: "light"
    }
  }

  /// The words on the appearance key.
  ///
  /// - Remark: See `next(_:)`.
  /// - SideEffects: none
  /// - Parameter appearance: "system", "light" or "dark".
  /// - Returns: The words.
  static func label(_ appearance: String) -> String {
    switch appearance {
    case "light": "浅色"
    case "dark": "深色"
    default: "跟随系统"
    }
  }

  /// The symbol on the appearance key.
  ///
  /// - Remark: A half-filled circle for the system, a sun, a moon.
  /// - SideEffects: none
  /// - Parameter appearance: "system", "light" or "dark".
  /// - Returns: The SF Symbol's name.
  static func symbol(_ appearance: String) -> String {
    switch appearance {
    case "light": "sun.max"
    case "dark": "moon"
    default: "circle.lefthalf.filled"
    }
  }
}

/// One of the worktree's conversations on the settings page.
///
/// - Remark: 52pt: the home's status mark, the title, under it how it is ("进行中", "等你回答" in
///   orange, "出错" in red, else "完成"), and at the end the time or "当前" in the tint.
struct SiblingRow: View {
  /// The conversation.
  let session: SessionSummary
  /// Whether it is the one open now.
  let current: Bool
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The row.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let failed = session.attention.map { !($0.reason == .error && $0.cleared) } ?? false
    let kind: StatusIcon.Kind =
      session.asking != nil ? .asking : failed ? .error : session.running ? .running : .idle
    HStack(spacing: 10) {
      StatusIcon(kind: kind, size: 20)
      VStack(alignment: .leading, spacing: 1) {
        Text(HomeList.title(of: session)).font(.system(size: 15.5, weight: current ? .semibold : .medium))
          .foregroundStyle(palette.text).lineLimit(1)
        switch kind {
        case .asking: Text("等你回答").foregroundStyle(palette.attn).fontWeight(.medium)
        case .error: Text("出错").foregroundStyle(palette.danger)
        case .running: Text("进行中").foregroundStyle(palette.secondary)
        default: Text("完成").foregroundStyle(palette.secondary)
        }
      }
      .font(.system(size: 12))
      Spacer(minLength: 6)
      if current {
        Text("当前").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(palette.tint)
      } else {
        TimelineView(.everyMinute) { time in
          Text(HomeList.ago(session.updatedAt, now: Int(time.date.timeIntervalSince1970 * 1000)))
            .font(.system(size: 12.5)).monospacedDigit().foregroundStyle(palette.secondary)
        }
      }
    }
    .frame(minHeight: 52)
    .overlay(alignment: .bottom) { Rectangle().fill(palette.line).frame(height: 0.5) }
    .contentShape(Rectangle())
  }
}
