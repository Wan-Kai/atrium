import { type AtriumClient, CommandError, ConnectionLostError, type SessionView } from "@atrium/client";
import { useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { Composer } from "./composer";
import { Transcript } from "./transcript";

/** What to say when pi cannot be used, by the status the host found. */
const PI_STATUS_TEXT: Readonly<Record<string, string>> = {
  missing: "没有找到 pi，请先安装 pi",
  outdated: "pi 的版本过低，请先更新",
  unusable: "pi 无法运行，请在终端里检查 pi 能否启动",
  exited: "pi 启动后立即退出了，可能还没有登录模型服务",
};

/**
 * Explains why sending failed, in Chinese.
 *
 * @remarks
 * The host sends codes, never text (AGENTS.md); the wording lives here. `pi_unavailable` says
 * what was found, so the line can say what to do.
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
  if (error.code === "session_not_found") return "这个会话已经不存在了";
  return "宿主出错了，消息没有发出";
}

/**
 * A watched session's transcript, subscribed to its view store.
 *
 * @remarks
 * Split out so the store subscription exists only once there is a session.
 *
 * @sideEffects Subscribes to the session's store.
 * @param props - The session's view store.
 * @returns The transcript.
 */
function SessionTranscript({ store }: { readonly store: StoreApi<SessionView> }) {
  return <Transcript view={useStore(store)} />;
}

/**
 * M1.3's conversation screen: one chat, its transcript and the input box.
 *
 * @remarks
 * The sidebar and tabs come with M1.5; until then the first message creates a chat, as typing
 * into an empty conversation area does (SPEC-0001, "标签栏"), and later messages go to it. A
 * failed send is explained above the input box.
 *
 * @sideEffects Creates a chat, watches it and sends messages through the client.
 * @param props - The client.
 * @returns The screen.
 */
export function ChatScreen({ client }: { readonly client: AtriumClient }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const store = sessionId === null ? undefined : client.session(sessionId);

  /**
   * Sends a message, creating the chat first if there is none yet.
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
      let target = sessionId;
      if (target === null) {
        ({ sessionId: target } = await client.createChat());
        await client.watch([target]);
        setSessionId(target);
      }
      await client.prompt(target, text);
    } catch (error) {
      setFailure(describeSendError(error));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {store === undefined ? <div className="flex-1" /> : <SessionTranscript store={store} />}
      {failure === null ? null : (
        <p
          role="alert"
          className="mx-auto w-full max-w-[720px] px-6 pb-2 text-[length:var(--fs-meta)] text-[var(--danger)]"
        >
          {failure}
        </p>
      )}
      <Composer
        onSend={(text) => {
          // Fire and forget: `send` reports its own failures on screen.
          void send(text);
        }}
      />
    </div>
  );
}
