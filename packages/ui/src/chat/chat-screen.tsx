import { type AtriumClient, CommandError, ConnectionLostError, type SessionView } from "@atrium/client";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { useDisplayMode } from "../state/display-mode";
import { Composer } from "./composer";
import { RecentSessions } from "./recent-sessions";
import { SessionToolbar } from "./session-toolbar";
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
 * @param props - The client, the session, its view store, what to do with a message, how to go
 * back to the recent sessions, and a notice to show above the input box.
 * @returns The transcript and input box.
 */
function SessionArea({
  client,
  sessionId,
  store,
  onSend,
  onClose,
  notice,
}: {
  readonly client: AtriumClient;
  readonly sessionId: string;
  readonly store: StoreApi<SessionView>;
  readonly onSend: (text: string) => void;
  readonly onClose: () => void;
  readonly notice: ReactNode;
}) {
  const view = useStore(store);
  return (
    <>
      <SessionToolbar client={client} sessionId={sessionId} onClose={onClose} />
      <Transcript
        view={view}
        onLoadOlder={() => {
          // Fire and forget: a failed page leaves "正在加载" until the next scroll asks again.
          client.loadOlder(sessionId).catch(() => undefined);
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
function useDisplayModeShortcut(): void {
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
 * The conversation screen until M1.5: one session, its transcript and the input box.
 *
 * @remarks
 * The sidebar and tabs come with M1.5. With no session open the recent sessions are listed, and
 * choosing one opens it (SPEC-0001, "打开历史会话"); the first message instead creates a chat,
 * as typing into an empty conversation area does (SPEC-0001, "标签栏"), and later messages go to
 * it. A second message sent while the chat is still being created waits for that chat instead of
 * creating another. Once the session's pi has exited or the host restarted without it, the next
 * message starts a new chat (SPEC-0001, "事件"). A failed send or open is explained above the
 * input box.
 *
 * @sideEffects Lists, opens and creates sessions, watches them and sends messages through the client.
 * @param props - The client.
 * @returns The screen.
 */
export function ChatScreen({ client }: { readonly client: AtriumClient }) {
  useDisplayModeShortcut();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The chat being created, shared by every send until it exists; only read in event handlers.
  const creating = useRef<Promise<string> | null>(null);
  const store = sessionId === null ? undefined : client.session(sessionId);

  /**
   * Creates a chat and starts watching it.
   *
   * @remarks
   * See `ChatScreen`.
   *
   * @sideEffects Sends `create_chat` and `subscribe_sessions`; shows the new chat.
   * @returns The new chat's session id.
   */
  async function createChat(): Promise<string> {
    const { sessionId: created } = await client.createChat();
    await client.watch([created]);
    setSessionId(created);
    return created;
  }

  /**
   * Picks the chat a message goes to, creating one when there is none that can take it.
   *
   * @remarks
   * Reads the current view's status at send time, not from the last render.
   *
   * @sideEffects May create a chat.
   * @returns The session id to send to.
   */
  async function target(): Promise<string> {
    const status = sessionId === null ? undefined : client.session(sessionId)?.getState().status;
    if (sessionId !== null && status !== "exited" && status !== "lost") return sessionId;
    creating.current ??= createChat().finally(() => {
      creating.current = null;
    });
    return creating.current;
  }

  /**
   * Sends a message to the chat, creating it first when needed.
   *
   * @remarks
   * See `ChatScreen`.
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
   * Opens a session from the recent list and starts watching it.
   *
   * @remarks
   * Opening starts pi on the session's file unless it is open already (SPEC-0001, "打开历史会话");
   * a failure is explained above the input box.
   *
   * @sideEffects Sends `open_session` and `subscribe_sessions`; shows the session.
   * @param chosen - The session's id.
   */
  async function open(chosen: string): Promise<void> {
    setFailure(null);
    try {
      const { sessionId: opened } = await client.openSession(chosen);
      await client.watch([opened]);
      setSessionId(opened);
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
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RecentSessions
              client={client}
              onOpen={(chosen) => {
                // Fire and forget: `open` explains its own failures.
                void open(chosen);
              }}
            />
          </div>
          {notice}
          <Composer onSend={onSend} />
        </>
      ) : (
        <SessionArea
          client={client}
          sessionId={sessionId}
          store={store}
          onSend={onSend}
          onClose={() => {
            setSessionId(null);
            // Fire and forget: nothing is watched any more.
            client.watch([]).catch(() => undefined);
          }}
          notice={notice}
        />
      )}
    </div>
  );
}
