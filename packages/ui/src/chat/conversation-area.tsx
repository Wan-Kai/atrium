import { type AtriumClient, CommandError, ConnectionLostError, type SessionView } from "@atrium/client";
import { type DiffStat, isChatId, type SessionModel } from "@atrium/protocol";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { HandedOff } from "./handed-off";
import { type StoreApi, useStore } from "zustand";
import { desktopBridge } from "../app/bootstrap";
import { Composer, type ComposerProps, type SentImage } from "./composer";
import { pageDrafts } from "../state/use-draft";
import { type ChosenCommand, historyOf } from "./composer-text";
import { ChangesPane } from "./changes-pane";
import { FastToggle } from "./fast-toggle";
import { shownModel } from "./model-choice";
import { ModelPicker, type PickerRequest } from "./model-picker";
import { clearNotice, showNotice } from "../state/session-notices";
import { sessionTitle } from "../sidebar/names";
import { type BuiltinCall, builtinBlocked, lastReply, namedLevel, namedModel } from "./builtin-commands";
import { download } from "./download";
import { ChangesTrack, ControlCards, ControlTrack, type RunActions } from "./run-control";
import { StatusBar } from "./status-bar";
import { MessageImagesContext, messageImages } from "./message-images";
import { Transcript } from "./transcript";
import {
  type Launch,
  type NewWorkspaceState,
  createNewWorkspaceStore,
  describeWorktreeError,
  dismiss,
  holdsBack,
  launchOver,
} from "../state/new-workspace";
import { LaunchView } from "./launch-timeline";
import { type Panes, createPanes, memoryStorage } from "../state/panes";
import {
  NO_VIEW,
  type WorkspaceViews,
  choosePanelTab,
  createWorkspaceViews,
  panelTabOf,
  viewOf,
} from "../state/workspace-views";
import { ActiveViewer } from "../files/active-viewer";
import { NO_CHANGES, useDiffWatch } from "../files/use-diff";

/** What to say when pi cannot be used, by the status the host found. */
const PI_STATUS_TEXT: Readonly<Record<string, string>> = {
  missing: "没有找到 pi，请先安装 pi",
  outdated: "pi 的版本过低，请先更新",
  unusable: "pi 无法运行，请在终端里检查 pi 能否启动",
  exited: "pi 已经退出了，可能还没有登录模型服务",
  unresponsive: "pi 没有响应，请稍后再试",
};

/**
 * Explains why sending failed, in Chinese.
 *
 * @remarks
 * The host sends codes, never text (AGENTS.md); the wording lives here. `pi_unavailable` says
 * what was found, so the line can say what to do; `pi_rejected` carries pi's own words, shown as
 * the raw detail.
 *
 * @sideEffects none
 * @param error - What the send rejected with.
 * @returns The sentence to show.
 */
export function describeSendError(error: unknown): string {
  if (error instanceof ConnectionLostError) return "与宿主的连接断开了，这条消息可能没有发出";
  if (!(error instanceof CommandError)) return "发送失败";
  if (error.code === "pi_unavailable")
    return PI_STATUS_TEXT[String(error.params?.["status"])] ?? "还在查找 pi，请稍后再试";
  if (error.code === "session_busy") return "pi 正在忙，等这一轮结束再发";
  if (error.code === "pi_rejected") return `pi 拒绝了这条消息：${String(error.params?.["detail"] ?? "")}`;
  if (error.code === "session_not_found") return "这个会话已经不存在了";
  if (error.code === "transcript_changed") return "对话记录刚刚更新了，请再试一次";
  if (error.code === "session_cwd_missing") return `恢复失败：会话的目录 ${String(error.params?.["cwd"] ?? "")} 不存在`;
  if (error.code === "workspace_not_found") return "这个工作区已经不在了";
  if (error.code === "chat_not_found") return "这个对话已经不在了";
  if (error.code === "attachment_missing") return "图片已经过期，请重新添加";
  if (error.code === "attachment_limit") return "图片太多了：一次最多 20 张、共 32 MiB";
  if (error.code === "session_stopping") return "正在等 pi 停下，停下后再发";
  if (error.code === "queue_item_not_found") return "这条排队的消息已经发出或删掉了";
  if (error.code === "interaction_closed") return "这个问题已经回答过、超时或作废了";
  if (error.code === "nothing_to_compact") return "对话还太短，不用压缩";
  if (error.code === "already_compacted") return "刚压缩过，没有新内容";
  if (error.code === "compact_failed") return "没能压缩：pi 出错了";
  if (error.code === "export_failed") {
    return error.params?.["reason"] === "too_large" ? "会话太大（超过 20 MB），没能导出" : "没能导出：pi 出错了";
  }
  return "宿主出错了，消息没有发出";
}

/**
 * Explains why a fork failed, in Chinese.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的 `/` 命令 · 分叉"): pi's own words never reach the UI.
 *
 * @sideEffects none
 * @param error - What `fork_session` rejected with.
 * @returns The sentence to show.
 */
