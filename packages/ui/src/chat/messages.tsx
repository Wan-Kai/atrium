import { Check, Copy, PencilSimple } from "../design/icons";
import { useClock } from "../state/clock";
import { CommandTag } from "./command-tag";
import { type ChosenCommand, writtenCommand } from "./composer-text";
import { MessageThumbnails } from "./message-images";
import { useEffect, useRef, useState } from "react";

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
export function timeOfDay(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * A small icon button that copies text.
 *
 * @remarks
 * Copying uses the full text, never the part the reveal has shown so far (SPEC-0001, "平滑流式输出").
 * Once copied, the icon is a check and the hover text "已复制" for 2 seconds, as a code block's
 * copy says so (SPEC-0001, "消息下方的信息"); a refused clipboard says nothing.
 *
 * @sideEffects Writes to the clipboard when clicked; sets a timer while it shows the check.
 * @param props - What to copy, read when clicked, and the button's name.
 * @returns The button.
 */
export function CopyButton({ text, label = "复制" }: { readonly text: () => string; readonly label?: string }) {
  const clock = useClock();
  const [copied, setCopied] = useState(0);
  useEffect(() => (copied === 0 ? undefined : clock.after(COPIED_MS, () => setCopied(0))), [clock, copied]);
  return (
    <button
      type="button"
      aria-label={label}
      title={copied === 0 ? label : "已复制"}
      data-copied={copied !== 0}
      className="atrium-press-sm rounded-[var(--r)] p-1 text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)]"
      onClick={() => {
        // Fire and forget: a refused clipboard simply copies nothing, and says nothing.
        void navigator.clipboard.writeText(text()).then(
          () => setCopied((times) => times + 1),
          () => undefined,
        );
      }}
    >
      {copied === 0 ? <Copy size={14} /> : <Check size={14} className="text-[var(--ok-text)]" />}
    </button>
  );
}

/** How long a copy button shows its check (design-language, "动效 · 复制成功"). */
const COPIED_MS = 2000;

/** Props of {@link UserBubble}. */
export interface UserBubbleProps {
  readonly text: string;
  /** How many images came with it. */
  readonly images?: number;
  /** The turn it opened; absent while it is pending. */
  readonly turnId?: string;
  /** Its id from this page, if it was sent from here. */
  readonly clientMessageId?: string | null;
  /** Whether its turn has ended. */
  readonly settled?: boolean;
  /** When the host confirmed it; absent while it is still pending. */
  readonly timestamp?: number;
  /** The host sent it to have the agent go on (SPEC-0001, "运行控制"). */
  readonly auto?: boolean;
  /** The command it started with, shown as a tag before the text. */
  readonly command?: ChosenCommand | null;
  /** Whether it has not gone yet, as a new workspace's first message while its steps go on. */
  readonly dim?: boolean;
  /** Words in its time's place, as why a new workspace's first message did not go. */
  readonly note?: string | null;
  /** The last stopped ordinary message's editor, unavailable while the session is busy. */
  readonly edit?: { readonly blocked: boolean; readonly open: () => void } | undefined;
}

/**
 * A message the user sent: a right-aligned bubble, with its time and a copy button below.
 *
 * @remarks
 * Shown at once when sent and replaced by the confirmed copy (domain-model §7); a pending one
 * has no time yet. Bubble on `--surface-2` with radius 22 (design-language, "消息流"). A message
 * longer than about 12 lines is folded, with "展开" at its end (SPEC-0001, "消息下方的信息");
 * its images show as thumbnails above it. One the host sent on its own after an interrupted run
 * says so under it, "系统自动发出". One that started with a command starts with its tag, and is
 * copied as typed, `/名字 参数` (SPEC-0001, "M1.11 的 `/` 命令"). A new workspace's first message
 * shows at 60% until it has gone, then comes up in 0.2 s; its time comes in once it has, and a
 * note can stand in the time's place, the row's height the same (design-language, "新建工作区页").
 *
 * @sideEffects Observes the bubble's size while folded to know whether it overflows.
 * @param props - The text, images and, once confirmed, its time and turn; whether it has not gone
 * yet, and a note.
 * @returns The bubble.
 */
export function UserBubble({
  text,
  images = 0,
  timestamp,
  auto = false,
  turnId,
  clientMessageId = null,
  settled = false,
  command = null,
  dim = false,
  note = null,
  edit,
}: UserBubbleProps) {
  const body = useRef<HTMLDivElement>(null);
  // A time that comes in while shown fades in; one there from the start just shows.
  const [timed] = useState(timestamp !== undefined);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = body.current;
    if (element === null || expanded) return undefined;
    // The bubble resizes whenever its text or the width it wraps to changes.
    const observer = new ResizeObserver(() => setOverflows(element.scrollHeight > element.clientHeight + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);
  return (
    <div className="flex flex-col items-end gap-1" data-testid="user-message" data-pending={timestamp === undefined}>
      {images === 0 ? null : (
        <div className={`transition-opacity duration-200 ${dim ? "opacity-60" : ""}`} data-testid="user-images">
          <MessageThumbnails
            count={images}
            turnId={turnId ?? null}
            clientMessageId={clientMessageId}
            settled={settled}
          />
        </div>
      )}
      <div
        className={`flex max-w-[80%] flex-col items-start rounded-[var(--r-bubble)] bg-[var(--surface-2)] px-4 py-2.5 transition-opacity duration-200 ${
          dim ? "opacity-60" : ""
        }`}
        data-testid="user-bubble"
      >
        <div
          ref={body}
          data-testid="user-text"
          className={`whitespace-pre-wrap wrap-anywhere text-[var(--text)] ${expanded ? "" : "line-clamp-12"}`}
        >
          {command === null ? null : <CommandTag command={command} />}
          {text}
        </div>
        {overflows || expanded ? (
          <button
            type="button"
            className="atrium-press mt-1 text-[length:var(--fs-sm)] text-[var(--tint)]"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "收起" : "展开"}
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-1 text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums">
        {auto ? <span>系统自动发出 ·</span> : null}
        {note === null ? null : <span data-testid="user-note">{note}</span>}
        {timestamp === undefined || note !== null ? null : (
          <span className={timed ? "" : "atrium-meta-in"} data-testid="user-time">
            {timeOfDay(timestamp)}
          </span>
        )}
        <CopyButton text={() => writtenCommand(command, text)} />
        {edit === undefined ? null : (
          <button
            type="button"
            aria-label="编辑已停止消息"
            title={edit.blocked ? "先等当前操作结束" : "编辑"}
            disabled={edit.blocked}
            onClick={edit.open}
            className="atrium-press-sm rounded-[var(--r)] p-1 text-[var(--text-dim)] enabled:hover:bg-[var(--hover)] enabled:hover:text-[var(--text-muted)] disabled:opacity-40"
          >
            <PencilSimple size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
