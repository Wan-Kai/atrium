import AtriumProtocol
import AtriumSync
import SwiftUI

/// One session: its turns as they come, and the input that sends to it.
///
/// - Remark: SPEC-0005 "MP5 定的细节 · MP5a": each turn is a ``TurnView`` (your bubble, the process
///   rail, the Markdown reply, what it changed); notices are one grey line. A floating top bar holds
///   the back button, the title and "项目 · 分支". Opening the page opens the session on the Mac and
///   subscribes to it; leaving closes it. At the bottom the ``SessionDock`` sends with a receipt
///   (MP4b), queues, steers and stops (MP5b): unsettled messages show as bubbles marked "发送中" or
///   "没能确认是否送到 · 重发". Showing the page clears its error (`clear_attention`), and again
///   when the app comes back to the foreground. Short notes ("已停止", a failed action) show as a
///   toast for 1.9 s.
struct SessionPage: View {
  /// The session.
  let sessionId: SessionId
  /// The connection's sync.
  @Environment(SyncModel.self) private var sync: SyncModel?
  /// Goes back to the home.
  @Environment(\.dismiss) private var dismiss
  /// Opens the settings page.
  @Environment(\.openSettings) private var openSettings
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether the app is in front.
  @Environment(\.scenePhase) private var phase
  /// The clock toasts and presentation wait on.
  @Environment(\.atriumClock) private var clock
  /// The sheet showing, if any.
  @State private var sheet: PageSheet?
  /// The questions and dialogs already shown by themselves, so closing one does not bring it back.
  @State private var presented: Set<String> = []
  /// The child conversation opened from the child list.
  @State private var openChild: SessionId?
  /// The change list pushed over this page, if any.
  @State private var openChanges: ChangesRoute?
  /// The toast showing, if any.
  @State private var toast: String?
  /// Where the conversation is scrolled to; moved only to keep the reading place when older turns come.
  @State private var position = ScrollPosition(idType: String.self)
  /// Whether the "older turns" row is on screen, so reaching the top fetches them.
  @State private var olderVisible = false
  /// Where the first turn sits, to keep it in place when older turns are put in front of it.
  @State private var place = PlaceKeeper()
  /// Whether an item is held in place after older turns came; the bottom anchor then stays out.
  @State private var holding = false

  /// One item of the conversation: a turn, or a notice line.
  ///
  /// - Remark: Each reports its top, so the first can be kept in place (see `keepPlace`).
  /// - SideEffects: none
  /// - Parameters:
  ///   - item: The item.
  ///   - lastTurn: The latest turn's id.
  ///   - changes: Where the change list opens from.
  ///   - palette: The colours.
  /// - Returns: The row.
  @ViewBuilder
  private func row(_ item: TranscriptItem, lastTurn: String?, changes: ChangesRoute?, palette: Palette) -> some View {
    switch item {
    case .turn(let turn):
      TurnItem(
        turn: turn, latest: turn.id == lastTurn, changes: changes, retry: { retry() },
        openChanges: { openChanges = $0 }
      )
      .equatable()
      .id(turn.id)
      .onGeometryChange(
        for: CGFloat.self, of: { $0.frame(in: .scrollView).minY }, action: { keepPlace(item.id, top: $0) })
    case .notice(let notice):
      Text(Self.label(notice)).font(Typography.meta).foregroundStyle(palette.tertiary)
        .onGeometryChange(
          for: CGFloat.self, of: { $0.frame(in: .scrollView).minY }, action: { keepPlace(item.id, top: $0) })
    }
  }

  /// Keeps the first item in place when older turns come in front of it.
  ///
  /// - Remark: See ``PlaceKeeper``.
  /// - SideEffects: May scroll.
  /// - Parameters:
  ///   - id: The item measured.
  ///   - top: Its top in the scroll view.
  private func keepPlace(_ id: String, top: CGFloat) {
    let items = sync?.core.sessions[sessionId]?.items ?? []
    let target = place.moved(id, top: top, items: items)
    if holding != place.holding { holding = place.holding }
    if let target { position.scrollTo(point: target) }
  }

