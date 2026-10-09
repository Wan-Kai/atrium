import { ArrowUp, Square } from "@phosphor-icons/react";
import { type KeyboardEvent, type ReactNode, useState } from "react";

/** Props of {@link Composer}. */
export interface ComposerProps {
  /** Sends a message; while a run goes on, the host queues it. */
  readonly onSend: (text: string) => void;
  /** Sends a steer (⌘+Enter); without it ⌘+Enter sends as Enter does. */
  readonly onSteer?: (text: string) => void;
  /** Stops the run (the button while running, and Esc). */
  readonly onStop?: () => void;
  /** Whether a run goes on: the button stops, Enter queues and ⌘+Enter steers. */
  readonly running?: boolean;
  /** Whether a stop waits for pi to confirm. */
  readonly stopping?: boolean;
  /** What floats above the box: the capsule bar and its panels. */
  readonly above?: ReactNode;
}

/**
 * The input box: type a message, Enter sends it, Shift+Enter starts a new line.
 *
 * @remarks
 * SPEC-0001 ("输入框", "运行中输入"): rounded 22 card with 14 px padding, the send button a dark
 * filled circle when there is text and pale when empty. Enter while an input method is composing
 * only picks a candidate (`isComposing`). While a run goes on the button is "停止" and Esc stops
 * too; Enter puts the message in the queue and ⌘+Enter sends it as a steer, which the hint under
 * the box says. While a stop waits for pi the button shows "停止中" and nothing is sent; the text
 * stays in the box. Models,
 * attachments, `@` and `/` come with M1.7.
 *
 * @sideEffects Calls `onSend`, `onSteer` or `onStop` as the user acts.
 * @param props - What to do with a message, a steer and a stop, whether a run goes on or is
 * stopping, and what floats above.
 * @returns The input box.
 */
export function Composer({ onSend, onSteer, onStop, running = false, stopping = false, above }: ComposerProps) {
  const [text, setText] = useState("");
  const empty = text.trim() === "";

  /**
   * Sends the text as a message or a steer, unless there is none, and clears the box.
   *
   * @remarks
   * Shared by the keys and the send button.
   *
   * @sideEffects Calls `onSend` or `onSteer`; clears the input.
   * @param steer - Whether to send it as a steer.
   */
  const send = (steer: boolean): void => {
    // A message sent while a stop waits for pi would be refused; the text stays to send later.
    if (empty || stopping) return;
    (steer ? (onSteer ?? onSend) : onSend)(text);
    setText("");
  };

  /**
   * Sends on Enter, steers on ⌘+Enter, stops on Esc while running.
   *
   * @remarks
   * See `Composer`.
   *
   * @sideEffects May send or stop.
   * @param event - The key event.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && running && !stopping) {
      event.preventDefault();
      onStop?.();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send(event.metaKey);
  };

  return (
    <div className="mx-auto w-full max-w-[720px] px-6 pb-6">
      <div className="relative">
        {above}
        <div className="flex items-end gap-2 rounded-[var(--r-bubble)] bg-[var(--surface-1)] p-[14px] shadow-[inset_0_0_0_0.5px_var(--line),0_9px_27px_rgba(41,70,122,0.08)]">
          <textarea
            aria-label="消息"
            rows={1}
            value={text}
            placeholder="发消息或描述任务"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            className="max-h-60 min-h-6 flex-1 resize-none bg-transparent text-[var(--text)] outline-none [field-sizing:content] placeholder:text-[var(--text-dim)]"
          />
          {running ? (
            <button
              type="button"
              aria-label={stopping ? "停止中" : "停止"}
              disabled={stopping}
              onClick={() => onStop?.()}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--text)] text-[var(--main)] disabled:opacity-50"
            >
              <Square size={12} weight="fill" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="发送"
              disabled={empty || stopping}
              onClick={() => send(false)}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--text)] text-[var(--main)] disabled:bg-[var(--surface-3)] disabled:text-[var(--text-dim)]"
            >
              <ArrowUp size={16} weight="bold" />
            </button>
          )}
        </div>
      </div>
      {running ? (
        <p className="mt-1.5 text-center text-[length:var(--fs-sm)] text-[var(--text-dim)]">
          {stopping ? "正在停止…" : "回车排队 · ⌘回车插话 · Esc 停止"}
        </p>
      ) : null}
    </div>
  );
}
