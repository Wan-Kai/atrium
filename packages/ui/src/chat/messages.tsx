import { Copy } from "../design/icons";
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
 *
 * @sideEffects Writes to the clipboard when clicked.
 * @param props - What to copy, read when clicked, and the button's name.
 * @returns The button.
 */
export function CopyButton({ text, label = "复制" }: { readonly text: () => string; readonly label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="rounded-[var(--r)] p-1 text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)]"
      onClick={() => {
        // Fire and forget: a refused clipboard simply copies nothing.
        void navigator.clipboard.writeText(text()).catch(() => undefined);
      }}
    >
      <Copy size={14} />
    </button>
  );
}

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
}

/**
 * A message the user sent: a right-aligned bubble, with its time and a copy button below.
 *
 * @remarks
 * Shown at once when sent and replaced by the confirmed copy (domain-model §7); a pending one
 * has no time yet. Bubble on `--surface-2` with radius 22 (design-language, "消息流"). A message
 * longer than about 12 lines is folded, with "展开" at its end (SPEC-0001, "消息下方的信息");
 * its images show as thumbnails above it. One the host sent on its own after an interrupted run
 * says so under it, "系统自动发出".
 *
 * @sideEffects Observes the bubble's size while folded to know whether it overflows.
 * @param props - The text, images and, once confirmed, its time and turn.
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
}: UserBubbleProps) {
  const body = useRef<HTMLDivElement>(null);
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
        <MessageThumbnails count={images} turnId={turnId ?? null} clientMessageId={clientMessageId} settled={settled} />
      )}
      <div className="flex max-w-[80%] flex-col items-start rounded-[var(--r-bubble)] bg-[var(--surface-2)] px-4 py-2.5">
        <div
          ref={body}
          data-testid="user-text"
          className={`break-words whitespace-pre-wrap text-[var(--text)] ${expanded ? "" : "line-clamp-12"}`}
        >
          {text}
        </div>
        {overflows || expanded ? (
          <button
            type="button"
            className="mt-1 text-[length:var(--fs-sm)] text-[var(--tint)]"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "收起" : "展开"}
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-1 text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums">
        {auto ? <span>系统自动发出 ·</span> : null}
        {timestamp === undefined ? null : <span>{timeOfDay(timestamp)}</span>}
        <CopyButton text={() => text} />
      </div>
    </div>
  );
}