  /// The page.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let state = sync?.core.sessions[sessionId]
    let controls = SessionControls(
      control: state?.control, running: state?.running ?? false, connected: sync?.status == .connected)
    let lastTurn = state?.items.last { if case .turn = $0 { true } else { false } }?.id
    let changes = changesRoute
    ScrollView {
      // The lines above the turns are outside the lazy stack, so they are always measured: an
      // estimated height there would move the turns while older ones are held in place.
      VStack(alignment: .leading, spacing: Metrics.md) {
        if sync?.core.stale == true {
          Text("不是最新").font(Typography.meta).foregroundStyle(palette.tertiary)
        }
        if state?.hasOlder == true {
          // Fetches when it comes on screen, or on connecting while it is (see `OlderWant`).
          OlderRow(loading: sync?.core.loadingOlder.contains(sessionId) == true)
            .onScrollVisibilityChange(threshold: 0.01) { olderVisible = $0 }
        }
        LazyVStack(alignment: .leading, spacing: Metrics.md) {
          let layout = OlderLayout(items: state?.items ?? [], batches: state?.olderBatches ?? [])
          // Each fetched batch is laid out whole: it comes in at the top, on screen, so its height is
          // exact at once and the place can be kept (see `PlaceKeeper`).
          ForEach(layout.blocks, id: \.first?.id) { block in
            VStack(alignment: .leading, spacing: Metrics.md) {
              ForEach(block, id: \.id) { item in row(item, lastTurn: lastTurn, changes: changes, palette: palette) }
            }
          }
          ForEach(layout.rest, id: \.id) { item in row(item, lastTurn: lastTurn, changes: changes, palette: palette) }
          ForEach(sync?.core.outbox.filter { $0.sessionId == sessionId } ?? []) { message in
            PendingBubble(message: message) { sync?.resend(message.id) }
          }
          if let question = state?.control?.question, sheet == nil {
            QuestionCard(question: question) { sheet = .question(question) }
          }
          if let failure = controls.failure {
            ErrorCard(text: failure, detail: nil) { retry() }
          }
          if state?.control?.compacting == true {
            Text("正在压缩上下文…").font(Typography.meta).foregroundStyle(palette.secondary)
          }
          if controls.restarting {
            Text("正在重启 pi").font(Typography.meta).foregroundStyle(palette.secondary)
          }
          if let line = Self.statusLine(state?.status) {
            Text(line)
              .font(Typography.meta)
              .foregroundStyle(palette.secondary)
              .accessibilityIdentifier("session.status")
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, Metrics.page)
      .padding(.top, Metrics.glassButton + Metrics.lg)
      .padding(.bottom, Metrics.xl)
    }
    .scrollPosition($position)
    // Leading, not centre: content briefly wider than the screen while it lays out must not move it
    // sideways. While older turns are held in place, growth is not anchored to the bottom, or the two
    // would pull against each other.
    .defaultScrollAnchor(.bottomLeading, for: .initialOffset)
    .defaultScrollAnchor(holding ? nil : .bottomLeading, for: .sizeChanges)
    .onScrollPhaseChange { _, phase in
      // A finger on the screen; turns that come while a fling slows down are still held in place.
      place.userScrolling = phase == .tracking || phase == .interacting
      if holding != place.holding { holding = place.holding }
    }
    .onScrollGeometryChange(
      for: CGPoint.self,
      of: { geometry in
        // A scroll position's point leaves the insets out; the content offset counts them.
        CGPoint(
          x: geometry.contentOffset.x + geometry.contentInsets.leading,
          y: geometry.contentOffset.y + geometry.contentInsets.top)
      }
    ) { _, offset in place.offset = offset }
    .onChange(
      of: OlderWant(
        visible: olderVisible, connected: sync?.status == .connected, settled: state?.settled == true,
        epoch: state?.epoch)
    ) { _, want in
      if want.fetches { sync?.loadOlder(sessionId) }
    }
    .background(palette.page.ignoresSafeArea())
    .overlay(alignment: .top) { topBar(palette) }
    .hidingNavigationBar()
    .safeAreaInset(edge: .bottom) {
      if let sync {
        let children = HomeList.children(of: sessionId, in: sync.core.index)
        SessionDock(
          sessionId: sessionId, sync: sync, showQueue: { sheet = .queue },
          showChildren: { sheet = .children(children) }, children: children.count,
          showModel: { sheet = .model }, toast: { toast = $0 }
        )
        .background(alignment: .bottom) {
          GlassEdge(edge: .bottom).frame(height: 190).ignoresSafeArea(edges: .bottom).offset(y: 34)
        }
      }
    }
    .overlay(alignment: .top) { toastView(palette) }
    .sheet(item: Binding(get: { sheet?.isPanel == false ? sheet : nil }, set: { sheet = $0 })) { shown in
      if let sync {
        switch shown {
        case .question(let question): QuestionSheet(sessionId: sessionId, sync: sync, question: question)
        case .interaction(let interaction): InteractionSheet(sessionId: sessionId, sync: sync, interaction: interaction)
        case .model: ModelSheet(sessionId: sessionId, sync: sync)
        case .queue, .children: EmptyView()
        }
      }
    }
    // The queue and the children span the full width, which an iOS 26 sheet below large does not.
    .bottomPanel(item: Binding(get: { sheet?.isPanel == true ? sheet : nil }, set: { sheet = $0 })) { shown in
      if let sync {
        switch shown {
        case .queue: QueueSheet(sessionId: sessionId, sync: sync)
        case .children(let children): ChildrenSheet(children: children) { openChild = $0 }
        default: EmptyView()
        }
      }
    }
    .navigationDestination(item: $openChild) { SessionPage(sessionId: $0) }
    .navigationDestination(item: $openChanges) { ChangesPage(workspaceId: $0.workspaceId) }
    .task(id: PresentKey(waiting: Self.waiting(state?.control), free: sheet == nil, synced: sync?.core.synced == true))
    {
      // After the push has settled, so the sheet is not dropped by the transition.
      try? await clock.sleep(for: .seconds(0.45))
      guard !Task.isCancelled,
        let next = Self.nextToPresent(
          sync?.core.sessions[sessionId]?.control, presented: presented, synced: sync?.core.synced == true),
        sheet == nil
      else { return }
      sheet = next
      presented.insert(Self.waitingId(next))
    }
    .onAppear {
      sync?.open(sessionId)
      sync?.clearAttention(sessionId)
    }
    .onDisappear { if Self.closes(child: openChild, changes: openChanges) { sync?.close(sessionId) } }
    .onChange(of: sync?.core.index.sessions.first { $0.sessionId == sessionId }?.attention) {
      sync?.clearAttention(sessionId)
    }
    .onChange(of: phase) { if phase == .active { sync?.clearAttention(sessionId) } }
    .onChange(of: sync?.status) { sync?.clearAttention(sessionId) }
    .onChange(of: sync?.core.actionProblems[sessionId]) {
      guard let problem = sync?.core.actionProblems[sessionId] else { return }
      toast = SessionControls.problemText(problem)
      sync?.dismissActionProblem(in: sessionId)
    }
    .task(id: toast) {
      guard toast != nil else { return }
      try? await clock.sleep(for: .seconds(1.9))
      if !Task.isCancelled { toast = nil }
    }
  }

  /// What changes whether something should open by itself.
  ///
  /// - Remark: The page waits for it to settle, then decides.
  private struct PresentKey: Equatable {
    let waiting: [String]
    let free: Bool
    let synced: Bool
  }

  /// The question or dialog to open by itself, if any.
  ///
  /// - Remark: SPEC-0005 "MP5 定的细节 · MP5c": the question first, then the oldest dialog, each the
  ///   first time it waits; closed, it stays closed (the question leaves a card). Not before the
  ///   connection's sync: a cached copy may hold one already answered, whose answer would be lost.
  /// - SideEffects: none
  /// - Parameters:
  ///   - control: The session's run control.
  ///   - presented: The ids already opened by themselves.
  ///   - synced: Whether the connection is synced.
  /// - Returns: The sheet to open.
  static func nextToPresent(_ control: Control?, presented: Set<String>, synced: Bool) -> PageSheet? {
    guard synced, let control else { return nil }
    if let question = control.question, !presented.contains(question.id) { return .question(question) }
    if let interaction = control.interactions.first, !presented.contains(interaction.id) {
      return .interaction(interaction)
    }
    return nil
  }

  /// The id a sheet opened by itself is remembered by.
  ///
  /// - Remark: The question's or dialog's own id.
  /// - SideEffects: none
  /// - Parameter sheet: The sheet.
  /// - Returns: The id.
  private static func waitingId(_ sheet: PageSheet) -> String {
    switch sheet {
    case .question(let question): question.id
    case .interaction(let interaction): interaction.id
    case .queue, .children, .model: ""
    }
  }

  /// The top bar's second line, only on a child's page: the conversation it came from.
  ///
  /// - Remark: The paper redesign drops "项目 · 分支" and the run's state from the top bar
  ///   (design-language "手机端 · 对话页"); a child still says "↳ 父会话标题", as the desktop's
  ///   breadcrumb does.
  /// - SideEffects: none
  /// - Parameter parentTitle: The parent's title, for a child.
  /// - Returns: The line, or `nil` for an ordinary conversation.
  static func subtitle(parentTitle: String?) -> String? {
    parentTitle.map { "↳ \($0)" }
  }

  /// The ids of what waits for an answer, to notice when it changes.
  ///
  /// - Remark: The question's id, then the dialogs'.
  /// - SideEffects: none
  /// - Parameter control: The session's run control.
  /// - Returns: The ids.
  static func waiting(_ control: Control?) -> [String] {
    [control?.question?.id].compactMap { $0 } + (control?.interactions.map(\.id) ?? [])
  }

  /// Whether leaving the screen closes the session.
  ///
  /// - Remark: A push fires `onDisappear` too; a child or the change list pushed over the page keeps
  ///   it under them, still watched, so coming back finds it as it was (the MP6 review).
  /// - SideEffects: none
  /// - Parameters:
  ///   - child: The child pushed over it.
  ///   - changes: The change list pushed over it.
  /// - Returns: Whether it closes.
  static func closes(child: SessionId?, changes: ChangesRoute?) -> Bool {
    child == nil && changes == nil
  }

  /// Where a turn's "改了 N 个文件" goes: the change list of the session's workspace.
  ///
  /// - Remark: `nil` for a session in a chat, which has no workspace.
  private var changesRoute: ChangesRoute? {
    guard let sync, let summary = sync.core.index.sessions.first(where: { $0.sessionId == sessionId }),
      sync.core.index.workspaces.contains(where: { $0.id == summary.containerId })
    else { return nil }
    return ChangesRoute(workspaceId: summary.containerId)
  }

  /// Retries the session's last run.
  ///
  /// - Remark: The error card's "重试".
  /// - SideEffects: Queues `retry_run`.
  private func retry() {
    sync?.perform(.retryRun, in: sessionId)
  }

  /// The toast at the top, if one shows.
  ///
  /// - Remark: The prototype's toast: glass, 38pt high, 13.5pt, under the top bar.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The toast.
  @ViewBuilder
  private func toastView(_ palette: Palette) -> some View {
    if let toast {
      Text(toast)
        .font(.system(size: 13.5))
        .foregroundStyle(palette.text)
        .padding(.horizontal, Metrics.md)
        .frame(height: 38)
        .atriumGlass(in: Capsule())
        .padding(.top, 62)
        .transition(.opacity.combined(with: .scale(scale: 0.92)))
        .accessibilityIdentifier("session.toast")
    }
  }

  /// The floating bar at the top: back, the centred title, settings, and how the link is.
  ///
  /// - Remark: design-language "手机端 · 对话页": 44pt glass keys on both sides, the title centred
  ///   between them (16pt semibold, one line), nothing about the branch or the run; a child's page
  ///   adds "↳ 父会话标题". Content passing under it is frosted (`GlassEdge`). When the link is down,
  ///   a glass strip floats under the title (`LinkStrip`); while the session loads, the same strip
  ///   says so.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The bar.
  private func topBar(_ palette: Palette) -> some View {
    let summary = sync?.core.index.sessions.first { $0.sessionId == sessionId }
    let parent = summary?.parent.flatMap { parent in
      sync?.core.index.sessions.first { $0.sessionId == parent.sessionId }
    }
    return VStack(spacing: 8) {
      ZStack {
        VStack(spacing: 1) {
          Text(summary.map(HomeList.title(of:)) ?? "")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(palette.text)
            .lineLimit(1)
            .accessibilityIdentifier("session.title")
          if let line = Self.subtitle(parentTitle: parent.map(HomeList.title(of:))) {
            Text(line).font(.system(size: 11.5)).foregroundStyle(palette.secondary).lineLimit(1)
          }
        }
        .padding(.horizontal, Metrics.glassButton + Metrics.md + Metrics.xs)
        GlassCircleButton(systemImage: "chevron.left", label: "返回") { dismiss() }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.leading, Metrics.md)
          .accessibilityIdentifier("session.back")
        if let openSettings {
          GlassCircleButton(systemImage: "ellipsis", label: "设置") { openSettings(sessionId) }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.trailing, Metrics.md)
            .accessibilityIdentifier("session.settings")
        }
      }
      .frame(height: 50)
      if let sync,
        let strip = Self.strip(pill: HomeView.pill(for: sync.status), status: sync.core.sessions[sessionId]?.status)
      {
        LinkStrip(state: strip)
          .transition(.opacity.combined(with: .offset(y: -6)))
      }
    }
    .background(alignment: .top) {
      GlassEdge(edge: .top).frame(height: 128).ignoresSafeArea(edges: .top).offset(y: -60)
    }
  }

  /// The capsule under the title, or `nil` for none.
  ///
  /// - Remark: design-language "手机端 · 对话页": one capsule at a time. A link that is down wins,
  ///   since nothing loads without it; otherwise a session still loading (or not yet opened) says
  ///   "正在加载…" there instead of a grey line in the list.
  /// - SideEffects: none
  /// - Parameters:
  ///   - pill: How the phone is connected.
  ///   - status: The session's status, `nil` before the page opened it.
  /// - Returns: The capsule's state, or `nil`.
  static func strip(pill: ConnectionPill.State, status: SessionState.Status?) -> LinkStrip.State? {
    if let link = LinkStrip.state(pill) { return link }
    switch status {
    case nil, .loading: return .loading
    default: return nil
    }
  }

  /// The line under the items for where the session stands.
  ///
  /// - Remark: Exited or refused; nothing while loading (the capsule under the title says that, see
  ///   `strip(pill:status:)`) or when up to date. A refusal shows only its code: the host sends no
  ///   words of its own (AGENTS.md).
  /// - SideEffects: none
  /// - Parameter status: The session's status, `nil` before the page opened it.
  /// - Returns: The line, if any.
  static func statusLine(_ status: SessionState.Status?) -> String? {
    switch status {
    case nil, .loading, .ready: nil
    case .exited: "pi 已退出"
    case .failed(let code): "打不开这个会话（\(code.rawValue)）"
    case .handedOff: "这个会话交给终端里的 pi 了"
    }
  }

  /// One grey line for a notice.
  ///
  /// - Remark: Its kind only.
  /// - SideEffects: none
  /// - Parameter notice: The notice.
  /// - Returns: The line.
  static func label(_ notice: Notice) -> String {
    switch notice {
    case .compacted: "上下文已压缩"
    case .restarted: "pi 重启了"
    case .interaction: "对话框"
    case .note: "说明"
    }
  }
}

