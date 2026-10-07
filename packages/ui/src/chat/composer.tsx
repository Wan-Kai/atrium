import { ArrowUp } from "@phosphor-icons/react";
import { type KeyboardEvent, useState } from "react";

/**
 * The input box: type a message, Enter sends it, Shift+Enter starts a new line.
 *
 * @remarks
 * M1.3's minimal form of the input box (SPEC-0001, "输入框"): rounded 22 card with 14 px padding,
 * the send button a dark filled circle when there is text and pale when empty. Enter while an
 * input method is composing only picks a candidate (`isComposing`). Models, attachments, `@` and
 * `/` come with M1.6.
 *
 * @sideEffects Calls `onSend` with the text when the user sends.
 * @param props - What to do with a message.
 * @returns The input box.
 */
export function Composer({ onSend }: { readonly onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const empty = text.trim() === "";

  /**
   * Sends the text, unless there is none, and clears the box.
   *
   * @remarks
   * Shared by Enter and the send button.
   *
   * @sideEffects Calls `onSend`; clears the input.
   */
  const send = (): void => {
    if (empty) return;
    onSend(text);
    setText("");
  };

  /**
   * Sends on Enter, except with Shift or while composing.
   *
   * @remarks
   * See `Composer`.
   *
   * @sideEffects May send.
   * @param event - The key event.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  return (
    <div className="mx-auto w-full max-w-[720px] px-6 pb-6">
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
        <button
          type="button"
          aria-label="发送"
          disabled={empty}
          onClick={send}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--text)] text-[var(--main)] disabled:bg-[var(--surface-3)] disabled:text-[var(--text-dim)]"
        >
          <ArrowUp size={16} weight="bold" />
        </button>
      </div>
    </div>
  );
}