function describeForkError(error: unknown): string {
  if (!(error instanceof CommandError)) return "没能分叉";
  if (error.code === "session_busy") return "运行中不能分叉";
  if (error.code === "turn_not_found") return "没能分叉：找不到这一轮";
  if (error.code === "fork_failed") return "没能分叉：pi 出错了";
  return "没能分叉";
}

/** How much of the original's title a fork's name keeps, so the name stays within the 256 characters a name may have. */
const FORK_TITLE_LENGTH = 250;

/**
 * Forks a session after a turn, naming the fork after it.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的 `/` 命令 · 分叉"): the fork is named the session's title, as the sidebar
 * shows it, with "（分叉）"; the host opens it as the active tab. A failure shows beside the tab
 * bar until something takes its place; trying again takes away the last one first.
 *
 * @sideEffects Sends `fork_session`; changes the session's notice.
 * @param client - The client.
 * @param sessionId - The session.
 * @param turnId - The turn the fork ends with.
 */
function forkFrom(client: AtriumClient, sessionId: string, turnId: string): void {
  const shown = client.index.getState().sessions.find((one) => one.sessionId === sessionId);
  if (shown === undefined) return;
  clearNotice(sessionId);
  const name = `${sessionTitle(shown).slice(0, FORK_TITLE_LENGTH)}（分叉）`;
  // Fire and forget: a failure is shown.
  void client.forkSession(sessionId, turnId, name).catch((error: unknown) => {
    showNotice(sessionId, describeForkError(error), true);
  });
}

/**
 * Explains why a step of sending from the new-workspace page failed, in Chinese.
 *
 * @remarks
 * Creating the worktree has words of its own; the session's and the message's steps fail as a
 * send does (SPEC-0001, "M1.11 的新建工作区").
 *
 * @sideEffects none
 * @param error - What the step rejected with.
 * @returns The sentence to show.
 */
export function describeLaunchError(error: unknown): string {
  return describeWorktreeError(error) ?? describeSendError(error);
}

/**
 * Explains why a model or thinking level could not be set, in Chinese.
 *
 * @remarks
 * As `describeSendError`, but pi refusing names what it refused, and a pi without Atrium's Fast
 * extension says so (SPEC-0001, "Fast").
 *
 * @sideEffects none
 * @param error - What the command rejected with.
 * @returns The sentence to show.
 */
export function describeModelError(error: unknown): string {
  if (error instanceof CommandError && error.code === "pi_rejected") {
    return `pi 没有接受这个设置：${String(error.params?.["detail"] ?? "")}`;
  }
  if (error instanceof CommandError && error.code === "fast_unavailable") {
    return "这个会话的 pi 没有加载 Atrium 的 Fast 扩展，开关不了 Fast";
  }
  return describeSendError(error);
}

/**
 * The workspace a container is, if it is one.
 *
 * @remarks
 * Chats and no container at all run outside any workspace: their models come from Atrium's home,
 * and they have no git changes (SPEC-0001, "对话").
 *
 * @sideEffects none
 * @param containerId - The container, or `null`.
 * @returns The workspace's id, or `null`.
 */
function workspaceOf(containerId: string | null): string | null {
  return containerId === null || isChatId(containerId) ? null : containerId;
}

/** Runs a command, showing why it failed if it does, in the words `describe` picks. */
type Act = (command: () => Promise<unknown>, describe?: (error: unknown) => string) => void;

/**
 * The model button for the session shown, or for the one the next message creates, with the Fast
 * button left of it.
 *
 * @remarks
 * SPEC-0001 ("模型与输入框"): the container's model list, which the area asks for when it
 * shows, is asked for again when the panel opens, and the host answers from its cache; "刷新"
 * makes pi look again. Before a session exists, the button shows the model a new session
 * will start on, and choosing creates the session first, as sending does. The Fast button shows
 * only while the model shown has Fast, with the session's Fast, or before a session exists the
 * one chosen last; pressing it creates the session first too (SPEC-0001, "Fast").
 *
 * @sideEffects Subscribes to the container's models and to the preferences; asks for the models
 * when the panel opens; sends model and Fast commands through `act`.
 * @param props - The client, the container, the session's model and Fast, whether it is disabled,
 * the session to change, how to run a command, and the latest request to open the panel.
 * @returns The buttons.
 */
