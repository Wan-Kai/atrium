import {
  type AtriumClient,
  type ChangesView,
  CommandError,
  ConnectionLostError,
  type SessionView,
} from "@atrium/client";
import type { DiffStat, SessionModel } from "@atrium/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { HandedOff } from "./handed-off";
import { type StoreApi, useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useDisplayMode } from "../state/display-mode";
import { desktopBridge } from "../app/bootstrap";
import { Composer, type ComposerProps, type SentImage } from "./composer";
import { pageDrafts } from "../state/use-draft";
import { historyOf } from "./composer-text";
import { ChangesPanel } from "./changes-panel";
import { shownModel } from "./model-choice";
import { ModelPicker } from "./model-picker";
import { ChangesTrack, ControlCards, ControlTrack, type RunActions } from "./run-control";
import { StatusBar } from "./status-bar";
import { Transcript } from "./transcript";

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
  if (error.code === "attachment_missing") return "图片已经过期，请重新添加";
  if (error.code === "attachment_limit") return "图片太多了：一次最多 20 张、共 32 MiB";
  if (error.code === "session_stopping") return "正在等 pi 停下，停下后再发";
  if (error.code === "queue_item_not_found") return "这条排队的消息已经发出或删掉了";
  if (error.code === "interaction_closed") return "这个问题已经回答过、超时或作废了";
  return "宿主出错了，消息没有发出";
}

/**
 * Explains why a model or thinking level could not be set, in Chinese.
 *
 * @remarks
 * As `describeSendError`, but pi refusing names what it refused.
 *
 * @sideEffects none
 * @param error - What the command rejected with.
 * @returns The sentence to show.
 */
export function describeModelError(error: unknown): string {
  if (error instanceof CommandError && error.code === "pi_rejected") {
    return `pi 没有接受这个设置：${String(error.params?.["detail"] ?? "")}`;
  }
  return describeSendError(error);
}

/** Runs a command, showing why it failed if it does, in the words `describe` picks. */
type Act = (command: () => Promise<unknown>, describe?: (error: unknown) => string) => void;

/**
 * The model button for the session shown, or for the one the next message creates.
 *
 * @remarks
 * SPEC-0001 ("模型与输入框"): the container's model list, which the area asks for when it
 * shows, is asked for again when the panel opens, and the host answers from its cache; "刷新"
 * makes pi look again. Before a session exists, the button shows the model a new session
 * will start on, and choosing creates the session first, as sending does.
 *
 * @sideEffects Subscribes to the container's models and to the preferences; asks for the models
 * when the panel opens; sends model commands through `act`.
 * @param props - The client, the container, the session's model, whether it is disabled, the
 * session to change, and how to run a command.
 * @returns The button.
 */
