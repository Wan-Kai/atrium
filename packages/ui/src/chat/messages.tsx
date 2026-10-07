import type { AssistantBlock, TranscriptMessage } from "@atrium/protocol";
import { CaretDown, CaretRight, Copy } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { Markdown } from "./markdown";
import { useRevealedText } from "./use-revealed-text";

/**
 * Formats a time as hours and minutes.
 *
 * @remarks
 * Message times are shown as "22:31" (SPEC-0001, "消息下方的信息").
 *
 * @sideEffects none
 * @param timestamp - Milliseconds since the epoch.
 * @returns The time of day.
 */
function timeOfDay(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * A small icon button that copies text.
 *
 * @remarks
 * Copying uses the full text, never the part the reveal has shown so far (SPEC-0001, "平滑流式输出").
 *
 * @sideEffects Writes to the clipboard when clicked.
 * @param props - The text to copy.
 * @returns The button.
 */
function CopyButton({ text }: { readonly text: string }) {
  return (
    <button
      type="button"
      aria-label="复制"
      className="rounded-[var(--r)] p-1 text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)]"
      onClick={() => {
        // Fire and forget: a refused clipboard simply copies nothing.
        void navigator.clipboard.writeText(text).catch(() => undefined);
      }}
    >
      <Copy size={14} />
    </button>
  );
}

/** Props of {@link UserBubble}. */
export interface UserBubbleProps {
  readonly text: string;
  /** When the host confirmed it; absent while it is still pending. */
  readonly timestamp?: number;
}

/**
 * A message the user sent: a right-aligned bubble, with its time and a copy button below.
 *
 * @remarks
 * Shown at once when sent and replaced by the confirmed copy (domain-model §7); a pending one
 * has no time yet. Bubble on `--surface-2` with radius 22 (design-language, "消息流").
 *
 * @sideEffects none
 * @param props - The text and, once confirmed, its time.
 * @returns The bubble.
 */
export function UserBubble({ text, timestamp }: UserBubbleProps) {
  return (
    <div className="flex flex-col items-end gap-1" data-testid="user-message" data-pending={timestamp === undefined}>
      <div className="max-w-[80%] rounded-[var(--r-bubble)] bg-[var(--surface-2)] px-4 py-2.5 break-words whitespace-pre-wrap text-[var(--text)]">
        {text}
      </div>
      <div className="flex items-center gap-1 text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums">
        {timestamp === undefined ? null : <span>{timeOfDay(timestamp)}</span>}
        <CopyButton text={text} />
      </div>
    </div>
  );
}

/**
 * Reasoning: open while it streams, folded into one line afterwards.
 *
 * @remarks
 * In the default summary mode reasoning shows live during the run and collapses when the reply
 * is done (SPEC-0001, "显示模式"); the other modes come with M1.4.
 *
 * @sideEffects none
 * @param props - The reasoning text and whether it is still streaming.
 * @returns The reasoning section.
 */
function Reasoning({ text, streaming }: { readonly text: string; readonly streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = useRevealedText(text, streaming);
  const expanded = streaming || open;
  return (
    <div className="text-[var(--text-muted)]" data-testid="reasoning">
      <button
        type="button"
        className="flex items-center gap-1 text-[length:var(--fs-meta)] hover:text-[var(--text-3)]"
        aria-expanded={expanded}
        onClick={() => setOpen(!open)}
      >
        {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <span>{streaming ? "思考中" : "思考过程"}</span>
      </button>
      {expanded ? (
        <div className="mt-1 border-l-2 border-[var(--line)] pl-3 opacity-90">
          <Markdown text={shown} streaming={streaming} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A text block of a reply, revealed smoothly while it streams.
 *
 * @remarks
 * Split out so each block runs its own reveal.
 *
 * @sideEffects none
 * @param props - The text and whether it is still streaming.
 * @returns The rendered block.
 */
function ReplyText({ text, streaming }: { readonly text: string; readonly streaming: boolean }) {
  return <Markdown text={useRevealedText(text, streaming)} streaming={streaming} />;
}

/** Props of {@link AssistantReply}. */
export interface AssistantReplyProps {
  readonly content: readonly AssistantBlock[];
  /** Still streaming; the finished message replaces it. */
  readonly streaming: boolean;
  /** The finished message's details, once there are some. */
  readonly finished?: Extract<TranscriptMessage, { role: "assistant" }>;
}

/**
 * An assistant reply: its reasoning, its text, and below it a copy button and the time.
 *
 * @remarks
 * A failed reply shows pi's own error text, which is raw output the UI only displays; a stopped
 * one is marked as such and keeps what it wrote (SPEC-0001, "运行出错与停止").
 *
 * @sideEffects none
 * @param props - The blocks, whether they still stream, and the finished message.
 * @returns The reply.
 */
export function AssistantReply({ content, streaming, finished }: AssistantReplyProps) {
  const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
  let notice: ReactNode = null;
  if (finished?.stopReason === "error") {
    notice = (
      <p className="text-[length:var(--fs-meta)] text-[var(--danger)]" data-testid="reply-error">
        回复出错{finished.errorMessage === null ? "" : `：${finished.errorMessage}`}
      </p>
    );
  } else if (finished?.stopReason === "aborted") {
    notice = <p className="text-[length:var(--fs-meta)] text-[var(--text-dim)]">已停止</p>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="assistant-message" data-streaming={streaming}>
      {content.map((block, index) =>
        block.type === "reasoning" ? (
          // Blocks never move once streamed, so their position is a stable key.
          // oxlint-disable-next-line react/no-array-index-key -- see above.
          <Reasoning key={index} text={block.text} streaming={streaming} />
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- see above.
          <ReplyText key={index} text={block.text} streaming={streaming} />
        ),
      )}
      {notice}
      {streaming || text === "" ? null : (
        <div className="flex items-center gap-1 text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums">
          <CopyButton text={text} />
          {finished === undefined ? null : <span>{timeOfDay(finished.timestamp)}</span>}
        </div>
      )}
    </div>
  );
}
