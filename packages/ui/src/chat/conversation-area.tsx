import { type AtriumClient, CommandError, ConnectionLostError, type SessionView } from "@atrium/client";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { useDisplayMode } from "../state/display-mode";
import { Composer } from "./composer";
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
  return "宿主出错了，消息没有发出";
}

/**
 * The transcript and the input box of a session, subscribed to its view.
 *
 * @remarks
 * Split out so the store subscription exists only once there is a session. Sending is blocked
 * while a run is in progress (SPEC-0001, "M1.3 先做的部分").
 *
 * @sideEffects Subscribes to the session's store; loads older items when asked.
 * @param props - The client, the session, its view store, what to do with a message, and a
 * notice to show above the input box.
 * @returns The transcript and input box.
 */
function SessionArea({
  client,
  sessionId,
  store,
  onSend,
  notice,
}: {
  readonly client: AtriumClient;
  readonly sessionId: string;
  readonly store: StoreApi<SessionView>;
  readonly onSend: (text: string) => void;
  readonly notice: ReactNode;
}) {
  const view = useStore(store);
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
      />
      {notice}
      <Composer onSend={onSend} disabled={view.run !== null} />
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
 * The active session is watched while it shows. With no session open, typing into the input box
 * creates one where the client is, a chat when it is nowhere yet, and sends the message to it
 * (SPEC-0001, "标签栏"); a second message sent while it is being created waits for it instead of
 * creating another, while one sent after moving to another container starts its own there. The
 * active session is opened whenever it shows, which starts a pi that is not running (as after a
 * restart) and explains here why it cannot. A session whose pi has exited, or that the host lost
 * in a restart, is opened again before the message goes. A failed send is explained above the input box. The empty
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
    if (sessionId === null) {
      // Per container: a message sent in another one must not wait for, or go to, this session.
      const key = containerId ?? "";
      const going = creating.current.get(key);
      if (going !== undefined) return going;
      const created = create()
        .then(async (id) => {
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
   * Sends a message, creating or reopening its session first when needed.
   *
   * @remarks
   * See `ConversationArea`.
   *
   * @sideEffects Sends commands; updates component state.
   * @param text - The message.
   */
  async function send(text: string): Promise<void> {
    setFailure(null);
    try {
      await client.prompt(await target(), text);
    } catch (error) {
      setFailure(describeSendError(error));
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
   */
  const onSend = (text: string): void => {
    // Fire and forget: see above.
    void send(text);
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
    <div className="flex min-h-0 flex-1 flex-col">
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
          <Composer onSend={onSend} />
        </>
      ) : (
        <SessionArea client={client} sessionId={sessionId} store={store} onSend={onSend} notice={notice} />
      )}
    </div>
  );
}
