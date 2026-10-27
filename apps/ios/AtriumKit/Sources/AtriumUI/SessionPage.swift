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
  /// The toast showing, if any.
  @State private var toast: String?

  /// The page.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let state = sync?.core.sessions[sessionId]
    let controls = SessionControls(
      control: state?.control, running: state?.running ?? false, connected: sync?.status == .connected)
    let lastTurn = state?.items.last { if case .turn = $0 { true } else { false } }?.id
    ScrollView {
      LazyVStack(alignment: .leading, spacing: Metrics.md) {
        if sync?.core.stale == true {
          Text("不是最新").font(Typography.meta).foregroundStyle(palette.tertiary)
        }
        if state?.hasOlder == true {
          Text("更早的在 Mac 上看").font(Typography.meta).foregroundStyle(palette.tertiary)
        }
        ForEach(state?.items ?? [], id: \.id) { item in
          switch item {
          case .turn(let turn):
            TurnView(layout: TurnLayout(turn), retry: turn.id == lastTurn ? { retry() } : nil, changes: changesRoute)
              .id(turn.id)
          case .notice(let notice):
            Text(Self.label(notice)).font(Typography.meta).foregroundStyle(palette.tertiary)
          }
        }
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
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, Metrics.page)
      .padding(.top, Metrics.glassButton + Metrics.lg)
      .padding(.bottom, Metrics.xl)
    }
    .defaultScrollAnchor(.bottom)
    .background(palette.page.ignoresSafeArea())
    .overlay(alignment: .top) { topBar(palette) }
    .hidingNavigationBar()
    .safeAreaInset(edge: .bottom) {
      if let sync {
        let children = HomeList.children(of: sessionId, in: sync.core.index)
        SessionDock(
          sessionId: sessionId, sync: sync, showQueue: { sheet = .queue },
          showChildren: { sheet = .children(children) }, children: children.count, toast: { toast = $0 })
      }
    }
    .overlay(alignment: .top) { toastView(palette) }
    .sheet(item: $sheet) { shown in
      if let sync {
        switch shown {
        case .queue: QueueSheet(sessionId: sessionId, sync: sync)
        case .question(let question): QuestionSheet(sessionId: sessionId, sync: sync, question: question)
        case .interaction(let interaction): InteractionSheet(sessionId: sessionId, sync: sync, interaction: interaction)
        case .children(let children): ChildrenSheet(children: children) { openChild = $0 }
        }
      }
    }
    .navigationDestination(item: $openChild) { SessionPage(sessionId: $0) }
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
    // Opening a child keeps this page under it: still watched, so coming back finds it as it was.
    .onDisappear { if openChild == nil { sync?.close(sessionId) } }
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
    case .queue, .children: ""
    }
  }

  /// The top bar's second line: where the session is, or for a child the conversation it came from.
  ///
  /// - Remark: The prototype writes "↳ 父会话标题" on a child's page.
  /// - SideEffects: none
  /// - Parameters:
  ///   - place: "项目 · 分支".
  ///   - parentTitle: The parent's title, for a child.
  /// - Returns: The line.
  static func subtitle(place: String, parentTitle: String?) -> String {
    parentTitle.map { "↳ \($0)" } ?? place
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

  /// The floating bar at the top: back, the title and where the session is.
  ///
  /// - Remark: The prototype's top bar: a 44pt glass back button, the title (15pt semibold) and
  ///   "项目 · 分支" (11.5pt) centred, over a fade of the page colour.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The bar.
  private func topBar(_ palette: Palette) -> some View {
    let summary = sync?.core.index.sessions.first { $0.sessionId == sessionId }
    return ZStack {
      VStack(spacing: 1) {
        Text(summary.map(HomeList.title(of:)) ?? "")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(palette.text)
          .lineLimit(1)
          .accessibilityIdentifier("session.title")
        if let summary, let index = sync?.core.index {
          let parent = summary.parent.flatMap { parent in index.sessions.first { $0.sessionId == parent.sessionId } }
          Text(
            Self.subtitle(
              place: HomeList.place(of: summary.containerId, in: index), parentTitle: parent.map(HomeList.title(of:)))
          )
          .font(.system(size: 11.5))
          .foregroundStyle(palette.secondary)
          .lineLimit(1)
        }
      }
      .padding(.horizontal, Metrics.glassButton + Metrics.md + Metrics.xs)
      GlassCircleButton(systemImage: "chevron.left", label: "返回") { dismiss() }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, Metrics.md)
        .accessibilityIdentifier("session.back")
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

  /// The line under the items for where the session stands.
  ///
  /// - Remark: Loading, exited or refused; nothing when up to date. A refusal shows only its code:
  ///   the host sends no words of its own (AGENTS.md).
  /// - SideEffects: none
  /// - Parameter status: The session's status, `nil` before the page opened it.
  /// - Returns: The line, if any.
  static func statusLine(_ status: SessionState.Status?) -> String? {
    switch status {
    case nil, .loading: "正在加载…"
    case .ready: nil
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
    VStack(alignment: .trailing, spacing: Metrics.xxs) {
      Text(message.text)
        .font(Typography.reply)
        .foregroundStyle(palette.text)
        .padding(.horizontal, Metrics.md)
        .padding(.vertical, Metrics.sm)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: Metrics.radiusBubble))
      switch message.state {
      case .sending:
        Text("发送中").font(Typography.meta).foregroundStyle(palette.tertiary)
      case .accepted:
        EmptyView()
      case .uncertain:
        Button(action: resend) {
          Text("没能确认是否送到 · 重发").font(Typography.meta).foregroundStyle(palette.attnText)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("session.resend")
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}