function SessionModelPicker({
  client,
  containerId,
  model,
  disabled,
  session,
  act,
}: {
  readonly client: AtriumClient;
  readonly containerId: string | null;
  readonly model: SessionModel | null;
  readonly disabled: boolean;
  readonly session: () => Promise<string>;
  readonly act: Act;
}) {
  const key = containerId ?? "chats";
  const list = useStore(client.models(key));
  const preferences = useStore(client.index, (index) => index.preferences);
  return (
    <ModelPicker
      shown={shownModel(model, preferences, list)}
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
    />
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
 * the groups chosen in the global preferences (SPEC-0001, "状态栏").
 *
 * @sideEffects Subscribes to the session's store and the preferences; loads older items when
 * asked; sends run control commands and status bar choices, reporting their failures through `act`.
 * @param props - The client, the session, its view store, what to do with a message and a steer,
 * how to run a command whose failure should show, and a notice to show above the input box.
 * @returns The transcript and input box.
 */
function SessionArea({
  client,
  containerId,
  sessionId,
  store,
  onSend,
  onSteer,
  act,
  session,
  notice,
  attaching,
  takesFocus,
  onFocusTaken,
  changes,
}: {
  readonly client: AtriumClient;
  readonly containerId: string | null;
  readonly sessionId: string;
  readonly store: StoreApi<SessionView>;
  readonly onSend: (text: string, images: readonly SentImage[]) => void;
  readonly onSteer: (text: string, images: readonly SentImage[]) => void;
  readonly act: Act;
  readonly session: () => Promise<string>;
  readonly notice: ReactNode;
  /** The composer's ways to add images and reference dropped files, for the session's model. */
  readonly attaching: (model: SessionModel | null) => Partial<ComposerProps>;
  /** Whether the box takes the focus, as for a session just created from the empty state. */
  readonly takesFocus: boolean;
  /** The box has taken the focus, which it does only once. */
  readonly onFocusTaken: () => void;
  /** The workspace's git changes for the capsule, when it has some, and the changes panel. */
  readonly changes: { readonly stat: DiffStat; readonly open: boolean; readonly onToggle: () => void } | undefined;
}) {
  const view = useStore(store);
  const statusBar = useStore(client.index, (index) => index.preferences.statusBar);
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
      />
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
        onStop={() => act(() => client.stop(sessionId))}
        running={running}
        stopping={view.control.stopping}
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
            disabled={view.control.stopping}
            session={session}
            act={act}
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
 * Switches the display mode with Ctrl+O.
 *
 * @remarks
 * "用 Ctrl+O 切换" (SPEC-0001, "显示模式"); Ctrl, not ⌘, as in Claude Code.
 *
 * @sideEffects Listens for keys on the window while mounted.
 */
export function useDisplayModeShortcut(): void {
  const cycle = useDisplayMode().cycle;
  useEffect(() => {
    /**
     * Cycles the mode on Ctrl+O alone.
     *
     * @remarks
     * See `useDisplayModeShortcut`.
     *
     * @sideEffects May change the display mode; stops the browser's own handling of the key.
     * @param event - The key event.
     */
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== "o") return;
      event.preventDefault();
      cycle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle]);
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
 * message goes back into its box when the box is still empty. The empty
 * state's layout and logo are placeholders until designed (roadmap, "MVP 1 里还没设计").
 *
 * @sideEffects Watches the active session; creates and opens sessions and sends messages
 * through the client.
 * @param props - The client, the container, its active session, and how to create a session.
 * @returns The area.
 */
export function ConversationArea({
  client,
  containerId,
  sessionId,
  create,
}: {
  readonly client: AtriumClient;
  readonly containerId: string | null;
  readonly sessionId: string | null;
  /** Creates a session where the client is and returns its id. */
  readonly create: () => Promise<string>;
}) {
  const [failure, setFailure] = useState<string | null>(null);
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
    if (connection !== null) void client.loadModels(containerId ?? "chats");
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
  const containerKey = containerId ?? "chats";
  /** The workspace shown, whose git changes the capsule and panel show; `null` for the chats. */
  const workspaceId = containerId === null || containerId === "chats" ? null : containerId;
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
  /** The workspace whose changes panel is open; going to another container closes it. */
  const [panelFor, setPanelFor] = useState<string | null>(null);
  const [panelShownIn, setPanelShownIn] = useState(workspaceId);
  if (panelShownIn !== workspaceId) {
    setPanelShownIn(workspaceId);
    setPanelFor(null);
  }
  const panelOpen = panelFor !== null && panelFor === workspaceId;
  /** The capsule's counts and toggle, when the workspace has changes to show. */
  const capsule =
    workspaceId === null || changes === null || changes.stat === null
      ? undefined
      : { stat: changes.stat, open: panelOpen, onToggle: () => setPanelFor(panelOpen ? null : workspaceId) };
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
          pageDrafts().handOver(`new:${containerId ?? "chats"}`, id);
          handTo({ container: containerId ?? "chats", sessionId: id });
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
   * @param steer - Whether to send it as a steer.
   */
  async function send(text: string, images: readonly SentImage[], steer = false): Promise<void> {
    setFailure(null);
    let id: string | null = null;
    let latest = images;
    try {
      id = await target();
      const to = id;
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
      const deliver = (ids: readonly string[]) => (steer ? client.steer(to, text, ids) : client.prompt(to, text, ids));
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
   */
  const onSend = (text: string, images: readonly SentImage[]): void => {
    // Fire and forget: see above.
    void send(text, images);
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
   */
  const onSteer = (text: string, images: readonly SentImage[]): void => {
    // Fire and forget: `send` reports its own failures.
    void send(text, images, true);
  };

  const modelList = useStore(client.models(containerKey));
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
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {store === undefined || sessionId === null ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 text-[var(--text-muted)]">
              <p className="text-[20px] font-medium text-[var(--text)]">
                {containerId === null ? "开始一段对话" : containerId === "chats" ? "新对话" : "新会话"}
              </p>
              <p className="text-[length:var(--fs-meta)]">
                {containerId === "chats" || containerId === null
                  ? "不绑定项目和工作区，直接输入就开始"
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
              onEdit={onEmptyEdit}
              above={capsule === undefined ? undefined : <ChangesTrack changes={capsule} />}
              picker={
                <SessionModelPicker
                  client={client}
                  containerId={containerId}
                  model={null}
                  disabled={false}
                  session={target}
                  act={act}
                />
              }
            />
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
            act={act}
            session={target}
            notice={notice}
            attaching={attaching}
            takesFocus={handing?.sessionId === sessionId}
            onFocusTaken={() => handTo(null)}
            changes={capsule}
          />
        )}
      </div>
      {workspaceId !== null && panelOpen ? (
        <ChangesPanel client={client} workspaceId={workspaceId} onClose={() => setPanelFor(null)} />
      ) : null}
    </div>
  );
}

/** The changes of no workspace, for the chats. */
const NO_CHANGES = createStore<ChangesView>(() => null);
