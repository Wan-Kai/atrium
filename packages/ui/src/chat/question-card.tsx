import { QUESTION_LIMITS } from "@atrium/client";
import type { AskedQuestion, PendingQuestion, QuestionReply } from "@atrium/protocol";
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { CaretRight, Check, Question } from "../design/icons";
import { useClock } from "../state/clock";
import {
  type QuestionDraft,
  type QuestionPick,
  answered,
  choose,
  nextUnanswered,
  readDraft,
  replyOf,
  writeDraft,
} from "./question-state";

/** How long after a single choice the card moves to the next question (SPEC-0003, "作答"). */
const ADVANCE_MS = 200;

/** The footer's buttons: 28px pills (design-language, "提问卡片"). */
const BUTTON =
  "atrium-press inline-flex h-7 items-center gap-1 rounded-[var(--r-pill)] px-3 text-[length:var(--fs-meta)] whitespace-nowrap disabled:cursor-default";

/** A key's mark in the footer's hints. */
const KEY =
  "rounded-[4px] px-1 font-[family-name:var(--font-mono)] text-[length:var(--fs-xs)] text-[var(--text-muted)] shadow-[inset_0_0_0_0.5px_var(--line-strong)]";

/**
 * One option of a question, or the other answer, with the box to write it in once picked.
 *
 * @remarks
 * Design-language ("提问卡片", 序号乙): the number is the control, a 22px disc, round for one
 * choice and a rounded square for several, filled with the tint and a tick once picked. The box
 * for the other answer is below the row's button, across the row, lined up with the labels.
 *
 * @sideEffects Calls `onPick`, `onPoint` and `onWrite` as you act.
 * @param props - The question, the option's index, the pick, and what to do.
 * @returns The row.
 */
