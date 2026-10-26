import { type AtriumClient, CommandError, ConnectionLostError } from "@atrium/client";
import type { CommandResult } from "@atrium/protocol";
import { createContext, type ReactNode, use, useEffect, useRef, useState } from "react";
import { CircleNotch, Translate } from "../design/icons";
import { Markdown } from "./markdown";
import { providerOf } from "./model-choice";

/** The translation capability of the visible conversation. */
interface ReplyTranslationScope {
  /** Commands use the current host connection, not the conversation's agent run. */
  readonly client: AtriumClient;
  /** The conversation whose original reply the host must read. */
  readonly sessionId: string;
  /** The saved target language; changing it invalidates the current translation. */
  readonly language: string;
}

/** The visible conversation, or no translation capability outside it. */
export const ReplyTranslationContext = createContext<ReplyTranslationScope | null>(null);

/** An ephemeral translation, never stored with the conversation. */
type TranslationState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly problem: string }
  | { readonly status: "done"; readonly result: CommandResult<"translate_reply">; readonly open: boolean };

/** Why translation could not finish, without exposing the model's raw error. */
const FAILURE_TEXT: Readonly<Record<string, string>> = {
  no_model: "当前对话还没有可用的模型，请先选择模型",
  empty: "这条回复没有可翻译的正文",
  running: "这条回复还在输出，请等它结束后再翻译",
  too_large: "回复或译文太长，没能翻译",
  busy: "还有一条回复正在翻译，请先取消或等它结束",
  timed_out: "翻译超时了，可以重试",
  aborted: "翻译已取消，可以重试",
};

/**
 * Explains a translation failure without the source or model error.
 * @remarks The host sends codes; raw errors can contain the original reply.
 * @sideEffects none
 * @param error - The failed command.
 * @returns The reason to show beside retry.
 */
function translationProblem(error: unknown): string {
  if (error instanceof ConnectionLostError) return "与宿主的连接断开了，重新连接后可以重试";
  if (!(error instanceof CommandError)) return "没能翻译，请稍后重试";
  if (error.code === "translation_failed")
    return FAILURE_TEXT[String(error.params?.["reason"])] ?? "没能翻译，请稍后重试";
  if (error.code === "session_not_found") return "这个会话已经不存在了";
  if (error.code === "turn_not_found") return "找不到这条回复，请重新打开会话";
  if (error.code === "pi_unavailable") return "pi 暂时不可用，请在设置里检查";
  return "没能翻译，请稍后重试";
}

/**
 * Holds the translation control and result beside a reply footer.
 * @remarks Each exact session, turn, source and saved language has its own mounted lifetime.
 * Changing any one unmounts the old request before it can publish a result for the new reply.
 * Only this child is keyed: the original transcript and its reading position stay intact.
 * @sideEffects none; the mounted translation child sends and cancels commands.
 * @param props - The original reply, its id and footer renderer.
 * @returns The original footer and, when requested, its translation.
 */
export function ReplyTranslation({
  turnId,
  reply,
  children,
}: {
  readonly turnId: string;
  readonly reply: string | null;
  readonly children: (button: ReactNode) => ReactNode;
}) {
  const scope = use(ReplyTranslationContext);
  if (scope === null || reply === null || reply.trim() === "") return children(null);
  return (
    <Translation key={JSON.stringify([scope.sessionId, turnId, scope.language, reply])} scope={scope} turnId={turnId}>
      {children}
    </Translation>
  );
}

/**
 * Runs a single reply's translation and keeps its result only while mounted.
 * @remarks Prototype A leaves the original untouched. Collapsing retains the result, while
 * cancellation or unmount invalidates the request id before asking the host to stop it.
 * @sideEffects Sends translation and cancellation commands; cancels in-flight work on unmount.
 * @param props - The visible conversation, reply id, and renderer for the existing footer.
 * @returns The footer with its translation button and inline result or status.
 */