function SessionModelPicker({
  client,
  containerId,
  model,
  fast,
  disabled,
  session,
  act,
  request,
}: {
  readonly client: AtriumClient;
  readonly containerId: string | null;
  readonly model: SessionModel | null;
  /** The session's Fast; `null` before a session exists. */
  readonly fast: boolean | null;
  readonly disabled: boolean;
  readonly session: () => Promise<string>;
  readonly act: Act;
  readonly request: PickerRequest | null;
}) {
  const key = workspaceOf(containerId);
  const list = useStore(client.models(key));
  const preferences = useStore(client.index, (index) => index.preferences);
  const shown = shownModel(model, preferences, list);
  return (
    <>
      {shown === null || shown.fast === null ? null : (
        <FastToggle
          enabled={fast ?? preferences.lastFast}
          fast={shown.fast}
          disabled={disabled}
          onToggle={(enabled) => act(async () => client.setFast(await session(), enabled), describeModelError)}
        />
      )}
      <ModelPicker
        shown={shown}
        list={list}
        disabled={disabled}
        onOpen={() => {
          // Fire and forget: see above.
          void client.loadModels(key);
        }}
        onRefresh={() => {
          // Fire and forget: see above.
          void client.loadModels(key, true);
        }}
        onChooseModel={(ref) => act(async () => client.setModel(await session(), ref), describeModelError)}
        onChooseLevel={(level) => act(async () => client.setThinkingLevel(await session(), level), describeModelError)}
        request={request}
      />
    </>
  );
}

/**
 * The transcript and the input box of a session, subscribed to its view.
 *
 * @remarks
 * Split out so the store subscription exists only once there is a session. While a run goes on,
 * a message goes into the host's queue and ⌘+Enter steers; the capsule bar shows the queue and
 * the steers on their way, and questions from extensions and a failed session wait above the
 * input box (SPEC-0001, "运行控制"). The status bar under it shows the session's figures, with
 * the groups chosen in the global preferences (SPEC-0001, "状态栏"). A session made from the
 * new-workspace page shows the steps of its making above the transcript, and its box sends
 * nothing until the first message has gone (SPEC-0001, "M1.11 的新建工作区").
 *
 * @sideEffects Subscribes to the session's store and the preferences; loads older items when
 * asked; sends run control commands and status bar choices, reporting their failures through `act`.
 * @param props - The client, the session, its view store, what to do with a message, a steer and a
 * built-in command, how to run a command whose failure should show, a notice to show above the
 * input box, the latest request to open the model panel, and what the new-workspace page set going
 * here.
 * @returns The transcript and input box.
 */
function SessionArea({
  client,
  containerId,
  sessionId,
  store,
  onSend,
  onSteer,
  onBuiltin,
  act,
  session,
  notice,
  pickerRequest,
  attaching,
  takesFocus,
  onFocusTaken,
  changes,
  launch,
}: {
  readonly client: AtriumClient;
  readonly containerId: string | null;
  readonly sessionId: string;
  readonly store: StoreApi<SessionView>;
  readonly onSend: ComposerProps["onSend"];
  readonly onSteer: NonNullable<ComposerProps["onSteer"]>;
  readonly onBuiltin: NonNullable<ComposerProps["onBuiltin"]>;
  readonly act: Act;
  readonly session: () => Promise<string>;
  readonly notice: ReactNode;
  readonly pickerRequest: PickerRequest | null;
  /** The composer's ways to add images and reference dropped files, for the session's model. */
  readonly attaching: (model: SessionModel | null) => Partial<ComposerProps>;
  /** Whether the box takes the focus, as for a session just created from the empty state. */
  readonly takesFocus: boolean;
  /** The box has taken the focus, which it does only once. */
  readonly onFocusTaken: () => void;
  /** The workspace's git changes for the capsule, when it has some, and the changes panel. */
  readonly changes: { readonly stat: DiffStat; readonly open: boolean; readonly onToggle: () => void } | undefined;
  /** What sending from the new-workspace page set going here, until its first message has gone. */
  readonly launch: Launch | undefined;
}) {
  const view = useStore(store);
  const statusBar = useStore(client.index, (index) => index.preferences.statusBar);
  const draft = useStore(
    client.index,
    (index) => (index.sessions.find((one) => one.sessionId === sessionId)?.file ?? null) === null,
  );
  // One per session, so thumbnails do not load again on every render.
  const images = useMemo(() => messageImages(client, sessionId), [client, sessionId]);
  useEffect(() => {
    // The box's own effect has focused it by now, as children's effects run first.
    if (takesFocus) onFocusTaken();
    // Only as the box appears.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see above.
  }, [takesFocus]);
  const running = view.run !== null;
  const actions: RunActions = {
    resume: () => act(() => client.resumeQueue(sessionId)),
    clear: () => act(() => client.clearQueue(sessionId)),
    update: (itemId, text) => act(() => client.updateQueued(sessionId, itemId, text)),
    remove: (itemId) => act(() => client.removeQueued(sessionId, itemId)),
    steerQueued: (itemId) => act(() => client.steerQueued(sessionId, itemId)),
    answer: (interactionId, answer) => act(() => client.answerInteraction(sessionId, interactionId, answer)),
    retry: () => act(() => client.retryRun(sessionId)),
  };
  return (
    <>
      {launch === undefined ? null : (
        <LaunchView
          launch={launch}
          reason={launch.failure === undefined ? null : describeLaunchError(launch.failure)}
        />
      )}
      <MessageImagesContext value={images}>
        <Transcript
          view={view}
          onLoadOlder={() => {
            // Fire and forget: a failed page leaves "正在加载" until the next scroll asks again.
            client.loadOlder(sessionId).catch(() => undefined);
          }}
          onLoadStep={(turnId, stepId) => {
            // Fire and forget: a failed fetch leaves the preview, still marked as loading.
            client.loadStep(sessionId, turnId, stepId).catch(() => undefined);
          }}
          onRetry={actions.retry}
          onFork={(turnId) => forkFrom(client, sessionId, turnId)}
        />
      </MessageImagesContext>
      <ControlCards control={view.control} actions={actions} />
      {notice}
      <Composer
        {...attaching(view.model)}
        key={sessionId}
        draftKey={sessionId}
        autoFocus={takesFocus}
        history={historyOf(view.items)}
        onOlderHistory={() => {
          // Fire and forget: a failed page leaves ↑ where it is.
          if (view.hasOlder) client.loadOlder(sessionId).catch(() => undefined);
        }}
        onListCommands={async () => (await client.listCommands(await session())).commands}
        onSearchFiles={async (query) => (await client.searchFiles(await session(), query)).files}
        onSend={onSend}
        onSteer={onSteer}
        onBuiltin={onBuiltin}
        draft={draft}
        onStop={() => act(() => client.stop(sessionId))}
        running={running}
        stopping={view.control.stopping}
        compacting={view.control.compacting}
        held={holdsBack(launch)}
        above={
          <ControlTrack
            control={view.control}
            running={running}
            actions={actions}
            {...(changes === undefined ? {} : { changes })}
          />
        }
        picker={
          <SessionModelPicker
            client={client}
            containerId={containerId}
            model={view.model}
            fast={view.fast}
            disabled={view.control.stopping}
            session={session}
            act={act}
            request={pickerRequest}
          />
        }
      />
      <StatusBar
        metrics={view.metrics}
        choices={statusBar}
        onChoose={(choices) => act(() => client.setPreferences({ statusBar: choices }))}
      />
    </>
  );
}