/// A message the phone sent that is not settled yet, as a bubble with its state under it.
///
/// - Remark: design-language "手机端 · 对话": "发送中" and "没能确认是否送到 · 重发" under the bubble.
struct PendingBubble: View {
  /// The message.
  let message: Outgoing
  /// Sends an uncertain message again.
  let resend: () -> Void
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The bubble.
  var body: some View {
    let palette = Palette(scheme: scheme)
    UserBubble(text: message.text, images: 0) {
      switch message.state {
      case .sending:
        Text("发送中")
      case .accepted:
        EmptyView()
      case .uncertain:
        Button(action: resend) {
          Text("没能确认是否送到 · 重发").foregroundStyle(palette.attn)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("session.resend")
      }
    }
  }
}

/// The glass strip under a conversation's title while the link is down.
///
/// - Remark: design-language "手机端 · 对话页": a floating glass capsule with a spinner and
///   "正在重连" and an ink "重试"; when the person must act, an orange dot and the reason. Hidden
///   while connected or catching up.
struct LinkStrip: View {
  /// What the strip says.
  ///
  /// - Remark: The link states worth a strip; see `state(_:)`.
  enum State: Equatable {
    /// Trying again by itself.
    case reconnecting
    /// The Mac does not answer.
    case offline
    /// The relay cannot be reached.
    case relayUnreachable
    /// The versions differ; nothing to retry.
    case versionMismatch
    /// The session is still loading; nothing to retry.
    case loading
  }