function OptionRow({
  question,
  index,
  pick,
  onPick,
  onPoint,
  onWrite,
  onConfirm,
  boxRef,
}: {
  readonly question: AskedQuestion;
  readonly index: number;
  readonly pick: QuestionPick;
  readonly onPick: () => void;
  readonly onPoint: () => void;
  readonly onWrite: (text: string) => void;
  readonly onConfirm: () => void;
  readonly boxRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const option = question.options[index];
  const isOther = option === undefined;
  const picked = isOther ? pick.other !== null : pick.selected.includes(index);
  return (
    <div
      className={`rounded-[var(--r-md)] transition-colors duration-100 ${picked ? "bg-[var(--linked)]" : "hover:bg-[var(--hover)]"}`}
    >
      <button
        type="button"
        role={question.multiSelect ? "checkbox" : "radio"}
        aria-checked={picked}
        data-option={index}
        onClick={onPick}
        onMouseEnter={onPoint}
        onFocus={onPoint}
        className="group atrium-press-row flex w-full items-start gap-2.5 rounded-[var(--r-md)] px-2.5 py-2 text-left outline-none focus-visible:bg-[var(--hover)] focus-visible:shadow-[inset_0_0_0_1px_var(--line-strong)]"
      >
        <span
          data-disc
          className={`mt-[-1px] grid size-[22px] flex-none place-items-center text-[length:var(--fs-sm)] font-semibold tabular-nums transition-colors duration-150 ${
            question.multiSelect ? "rounded-[7px]" : "rounded-full"
          } ${
            picked
              ? "bg-[var(--tint)] text-[var(--on-tint)]"
              : "bg-[var(--surface-2)] text-[var(--text-muted)] group-hover:text-[var(--text)] dark:bg-[var(--surface-3)]"
          }`}
        >
          {picked ? <Check size={12} weight="bold" className="atrium-question-tick" aria-hidden /> : index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[length:var(--fs-meta)] leading-5 font-medium text-[var(--text)]">
            {isOther ? "其他" : option.label}
            {option?.recommended === true ? (
              <span className="rounded-[var(--r-sm)] bg-[var(--linked)] px-[5px] text-[length:var(--fs-xs)] leading-[17px] font-medium text-[var(--tint)]">
                推荐
              </span>
            ) : null}
          </span>
          {isOther && picked ? null : (
            <span className="mt-px block text-[length:var(--fs-sm)] text-[var(--text-muted)]">
              {isOther ? "都不合适？写你自己的回答" : option.description}
            </span>
          )}
        </span>
      </button>
      {isOther && picked ? (
        <div className="pr-2.5 pb-2 pl-[42px]">
          <textarea
            ref={boxRef}
            aria-label="其他回答"
            rows={2}
            maxLength={QUESTION_LIMITS.other}
            value={pick.other ?? ""}
            placeholder="写下你的回答…"
            onChange={(event) => {
              onWrite(event.target.value);
              grow(event.target);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              onConfirm();
            }}
            className="block max-h-[168px] min-h-[62px] w-full resize-none overflow-y-auto rounded-[var(--r-md)] bg-[var(--main)] px-3 py-[9px] text-[length:var(--fs)] leading-[1.5] text-[var(--text)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] outline-none placeholder:text-[var(--text-dim)] focus:shadow-[inset_0_0_0_1px_var(--tint),var(--focus-ring)]"
          />
          <div className="mt-[5px] flex justify-end gap-3 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
            <span>
              <kbd className={KEY}>⏎</kbd> 确定
            </span>
            <span>
              <kbd className={KEY}>⇧⏎</kbd> 换行
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Fits the other answer's box to its text.
 *
 * @remarks
 * Two lines at least, about six at most; past that it scrolls (design-language, "提问卡片").
 *
 * @sideEffects Sets the box's height.
 * @param box - The box.
 */
function grow(box: HTMLTextAreaElement): void {
  box.style.height = "auto";
  box.style.height = `${String(box.scrollHeight)}px`;
}

/**
 * The questions the agent asks with `ask_user`, answered on a card above the input box.
 *
 * @remarks
 * SPEC-0003, "作答" and design-language "提问卡片" (原型 `agent-question-card-prototype.html` 的
 * 乙): several questions are tabs; a single choice moves on to the next unanswered question 0.2 s
 * later; several are toggled; the other answer opens a box of its own. Number keys choose, ↑↓ move
 * between the options, ←→ between the questions, Enter goes to the next unanswered one and sends
 * once all are answered; Tab keeps moving the focus. "提交回答" waits for every answer; "跳过" skips
 * them all. What you picked is kept per session while the questions wait, so switching away and
 * back keeps it. Keys held with ⌘, Ctrl or Alt are left to the app.
 *
 * @sideEffects Calls `onAnswer`, and lets you send again when it says the send failed; keeps the
 * draft; sets a timer after a single choice; moves the focus with the question when it was in the card.
 * @param props - The session, its questions, and what to do with the reply.
 * @returns The card.
 */
export function QuestionCard({
  sessionId,
  question,
  onAnswer,
}: {
  readonly sessionId: string;
  readonly question: PendingQuestion;
  readonly onAnswer: (reply: QuestionReply) => Promise<boolean> | void;
}) {
  const clock = useClock();
  const { questions } = question;
  const [draft, setDraft] = useState<QuestionDraft>(() => readDraft(sessionId, question.id, questions.length));
  const [pointed, setPointed] = useState<number | null>(null);
  const [sent, setSent] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const focusBox = useRef(false);
  /** Set as the question shown changes with the focus in the card: it goes on to the new options. */
  const focusOptions = useRef(false);
  const advance = useRef<(() => void) | null>(null);
  const card = useRef<HTMLElement>(null);
  const current = Math.min(draft.current, questions.length - 1);
  const asked = questions[current] ?? questions[0];
  const pick = draft.picks[current] ?? { selected: [], other: null };
  const reply = replyOf(questions, draft.picks);
  const count = draft.picks.filter((one, index) => {
    const each = questions[index];
    return each !== undefined && answered(each, one);
  }).length;

  useEffect(() => () => advance.current?.(), []);
  useEffect(() => {
    if (focusBox.current && box.current !== null) {
      focusBox.current = false;
      box.current.focus();
      grow(box.current);
      return;
    }
    if (!focusOptions.current) return;
    focusOptions.current = false;
    const options = card.current?.querySelector<HTMLElement>('[data-option][aria-checked="true"]');
    (options ?? card.current?.querySelector<HTMLElement>("[data-option]"))?.focus();
  });

  /**
   * Whether the focus is in the card.
   *
   * @remarks
   * Only then does a change of question take it along: the keys go on working, and a focus you put
   * elsewhere, as in the input box, stays there.
   *
   * @sideEffects none
   * @returns Whether it is.
   */
  const focused = (): boolean => card.current?.contains(document.activeElement) === true;

  /**
   * Keeps a new draft, in the card and for the session.
   *
   * @remarks
   * So switching away and back keeps it (SPEC-0003, "作答").
   *
   * @sideEffects Updates the state and the page's drafts.
   * @param next - The draft.
   */
  const keep = (next: QuestionDraft): void => {
    setDraft(next);
    writeDraft(sessionId, question.id, next);
  };

  /**
   * Shows another question.
   *
   * @remarks
   * A move a single choice set off is called off: you chose where to go.
   *
   * @sideEffects Updates the draft; cancels a pending move.
   * @param index - The question.
   */
  const show = (index: number): void => {
    advance.current?.();
    advance.current = null;
    setPointed(null);
    focusOptions.current = focused();
    keep({ ...draft, current: index });
  };

  /**
   * Picks an option, or the other answer, of the question shown.
   *
   * @remarks
   * A single choice moves on to the next unanswered question 0.2 s later.
   *
   * @sideEffects Updates the draft; may set a timer; focuses the other answer's box once it opens.
   * @param index - The option, or one past them for the other answer.
   */
  const pickOption = (index: number): void => {
    if (asked === undefined) return;
    advance.current?.();
    advance.current = null;
    const now = choose(asked, pick, index);
    const picks = draft.picks.map((one, at) => (at === current ? now : one));
    const next = { current, picks };
    keep(next);
    if (index === asked.options.length) {
      focusBox.current = now.other !== null;
      return;
    }
    if (asked.multiSelect || questions.length < 2) return;
    const to = nextUnanswered(questions, picks, current);
    if (to === null) return;
    advance.current = clock.after(ADVANCE_MS, () => {
      advance.current = null;
      setPointed(null);
      focusOptions.current = focused();
      setDraft((latest) => {
        const moved = { ...latest, current: to };
        writeDraft(sessionId, question.id, moved);
        return moved;
      });
    });
  };

  /**
   * Writes the other answer.
   *
   * @remarks
   * Kept as typed; it is trimmed when sent.
   *
   * @sideEffects Updates the draft.
   * @param text - What is written.
   */
  const write = (text: string): void => {
    keep({ current, picks: draft.picks.map((one, at) => (at === current ? { ...one, other: text } : one)) });
  };

  /**
   * Sends the answers, or skips the questions; once.
   *
   * @remarks
   * The card goes when the host ends the questions; a second press meanwhile sends nothing.
   *
   * @sideEffects Calls `onAnswer`.
   * @param answer - What to send.
   */
  const send = (answer: QuestionReply): void => {
    if (sent) return;
    setSent(true);
    // Fire and forget: a failure is shown above the box; the card lets you send again.
    void Promise.resolve(onAnswer(answer)).then((ok) => setSent(ok !== false));
  };

  /**
   * Goes on from the question shown: sends once all are answered, else shows the next unanswered.
   *
   * @remarks
   * Enter, in the card or the other answer's box (SPEC-0003, "作答").
   *
   * @sideEffects As `send` or `show`.
   */
  const confirm = (): void => {
    if (reply !== null) {
      send(reply);
      return;
    }
    if (asked === undefined || !answered(asked, pick)) return;
    const to = nextUnanswered(questions, draft.picks, current);
    if (to !== null) show(to);
  };

  /**
   * The keys of the card, outside the other answer's box.
   *
   * @remarks
   * See `QuestionCard`. Enter on an option sends or moves on once the question shown is answered,
   * and otherwise picks the option; Enter on the card's other buttons presses them.
   *
   * @sideEffects As the key's.
   * @param event - The key.
   */
  const keyed = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing || event.target instanceof HTMLTextAreaElement || asked === undefined) return;
    // Held with ⌘, Ctrl or Alt, a key is the app's, as ⌘2 switching tabs.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const option = event.target instanceof HTMLElement ? event.target.closest("[data-option]") : null;
    if (/^[1-9]$/u.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index > asked.options.length) return;
      event.preventDefault();
      pickOption(index);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const rows = [...(card.current?.querySelectorAll<HTMLElement>("[data-option]") ?? [])];
      const at = rows.findIndex((row) => row === option);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const to = at === -1 ? (step === 1 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length;
      event.preventDefault();
      rows[to]?.focus();
      return;
    }
    if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && questions.length > 1) {
      event.preventDefault();
      show((current + (event.key === "ArrowRight" ? 1 : questions.length - 1)) % questions.length);
      return;
    }
    if (event.key !== "Enter") return;
    if (option === null && event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    if (reply !== null || answered(asked, pick)) confirm();
    else if (option !== null) pickOption(Number(option.getAttribute("data-option")));
  };

  if (asked === undefined) return null;
  const options = [...asked.options.keys(), asked.options.length];
  const withPreview = asked.options.some((one) => one.preview !== null);
  const previewed =
    [pointed, pick.selected[0], 0].find(
      (index): index is number => index !== undefined && index !== null && asked.options[index]?.preview != null,
    ) ?? 0;
  const unanswered = nextUnanswered(questions, draft.picks, current);
  const last = asked.options.length + 1;
  return (
    <section
      ref={card}
      data-testid="question"
      aria-label="agent 在问你"
      onKeyDown={keyed}
      className="atrium-question-card mt-3 mb-2 flex max-h-[60vh] flex-col rounded-[var(--r-card)] bg-[var(--surface-1)] px-3.5 py-3 shadow-[var(--card-shadow)] dark:bg-[var(--surface-2)]"
    >
      <div className="flex flex-none flex-wrap items-center gap-2.5">
        <span className="flex items-center gap-1.5 text-[length:var(--fs-sm)] font-medium text-[var(--attn-text)]">
          <Question size={15} aria-hidden />
          <span>agent 在问你</span>
          {questions.length > 1 ? (
            <span className="font-normal text-[var(--text-dim)] tabular-nums">
              · 已答 {count} / {questions.length}
            </span>
          ) : null}
        </span>
        {questions.length > 1 ? (
          <div role="tablist" aria-label="问题" className="ml-auto flex flex-wrap items-center gap-0.5">
            {questions.map((one, index) => {
              const done = answered(one, draft.picks[index] ?? { selected: [], other: null });
              const on = index === current;
              return (
                <button
                  key={one.header}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => show(index)}
                  className={`atrium-press inline-flex h-[26px] items-center gap-[5px] rounded-[var(--r-pill)] px-[9px] text-[length:var(--fs-sm)] ${
                    on
                      ? "bg-[var(--selected)] font-medium text-[var(--text)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--hover)]"
                  }`}
                >
                  {done ? (
                    <Check size={12} weight="bold" className="text-[var(--ok-text)]" aria-hidden />
                  ) : (
                    <span aria-hidden className="size-1.5 rounded-full shadow-[inset_0_0_0_1px_var(--text-dim)]" />
                  )}
                  {one.header}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="mt-2.5 min-h-0 flex-1 overflow-y-auto">
        <div className="mx-0.5 mb-2 text-[length:var(--fs)] font-medium text-[var(--text)]">
          <span>{asked.question}</span>
          <span
            className={`ml-2 inline-block rounded-[var(--r-sm)] px-1.5 align-[1px] text-[length:var(--fs-xs)] leading-[18px] font-normal ${
              asked.multiSelect
                ? "bg-[var(--linked)] text-[var(--tint)]"
                : "bg-[var(--surface-2)] text-[var(--text-muted)] dark:bg-[var(--surface-3)]"
            }`}
          >
            {asked.multiSelect ? (
              <>
                多选
                {pick.selected.length + (pick.other === null ? 0 : 1) > 0 ? (
                  <span className="tabular-nums"> · 已选 {pick.selected.length + (pick.other === null ? 0 : 1)}</span>
                ) : null}
              </>
            ) : (
              "单选"
            )}
          </span>
        </div>
        <div className="flex items-stretch gap-3">
          <div
            role={asked.multiSelect ? "group" : "radiogroup"}
            aria-label={asked.question}
            className="flex min-w-0 flex-1 flex-col gap-0.5"
          >
            {options.map((index) => (
              <OptionRow
                key={`${current}:${String(index)}`}
                question={asked}
                index={index}
                pick={pick}
                onPick={() => pickOption(index)}
                onPoint={() => setPointed(index)}
                onWrite={write}
                onConfirm={confirm}
                boxRef={box}
              />
            ))}
          </div>
          {withPreview ? (
            <div
              aria-label="预览"
              role="region"
              className="w-[46%] flex-none overflow-auto rounded-[var(--r-md)] bg-[var(--code)] px-3 py-2.5"
            >
              <div className="mb-2 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
                预览 · {asked.options[previewed]?.label}
              </div>
              <pre className="m-0 font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] leading-[1.45] whitespace-pre-wrap text-[var(--text-3)]">
                {asked.options[previewed]?.preview}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-2.5 flex flex-none flex-wrap items-center gap-1.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
        <span>
          <kbd className={KEY}>1–{last}</kbd> {asked.multiSelect ? "勾选" : "选择"}
        </span>
        {asked.multiSelect ? (
          <span>
            <kbd className={KEY}>空格</kbd> 勾选当前行
          </span>
        ) : null}
        <span>
          <kbd className={KEY}>⏎</kbd> {reply !== null ? "提交" : questions.length > 1 ? "下一题" : "确定"}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          disabled={sent}
          onClick={() => send({ skipped: true })}
          className={`${BUTTON} text-[var(--text-2)] hover:bg-[var(--hover)]`}
        >
          跳过
        </button>
        {questions.length > 1 && unanswered !== null && unanswered !== current ? (
          <button
            type="button"
            onClick={() => show(unanswered)}
            className={`${BUTTON} text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]`}
          >
            下一题
            <CaretRight size={12} aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          disabled={reply === null || sent}
          onClick={() => {
            if (reply !== null) send(reply);
          }}
          className={`${BUTTON} font-medium ${
            reply === null || sent
              ? "bg-[var(--surface-3)] text-[var(--text-dim)]"
              : "bg-[var(--text)] text-[var(--main)]"
          }`}
        >
          提交回答
        </button>
      </div>
    </section>
  );
}