/**
 * The conversation area: the active session of the current container, or its empty state.
 *
 * @remarks
 * The active session is watched while it shows. With no session open, the first edit in the input
 * box creates one where the client is, a chat when it is nowhere yet, and the message goes to it
 * (SPEC-0001, "标签页"); a message or edit while it is being created waits for it instead of
 * creating another, while one after moving to another container starts its own there. The
 * active session is opened whenever it shows, which starts a pi that is not running (as after a
 * restart) and explains here why it cannot. A session whose pi has exited, or that the host lost
 * in a restart, is opened again before the message goes. A failed send is explained above the input box, and the
 * message goes back into its box when the box is still empty. A session the new-workspace page
 * made shows the steps of its making until its first message has gone; one failed stays until the
 * next send. The empty
 * state's layout and logo are placeholders until designed (roadmap, "MVP 1 里还没设计"). The
 * right panel is open or not, and as wide, in every workspace alike; a viewer tab shown takes the
 * whole area but the panel; the workspace's diff is watched while either needs it (SPEC-0001,
 * "M1.12 的文件与更改").
 *
 * @sideEffects Watches the active session; creates and opens sessions and sends messages
 * through the client.
 * @param props - The client, the container, its active session, how to create a session, what
 * the new-workspace page set going, the panes, and the workspace views.
 * @returns The area.
 */