function Translation({
  scope,
  turnId,
  children,
}: {
  readonly scope: ReplyTranslationScope;
  readonly turnId: string;
  readonly children: (button: ReactNode) => ReactNode;
}) {
  const { client, sessionId, language } = scope;
  const [state, setState] = useState<TranslationState>({ status: "idle" });
  const inFlight = useRef<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const id = inFlight.current;
      inFlight.current = null;
      if (id !== null) {
        // Fire and forget: disconnected hosts also cancel; an unmounted reply has no error surface.
        void client.cancelTranslation(id).catch(() => undefined);
      }
    };
  }, [client]);

  /**
   * Requests a translation, or reopens a completed one without another request.
   * @remarks A unique id prevents a late completion from reviving cancelled content.
   * @sideEffects Sends a command and updates the local translation state.
   */
  async function translate(): Promise<void> {
    if (state.status === "done") {
      setState({ ...state, open: !state.open });
      return;
    }
    if (inFlight.current !== null) return;
    const id = crypto.randomUUID();
    generation.current += 1;
    inFlight.current = id;
    setState({ status: "loading" });
    try {
      const result = await client.translateReply(sessionId, turnId, id);
      if (mounted.current && inFlight.current === id) setState({ status: "done", result, open: true });
    } catch (error) {
      if (mounted.current && inFlight.current === id)
        setState({ status: "failed", problem: translationProblem(error) });
    } finally {
      if (inFlight.current === id) inFlight.current = null;
    }
  }

  /**
   * Invalidates the visible request before asking the host to cancel it.
   * @remarks The cancelled command may still answer, but its id no longer owns the reply.
   * @sideEffects Sends cancellation, changes local state and restores the translation button's focus.
   */
  async function cancel(): Promise<void> {
    const id = inFlight.current;
    const cancelledGeneration = ++generation.current;
    inFlight.current = null;
    setState({ status: "idle" });
    trigger.current?.focus();
    if (id === null) return;
    try {
      await client.cancelTranslation(id);
    } catch (error) {
      // A disconnected host aborts this connection's translations without another acknowledgement.
      if (error instanceof ConnectionLostError) return;
      if (mounted.current && generation.current === cancelledGeneration) {
        setState({ status: "failed", problem: "没能确认翻译已取消，请稍后重试" });
      }
    }
  }

  const button = (
    <button
      ref={trigger}
      type="button"
      aria-label="翻译回复"
      aria-expanded={state.status === "done" && state.open}
      title={`使用本对话当前模型翻译成${language}，会消耗模型额度`}
      aria-disabled={state.status === "loading"}
      onClick={() => void translate()}
      className="atrium-press-sm inline-flex items-center gap-1 rounded-[var(--r)] px-1.5 py-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)] aria-disabled:cursor-default aria-disabled:opacity-50"
    >
      <Translate size={14} />
      <span>
        {state.status === "loading"
          ? "翻译中…"
          : state.status === "done"
            ? state.open
              ? "已翻译"
              : "显示译文"
            : "翻译"}
      </span>
    </button>
  );
  return (
    <>
      {children(button)}
      {state.status === "loading" ? (
        <div
          role="status"
          className="mt-3 flex items-center gap-2 text-[length:var(--fs-meta)] text-[var(--text-muted)]"
        >
          <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" />
          正在翻译成{language}
          <button
            type="button"
            onClick={() => void cancel()}
            className="rounded-[var(--r)] px-1.5 py-1 text-[var(--tint)] hover:bg-[var(--hover)]"
          >
            取消
          </button>
        </div>
      ) : null}
      {state.status === "failed" ? (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-2 text-[length:var(--fs-meta)] text-[var(--text-muted)]"
        >
          <span>{state.problem}</span>
          <button
            type="button"
            onClick={() => void translate()}
            className="rounded-[var(--r)] px-1.5 py-1 text-[var(--tint)] hover:bg-[var(--hover)]"
          >
            重试
          </button>
        </div>
      ) : null}
      {state.status === "done" && state.open ? (
        <section
          aria-label="回复译文"
          data-testid="reply-translation"
          className="mt-[19px] border-t border-[var(--line)] pt-[17px]"
        >
          <div className="mb-3 flex min-w-0 items-center gap-2 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
            <Translate size={14} />
            <span className="min-w-0 flex-1 break-words">
              {state.result.language} · {providerOf(state.result.model.providerId).name} / {state.result.model.modelId}
            </span>
            <button
              type="button"
              className="shrink-0 rounded-[var(--r)] px-1.5 py-1 hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
              onClick={() => {
                setState({ ...state, open: false });
                trigger.current?.focus();
              }}
            >
              收起译文
            </button>
          </div>
          <div className="text-[length:var(--fs-reply)] leading-[var(--lh-reply)] text-[var(--text)]">
            <Markdown text={state.result.text} streaming={false} />
          </div>
        </section>
      ) : null}
    </>
  );
}