  /// What it says.
  let state: State
  /// Tries the connection again now.
  @Environment(\.reconnectNow) private var reconnectNow
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The strip.
  var body: some View {
    let palette = Palette(scheme: scheme)
    HStack(spacing: 8) {
      switch state {
      case .reconnecting:
        Spinner(size: 12, line: 1.8)
        Text("正在重连").foregroundStyle(palette.text)
      case .offline:
        Circle().fill(palette.tertiary).frame(width: 7, height: 7)
        Text("Mac 离线").foregroundStyle(palette.text)
      case .relayUnreachable:
        Circle().fill(palette.attn).frame(width: 7, height: 7)
        Text("连不上 relay").foregroundStyle(palette.text)
      case .versionMismatch:
        Circle().fill(palette.attn).frame(width: 7, height: 7)
        Text("版本不一致").foregroundStyle(palette.text)
      case .loading:
        Spinner(size: 12, line: 1.8)
        Text("正在加载…").foregroundStyle(palette.text)
      }
      if Self.retries(state), let reconnectNow {
        Button("重试") { reconnectNow() }
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(palette.onInk)
          .padding(.horizontal, 10)
          .frame(height: 24)
          .background(palette.ink, in: Capsule())
          .buttonStyle(PressStyle())
          .accessibilityIdentifier("session.reconnect")
      }
    }
    .font(.system(size: 13))
    .padding(.leading, 12)
    .padding(.trailing, !Self.retries(state) || reconnectNow == nil ? 12 : 6)
    .frame(height: 34)
    .atriumGlass(in: Capsule())
    .accessibilityElement(children: .combine)
  }

  /// Tells whether this state offers "重试".
  ///
  /// - Remark: Only a link that is down can be retried; mismatched versions and loading cannot.
  /// - SideEffects: none
  /// - Parameter state: The state.
  /// - Returns: Whether it retries.
  private static func retries(_ state: State) -> Bool {
    switch state {
    case .reconnecting, .offline, .relayUnreachable: true
    case .versionMismatch, .loading: false
    }
  }

  /// The strip's state for how the phone is connected, or `nil` when there is nothing to say.
  ///
  /// - Remark: Connected and catching up say nothing.
  /// - SideEffects: none
  /// - Parameter pill: How the phone is connected.
  /// - Returns: The state, or `nil`.
  static func state(_ pill: ConnectionPill.State) -> State? {
    switch pill {
    case .connected, .syncing: nil
    case .reconnecting: .reconnecting
    case .offline: .offline
    case .relayUnreachable: .relayUnreachable
    case .versionMismatch: .versionMismatch
    }
  }
}