export function ConversationArea({
  client,
  containerId,
  sessionId,
  create,
  launches = NO_LAUNCHES,
  panes: given,
  views: givenViews,
}: {
  readonly client: AtriumClient;
  readonly containerId: string | null;
  readonly sessionId: string | null;
  /** Creates a session where the client is and returns its id. */
  readonly create: () => Promise<string>;
  /** What the new-workspace page set going; none when left out. */
  readonly launches?: StoreApi<NewWorkspaceState>;
  /** The panes; left out, the area keeps its own, which nothing outlives. */
  readonly panes?: StoreApi<Panes>;
  /** The workspace views; left out, the area keeps its own, which nothing outlives. */
  readonly views?: StoreApi<WorkspaceViews>;
}) {
  const [own] = useState(() => createPanes(memoryStorage()));
  const panes = given ?? own;
  const [ownViews] = useState(() => createWorkspaceViews(memoryStorage()));
  const views = givenViews ?? ownViews;
  const [failure, setFailure] = useState<string | null>(null);
  const launch = useStore(launches, (state) => launchOver(state, sessionId));
  const [store, setStore] = useState<StoreApi<SessionView> | undefined>(undefined);
  // The session being created in each container, shared by every send there until it exists;
  // only read in event handlers.
  const creating = useRef(new Map<string, Promise<string>>());

  // Each connection has a trace of its own, so a reconnect counts as a new one.
  const connection = useStore(client.connection, (state) => (state.status === "connected" ? state.traceId : null));
  useEffect(() => {
    // Fire and forget: a failed list shows in the model panel. Asked for as the container shows,
    // as Paseo prefetches it, so the panel opens on a ready list (SPEC-0001, "模型与输入框"); and
    // again on every connection, as a request without one fails at once.
    if (connection !== null) void client.loadModels(workspaceOf(containerId));
  }, [client, containerId, connection]);
  /**
   * The session just created from the empty state of a container, which took over its words. Until
   * it shows, the empty state's box writes to its draft and sends to it; its box takes the focus
   * once (SPEC-0001, "模型与输入框").
   */
  const [handing, setHanding] = useState<{ readonly container: string; readonly sessionId: string } | null>(null);
  // Read when sending, which may come before the render that shows `handing`.
  const handingNow = useRef(handing);
  /**
   * Remembers the session the empty state handed its words to, or forgets it.
   *
   * @remarks
   * See `handing`.
   *
   * @sideEffects Updates component state.
   * @param next - The container and session, or `null`.
   */
  const handTo = (next: { readonly container: string; readonly sessionId: string } | null): void => {
    handingNow.current = next;
    setHanding(next);
  };
  // Where a new session's words wait: its container, or nowhere before a chat exists.
  const containerKey = containerId ?? "nowhere";
  /** The workspace shown, whose git changes the capsule and panel show; `null` for a chat. */
  const workspaceId = workspaceOf(containerId);
  const changes = useStore(workspaceId === null ? NO_CHANGES : client.changes(workspaceId));
  useEffect(() => {
    // Fire and forget: a lost connection asks again when it is back (SPEC-0001, "工作区改动").
    client.watchChanges(workspaceId === null ? [] : [workspaceId]).catch(() => undefined);
  }, [client, workspaceId]);
  useEffect(
    () => () => {
      // Fire and forget: see above.
      client.watchChanges([]).catch(() => undefined);
    },
    [client],
  );
  const panelOpen = useStore(panes, (state) => state.panelOpen);
  const viewer = useStore(views, (state) => (workspaceId === null ? NO_VIEW : viewOf(state, workspaceId)).active);
  useDiffWatch(client, views, workspaceId, workspaceId !== null && (panelOpen || viewer === "diff"));
  /**
   * The capsule's counts, and what clicking it does: open the panel at 更改, or close it when it
   * shows 更改 already (SPEC-0001, "M1.12 的文件与更改 · 右栏").
   */
  const capsule =
    workspaceId === null || changes === null || changes.stat === null
      ? undefined
      : {
          stat: changes.stat,
          open: panelOpen,
          onToggle: () => {
            const onChanges = panelTabOf(views.getState(), workspaceId, true) === "changes";
            choosePanelTab(views, workspaceId, "changes");
            panes.getState().setPanelOpen(!(panelOpen && onChanges));
          },
        };
  useEffect(() => {
    if (handing === null || handing.container === containerKey) return;
    // The area went elsewhere before the session the words went to showed; its own box has them.
    handingNow.current = null;
    // oxlint-disable-next-line react-hooks-js/set-state-in-effect -- follows the container shown.
    setHanding(null);
  }, [handing, containerKey]);
  /**
   * Where the empty state's words go now: its own draft, or the session it handed them to.
   *
   * @remarks
   * Only this container's: another container's empty state has words of its own.
   *
   * @sideEffects none
   * @returns The draft key.
   */
  const emptyDraftKey = (): string =>
    handingNow.current?.container === containerKey ? handingNow.current.sessionId : `new:${containerKey}`;

  useEffect(() => {
    let current = true;
    // Fire and forget: a lost connection resubscribes on reconnect.
    client.watch(sessionId === null ? [] : [sessionId]).catch(() => undefined);
    // The client is the external system here: `watch` makes the session's view at once, and the
    // area has to render again to subscribe to it; an old failure belongs to the old session.
    // oxlint-disable-next-line react/set-state-in-effect -- see above.
    setStore(sessionId === null ? undefined : client.session(sessionId));
    setFailure(null);
    // A tab may show a session whose pi is not running, as after a restart; opening starts it,
    // and says here why it cannot (SPEC-0001, "项目、工作区与会话").
    if (sessionId !== null) {
      client.openSession(sessionId).catch((error: unknown) => {
        if (current) setFailure(describeSendError(error));
      });
    }
    return () => {
      current = false;
    };
  }, [client, sessionId]);

  /** The file of the session shown when it was handed to a terminal, else `null`. */
  const handedOff = useStore(client.index, (index) => {
    const shown = index.sessions.find((one) => one.sessionId === sessionId);
    return shown?.handedOff === true ? (shown.file ?? "") : null;
  });
  // The host instance last connected to; a new one has lost every session's view.
  const hostInstance = useStore(client.connection, (state) =>
    state.status === "connected" ? state.hostInstanceId : null,
  );
  const lastHost = useRef<string | null>(null);
  useEffect(() => {
    if (hostInstance === null) return;
    const before = lastHost.current;
    lastHost.current = hostInstance;
    if (before === null || before === hostInstance || sessionId === null) return;
    // The host restarted: the session shown is opened and watched again at once, rather than on
    // the next message (SPEC-0001, "对话记录的同步").
    client.openSession(sessionId).catch((error: unknown) => setFailure(describeSendError(error)));
    // Fire and forget: a lost connection resubscribes on reconnect.
    client.watch([sessionId]).catch(() => undefined);
    // Only when the host changes; a session shown later is opened by the effect above.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see above.
  }, [client, hostInstance]);

  /**
   * Picks the session a message goes to, creating or reopening one as needed.
   *
   * @remarks
   * Reads the view's status at send time, not from the last render.
   *
   * @sideEffects May create or open a session and watch it.
   * @returns The session id to send to.
   */
  async function target(): Promise<string> {
    if (sessionId === null && handingNow.current?.container === containerKey) return handingNow.current.sessionId;
    if (sessionId === null) {
      // Per container: a message sent in another one must not wait for, or go to, this session.
      const key = containerId ?? "";
      const going = creating.current.get(key);
      if (going !== undefined) return going;
      const created = create()
        .then(async (id) => {
          // What was typed before the session existed goes on in its box, as when `/` or `@`
          // created it (SPEC-0001, "模型与输入框").
          pageDrafts().handOver(`new:${containerKey}`, id);
          handTo({ container: containerKey, sessionId: id });
          await client.watch([id]);
          return id;
        })
        .finally(() => creating.current.delete(key));
      creating.current.set(key, created);
      return created;
    }
    const status = client.session(sessionId)?.getState().status;
    if (status === "exited" || status === "lost") {
      await client.openSession(sessionId);
      await client.watch([sessionId]);
    }
    return sessionId;
  }

  /**
   * Sends a message or a steer, creating or reopening its session first when needed.
   *
   * @remarks
   * See `ConversationArea`.
   *
   * An image the host has let go after 30 minutes is uploaded again once, from the copy the box
   * kept, one image at a time (SPEC-0001, "模型与输入框"). A message that still does not go goes
   * back into its box with its latest uploads.
   *
   * @sideEffects Sends commands; may upload images; updates component state.
   * @param text - The message.
   * @param images - Its uploaded images.
   * @param command - The tag it was sent with, for its pending copy.
   * @param steer - Whether to send it as a steer.
   */
  async function send(
    text: string,
    images: readonly SentImage[],
    command: ChosenCommand | null,
    steer = false,
  ): Promise<void> {
    setFailure(null);
    const failed = launchOver(launches.getState(), sessionId);
    if (failed !== undefined) dismiss(launches, failed.id);
    let id: string | null = null;
    let latest = images;
    try {
      id = await target();
      const to = id;
      const previews = images.map(({ image }) => image.preview);
      const tag = command ?? undefined;
      /**
       * Sends the message with these uploads.
       *
       * @remarks
       * Once, and again with fresh uploads if the host let the first ones go.
       *
       * @sideEffects Sends the command.
       * @param ids - The uploads.
       * @returns The command's result.
       */
      const deliver = (ids: readonly string[]) =>
        steer ? client.steer(to, text, ids, previews, tag) : client.prompt(to, text, ids, previews, tag);
      try {
        await deliver(images.map((image) => image.attachmentId));
      } catch (error) {
        if (!(error instanceof CommandError && error.code === "attachment_missing")) throw error;
        const again: SentImage[] = [];
        for (const { image } of images) {
          const { attachmentId } = await client.uploadAttachment(image.mimeType, image.data);
          again.push({ attachmentId, image });
        }
        latest = again;
        await deliver(again.map((image) => image.attachmentId));
      }
    } catch (error) {
      setFailure(describeSendError(error));
      // The message did not go: back into its box, unless something new was typed there meanwhile.
      pageDrafts().restore(
        id ?? (sessionId === null ? emptyDraftKey() : sessionId),
        text,
        latest.map(({ attachmentId, image }) => ({ id: crypto.randomUUID(), image, attachmentId })),
      );
    }
  }

  /**
   * Runs a command on the session, showing why it failed if it does.
   *
   * @remarks
   * For the queue, stop, dialogs, "重试" and the model.
   *
   * @sideEffects Sends the command; updates component state.
   * @param command - The command.
   * @param describe - How to explain its failure.
   */
  async function attempt(
    command: () => Promise<unknown>,
    describe: (error: unknown) => string = describeSendError,
  ): Promise<void> {
    setFailure(null);
    try {
      await command();
    } catch (error) {
      setFailure(describe(error));
    }
  }

  /**
   * Starts a send without waiting for it.
   *
   * @remarks
   * `send` reports its own failures on screen, so nothing awaits it.
   *
   * @sideEffects Sends commands.
   * @param text - The message.
   * @param images - Its uploaded images.
   * @param command - The tag it was sent with.
   */
  const onSend = (text: string, images: readonly SentImage[], command: ChosenCommand | null): void => {
    // Fire and forget: see above.
    void send(text, images, command);
  };
  /**
   * Creates the empty state's session as soon as the user edits its box.
   *
   * @remarks
   * SPEC-0001 ("标签页"): pi starts while the user goes on typing, so the first message does not
   * wait for it; what was typed moves into the new session's box (`target`). Later edits meet
   * the same creation. One that fails shows here, and the next edit or the send tries again.
   *
   * @sideEffects May create a session and watch it; updates component state.
   */
  const onEmptyEdit = (): void => {
    // Fire and forget: a failure shows here.
    target().catch((error: unknown) => setFailure(describeSendError(error)));
  };
  /**
   * Starts a steer without waiting for it.
   *
   * @remarks
   * See `onSend`.
   *
   * @sideEffects Sends commands.
   * @param text - The steer.
   * @param images - Its uploaded images.
   * @param command - The tag it was sent with.
   */
  const onSteer = (text: string, images: readonly SentImage[], command: ChosenCommand | null): void => {
    // Fire and forget: `send` reports its own failures.
    void send(text, images, command, true);
  };

  /** The latest request from `/model` or `/thinking` to open a part of the model panel. */
  const [pickerRequest, setPickerRequest] = useState<PickerRequest | null>(null);
  /**
   * Opens a part of the model panel, as its shortcut does.
   *
   * @remarks
   * Each request is new, so the same part opens again after it was closed.
   *
   * @sideEffects Updates component state.
   * @param part - The models, or the thinking level.
   */
  const openPicker = (part: PickerRequest["part"]): void =>
    setPickerRequest((last) => ({ part, id: (last?.id ?? 0) + 1 }));

  /**
   * Does what a built-in command asks, saying why if it cannot.
   *
   * @remarks
   * SPEC-0001 ("M1.11 的 `/` 命令 · 执行"): `/compact` has the host compact the context, with what
   * followed as what to keep in mind; `/export` downloads pi's page of the session; `/model` and `/thinking` open their part of the model
   * panel, or set what they name; `/copy` copies the last reply and says so beside the tab bar.
   * The session's state is read now, not from the last render. A model named before the container's
   * list was read waits for the list.
   *
   * @sideEffects May compact the session, download its page, open the model panel, set the model or level (creating
   * the session first, as choosing in the panel does), load the model list, write the clipboard,
   * or show a notice.
   * @param name - The command.
   * @param args - What followed its name.
   * @param view - The session's view, if there is a session.
   * @returns Why it did not run, or `null` when it did.
   */
  async function builtin(
    name: BuiltinCall["command"]["name"],
    args: string,
    view: SessionView | undefined,
  ): Promise<string | null> {
    const models = client.models(workspaceId);
    if (name === "compact") {
      await client.compactSession(await target(), args === "" ? undefined : args);
      return null;
    }
    if (name === "export") {
      const id = await target();
      download(`atrium-${id}.html`, (await client.exportSession(id)).html, "text/html;charset=utf-8");
      return null;
    }
    if (name === "copy") {
      const reply = lastReply(view?.items ?? []);
      if (reply === null || sessionId === null) return "还没有回复可复制";
      const copied = await navigator.clipboard.writeText(reply).then(
        () => true,
        () => false,
      );
      if (!copied) return "复制失败";
      showNotice(sessionId, "已复制最后一条回复");
      return null;
    }
    if (args === "") {
      openPicker(name === "model" ? "model" : "effort");
      return null;
    }
    if (name === "model") {
      if (models.getState().status !== "ready") await client.loadModels(workspaceId);
      const ref = namedModel(args, models.getState().models);
      if (ref === null) return "没有这个模型";
      await client.setModel(await target(), ref);
      return null;
    }
    const shown = shownModel(view?.model ?? null, client.index.getState().preferences, models.getState());
    const named = namedLevel(args, shown?.levels ?? []);
    if ("problem" in named) return named.problem;
    await client.setThinkingLevel(await target(), named.level);
    return null;
  }

  /**
   * Runs a built-in command from the input box, unless it cannot run now.
   *
   * @remarks
   * See `builtin`; a command that cannot run while a run goes on, or before the first message,
   * says so instead (SPEC-0001, "M1.11 的 `/` 命令 · 执行"). Its failure shows above the input box,
   * as a send's does.
   *
   * @sideEffects As `builtin`; updates component state.
   * @param call - The command and what followed its name.
   * @returns Whether it ran.
   */
  async function runBuiltin({ command, args }: BuiltinCall): Promise<boolean> {
    setFailure(null);
    const view = sessionId === null ? undefined : client.session(sessionId)?.getState();
    const file = client.index.getState().sessions.find((one) => one.sessionId === sessionId)?.file ?? null;
    const busy = view !== undefined && (view.run !== null || view.control.stopping || view.control.compacting);
    let problem = builtinBlocked(command, { busy, draft: file === null });
    try {
      problem ??= await builtin(command.name, args, view);
    } catch (error) {
      problem = describeModelError(error);
    }
    setFailure(problem);
    return problem === null;
  }

  const modelList = useStore(client.models(workspaceId));
  const preferences = useStore(client.index, (index) => index.preferences);
  const baseDir = useStore(
    client.index,
    (index) => index.workspaces.find((workspace) => workspace.id === containerId)?.dir ?? null,
  );
  /**
   * The composer's ways to add images and reference dropped files.
   *
   * @remarks
   * Images only when the model shown takes them (SPEC-0001, "图片"); a dropped file's path comes
   * from the desktop shell and is referenced from the workspace's directory.
   *
   * @sideEffects none
   * @param model - The session's model, if known.
   * @returns The composer's props for images and drops.
   */
  const attaching = (model: SessionModel | null) => ({
    onUpload: async (image: SentImage["image"]) =>
      (await client.uploadAttachment(image.mimeType, image.data)).attachmentId,
    imagesAllowed: shownModel(model, preferences, modelList)?.supportsImage !== false,
    baseDir,
    pathForFile: (file: File) => {
      const path = desktopBridge()?.pathForFile?.(file) ?? "";
      return path === "" ? null : path;
    },
  });
  /**
   * Starts a command without waiting for it.
   *
   * @remarks
   * `attempt` reports its own failures on screen.
   *
   * @sideEffects Sends the command.
   * @param command - The command.
   * @param describe - How to explain its failure, if not as a send.
   */
  const act: Act = (command, describe) => {
    // Fire and forget: see above.
    void attempt(command, describe);
  };

  const notice =
    failure === null ? null : (
      <p
        role="alert"
        className="mx-auto w-full max-w-[720px] px-6 pb-2 text-[length:var(--fs-meta)] text-[var(--danger)]"
      >
        {failure}
      </p>
    );
  return (
    // The changes panel's room: it cuts the panel off as it slides out past its edge.
    <div className="relative flex min-h-0 flex-1 overflow-x-clip">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {workspaceId !== null && viewer !== null ? (
          <ActiveViewer client={client} workspaceId={workspaceId} views={views} viewerKey={viewer} />
        ) : store === undefined || sessionId === null ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 text-[var(--text-muted)]">
              <p className="text-[20px] font-medium text-[var(--text)]">
                {containerId === null ? "开始一段对话" : "新会话"}
              </p>
              <p className="text-[length:var(--fs-meta)]">
                {containerId === null
                  ? "不绑定项目和工作区，直接输入就开始"
                  : isChatId(containerId)
                    ? "在这个对话里开始，直接输入就会新建会话"
                    : "在这个工作区里开始，直接输入就会新建会话"}
              </p>
            </div>
            {notice}
            <Composer
              {...attaching(null)}
              key={containerKey}
              draftKey={handing?.container === containerKey ? handing.sessionId : `new:${containerKey}`}
              onListCommands={async () => (await client.listCommands(await target())).commands}
              onSearchFiles={async (query) => (await client.searchFiles(await target(), query)).files}
              onSend={onSend}
              onBuiltin={runBuiltin}
              draft
              onEdit={onEmptyEdit}
              above={capsule === undefined ? undefined : <ChangesTrack changes={capsule} />}
              picker={
                <SessionModelPicker
                  client={client}
                  containerId={containerId}
                  model={null}
                  fast={null}
                  disabled={false}
                  session={target}
                  act={act}
                  request={pickerRequest}
                />
              }
            />
            {/* Where a session's status bar goes, so the box stays put once the session starts. */}
            <div aria-hidden="true" className="h-9 shrink-0" />
          </>
        ) : handedOff !== null ? (
          <>
            <HandedOff file={handedOff} onTakeBack={() => act(() => client.takeBack(sessionId))} />
            {notice}
          </>
        ) : (
          <SessionArea
            client={client}
            containerId={containerId}
            sessionId={sessionId}
            store={store}
            onSend={onSend}
            onSteer={onSteer}
            onBuiltin={runBuiltin}
            act={act}
            session={target}
            notice={notice}
            pickerRequest={pickerRequest}
            attaching={attaching}
            takesFocus={handing?.sessionId === sessionId}
            onFocusTaken={() => handTo(null)}
            changes={capsule}
            launch={launch}
          />
        )}
      </div>
      <ChangesPane client={client} workspaceId={workspaceId} panes={panes} views={views} />
    </div>
  );
}

/** No launches, where the new-workspace page is not given. */
const NO_LAUNCHES = createNewWorkspaceStore();
