import type { Evidence, PendingReview, ReviewAction } from "@atrium/protocol";
import { type KeyboardEvent, use, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowClockwise,
  ArrowTurnBack,
  CaretRight,
  Check,
  Flowchart,
  GitDiff,
  GitMerge,
  Warning,
  WarningCircle,
} from "../design/icons";
import { CARD_BUTTON, CARD_KEY, CardShell } from "./card-shell";
import { type ActionIconName, ReviewEnvContext } from "./review-env";
import { clockWords } from "./clock-words";
import {
  NO_DRAFT,
  type ReviewDraft,
  needsForm,
  orderedActions,
  readReviewDraft,
  readReviewProgress,
  verdictOf,
  watchReviewProgress,
  writeReviewDraft,
  writeReviewProgress,
} from "./review-state";

/** How long a written reason may be (the host takes more; the box stops here so a paste does not freeze the card). */
const REASON_LIMIT = 4000;

/**
 * The small icon some buttons carry: merge, send back, try again.
 *
 * @remarks
 * 设计稿第 7 屏: "通过并合并" has the merge mark, "打回到 …" the turn-back arrow, "重试合并" the circular arrow.
 *
 * @sideEffects none
 * @param props - The icon's name.
 * @returns The icon.
 */
function ActionIcon({ icon }: { readonly icon: ActionIconName }) {
  const Icon = icon === "merge" ? GitMerge : icon === "back" ? ArrowTurnBack : ArrowClockwise;
  return <Icon size={12} aria-hidden />;
}

/**
 * One fact: an icon that carries its status and one sentence.
 *
 * @remarks
 * Only the host's own facts have a status; text an agent wrote never comes through here (ADR-0018 decision 2).
 *
 * @sideEffects none
 * @param props - The status and the sentence.
 * @returns The line.
 */
function FactLine({ status, text }: { readonly status: "ok" | "warn" | "danger"; readonly text: string }) {
  return (
    <li data-testid="review-fact" data-status={status} className="flex items-start gap-1.5">
      {status === "ok" ? (
        <Check size={13} weight="bold" className="mt-[3px] flex-none text-[var(--ok-text)]" aria-hidden />
      ) : status === "warn" ? (
        <Warning size={13} className="mt-[3px] flex-none text-[var(--attn-text)]" aria-hidden />
      ) : (
        <WarningCircle size={13} className="mt-[3px] flex-none text-[var(--danger)]" aria-hidden />
      )}
      <span className="min-w-0 text-[var(--text-2)]">{text}</span>
    </li>
  );
}

/**
 * The quote of what someone else wrote: an upstream node, or the agent that asked.
 *
 * @remarks
 * Shown as a quote with "agent 说" or "N3 说" in front and no line down its left (design-language, "审核卡片");
 * folded to two lines until opened. It is model text: shown as text, never as markup.
 *
 * @sideEffects Keeps whether it is open.
 * @param props - Who wrote it and what.
 * @returns The block.
 */
function SummaryQuote({ who, text }: { readonly who: string; readonly text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid="review-summary"
      className="rounded-[var(--r-md)] bg-[var(--surface-2)] px-3 py-2 dark:bg-[var(--surface-3)]"
    >
      <div className="flex items-center gap-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
        <span>{who} 说</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-0.5 text-[var(--tint)] hover:underline"
        >
          {open ? "收起" : "展开"}
          <CaretRight size={10} className={open ? "rotate-90" : ""} aria-hidden />
        </button>
      </div>
      <p
        className={`mt-0.5 text-[length:var(--fs-meta)] leading-[1.5] whitespace-pre-wrap text-[var(--text-2)] ${open ? "max-h-[220px] overflow-y-auto" : "line-clamp-2"}`}
      >
        {text}
      </p>
    </div>
  );
}

/**
 * One piece of a review's evidence.
 *
 * @remarks
 * Four kinds (SPEC-0006, "审核卡片" 2): facts, changes, the graph's changes and a summary. The host's statistics open
 * the changes panel; a proposed graph is looked at on the graph itself. A `frozen` block is the snapshot a decided
 * review's record keeps: the same numbers and names, with no link to anything live (design-language, "过程轨道上的
 * 审核记录": "不带按钮"), because the worktree and the graph are not what they were.
 *
 * @sideEffects Calls the environment's `openChanges` and `showOnGraph` when the links are pressed.
 * @param props - The evidence, and whether it is a record's snapshot.
 * @returns The block.
 */
export function EvidenceBlock({
  evidence,
  frozen = false,
}: {
  readonly evidence: Evidence;
  readonly frozen?: boolean;
}) {
  const look = use(ReviewEnvContext);
  if (evidence.kind === "facts")
    return (
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[length:var(--fs-meta)]">
        {evidence.facts.map((fact) => (
          <FactLine key={`${fact.code}:${JSON.stringify(fact.params)}`} status={fact.status} text={look.fact(fact)} />
        ))}
      </ul>
    );
  if (evidence.kind === "changes")
    return (
      <div
        data-testid="review-changes"
        className="flex items-center gap-2 text-[length:var(--fs-meta)] text-[var(--text-2)]"
      >
        <GitDiff size={13} className="flex-none text-[var(--text-dim)]" aria-hidden />
        <span className="tabular-nums">{evidence.files} 个文件</span>
        <span className="text-[var(--ok-text)] tabular-nums">+{evidence.added}</span>
        <span className="text-[var(--danger)] tabular-nums">−{evidence.removed}</span>
        {frozen ? null : (
          <button
            type="button"
            onClick={() => look.openChanges(evidence.workspaceId)}
            className="inline-flex items-center gap-0.5 text-[var(--tint)] hover:underline"
          >
            查看改动
            <CaretRight size={11} aria-hidden />
          </button>
        )}
      </div>
    );
  if (evidence.kind === "graph_diff") {
    /**
     * A node as the diff names it: its id and its name.
     *
     * @remarks
     * The name is the graph's, or the proposed graph's for a node being added.
     *
     * @sideEffects none
     * @param node - The node's id.
     * @returns The words.
     */
    const name = (node: string): string => {
      const found = look.nodeName(node);
      return found === undefined ? node : `${node} ${found}`;
    };
    return (
      <div data-testid="review-graph-diff" className="flex flex-col gap-0.5 text-[length:var(--fs-meta)]">
        {evidence.added.map((node) => (
          <div key={`+${node}`} className="flex gap-1.5 text-[var(--text-2)]">
            <span className="w-3 flex-none text-center text-[var(--ok-text)]">+</span>
            <span>{name(node)}</span>
          </div>
        ))}
        {evidence.changed.map((node) => (
          <div key={`~${node}`} className="flex gap-1.5 text-[var(--text-2)]">
            <span className="w-3 flex-none text-center text-[var(--tint)]">~</span>
            <span>{name(node)}</span>
          </div>
        ))}
        {evidence.removed.map((node) => (
          <div key={`-${node}`} className="flex gap-1.5 text-[var(--text-2)]">
            <span className="w-3 flex-none text-center text-[var(--danger)]">−</span>
            <span>{name(node)}</span>
          </div>
        ))}
        {frozen ? null : (
          <button
            type="button"
            onClick={() => look.showOnGraph(evidence.to)}
            className="mt-0.5 inline-flex w-fit items-center gap-0.5 text-[var(--tint)] hover:underline"
          >
            在图上看
            <CaretRight size={11} aria-hidden />
          </button>
        )}
      </div>
    );
  }
  const who =
    evidence.by.kind === "agent"
      ? "agent"
      : (() => {
          const found = look.nodeName(evidence.by.node);
          return found === undefined ? evidence.by.node : `${evidence.by.node} ${found}`;
        })();
  // A summary is quoted whoever wrote it; nothing here gives it a status.
  return <SummaryQuote who={who} text={evidence.text} />;
}

/**
 * The card for something you are asked to judge, above the input box.
 *
 * @remarks
 * SPEC-0006 ("界面 · 审核卡片") and ADR-0018: it reads a `PendingReview` and knows nothing about tasks; the words
 * come from the environment (`ReviewEnvContext`). Top: the source and what is reviewed; then the evidence the host
 * worked out; a problem band when the last try did not go through; the buttons, the recommended one filled. A button
 * that needs a reason or a target opens a form in the card (not the box below, which keeps going to the
 * conversation); a target with nothing left is greyed. What is written is kept per review. The answer is the
 * caller's: it resolves with words for what went wrong, shown in the card, or `null` when the verdict went.
 *
 * @sideEffects Calls `onAnswer` once per press (a second press while one is on its way sends nothing); keeps the
 * draft; moves the focus into the form it opens.
 * @param props - The session, the review, and what to do with a verdict.
 * @returns The card.
 */
export function ReviewCard({
  sessionId,
  review,
  onAnswer,
}: {
  readonly sessionId: string;
  readonly review: PendingReview;
  readonly onAnswer?: (verdict: NonNullable<ReturnType<typeof verdictOf>>) => Promise<string | null>;
}) {
  const look = use(ReviewEnvContext);
  const [draft, setDraft] = useState<ReviewDraft>(() => readReviewDraft(sessionId, review.id));
  // Where the verdict stands is the page's, not this card's: it is dropped when you switch to another card.
  const standing = useSyncExternalStore(watchReviewProgress, () => readReviewProgress(sessionId, review.id));
  const sent = standing?.phase === "sending" || standing?.phase === "sent";
  const failure = standing?.phase === "failed" ? standing.words : null;
  const box = useRef<HTMLTextAreaElement>(null);
  const focusBox = useRef(false);
  const ordered = orderedActions(review);
  const opened = review.actions.find((one) => one.id === draft.open) ?? null;
  const problem = review.problem === null ? null : look.problem(review.problem);
  // The host's facts carry a status; a request an agent made cannot (ADR-0018 decision 2), so none is drawn for it.
  const shown =
    review.source.kind === "agent" ? review.evidence.filter((one) => one.kind !== "facts") : review.evidence;

  useEffect(() => {
    if (!focusBox.current) return;
    focusBox.current = false;
    box.current?.focus();
  });

  /**
   * Keeps a new draft, in the card and for the review.
   *
   * @remarks
   * So switching cards, tabs or sessions and back keeps what was written.
   *
   * @sideEffects Updates the state and the page's drafts.
   * @param next - The draft.
   */
  const keep = (next: ReviewDraft): void => {
    setDraft(next);
    writeReviewDraft(sessionId, review.id, next);
  };

  /**
   * Sends a verdict, once.
   *
   * @remarks
   * The card goes when the host lists the review no more and stays off until then; a failure is worded in the card
   * and lets you press again. The lock is the page's, per session and review, so it holds when you switch cards.
   *
   * @sideEffects Calls `onAnswer`; records the progress.
   * @param action - The button.
   * @param from - What is filled in.
   */
  const send = (action: ReviewAction, from: ReviewDraft): void => {
    const verdict = verdictOf(action, from);
    if (verdict === null || sent || onAnswer === undefined) return;
    writeReviewProgress(sessionId, review.id, { phase: "sending" });
    // Fire and forget: the answer's failure is shown in the card.
    void onAnswer(verdict).then((words) => {
      // Taken: what was written for it is of no use, and the buttons stay off until the review is no longer listed.
      if (words === null) writeReviewDraft(sessionId, review.id, NO_DRAFT);
      writeReviewProgress(sessionId, review.id, words === null ? { phase: "sent" } : { phase: "failed", words });
      return words;
    });
  };

  /**
   * Presses a button: sends at once, or opens its form.
   *
   * @remarks
   * Pressing the open one again folds it.
   *
   * @sideEffects As `send` or `keep`.
   * @param action - The button.
   */
  const press = (action: ReviewAction): void => {
    if (!needsForm(action)) {
      send(action, draft);
      return;
    }
    if (draft.open === action.id) {
      keep({ ...draft, open: null });
      return;
    }
    focusBox.current = action.reason !== "none";
    keep({ ...draft, open: action.id, target: null });
  };

  /**
   * The keys of the open form's box: Enter sends, Shift+Enter breaks the line, Esc folds the form.
   *
   * @remarks
   * Like the question card's other-answer box.
   *
   * @sideEffects As `send` or `keep`.
   * @param event - The key.
   */
  const boxKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      keep({ ...draft, open: null });
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || opened === null) return;
    event.preventDefault();
    send(opened, draft);
  };

  const ready = opened !== null && verdictOf(opened, draft) !== null;
  const note = look.note(review);
  return (
    <CardShell
      testId="review"
      label={`审核：${look.subject(review)}`}
      attrs={{ "data-review": review.id }}
      emphasis={shown.some((one) => one.kind === "facts" && one.facts.some((fact) => fact.status !== "ok"))}
    >
      <div className="flex flex-none items-center gap-2">
        {review.source.kind === "gate" ? (
          <span
            data-testid="review-source"
            className="inline-flex h-[20px] flex-none items-center gap-1 rounded-[var(--r-pill)] bg-[var(--linked)] px-2 text-[length:var(--fs-xs)] text-[var(--tint)]"
          >
            <Flowchart size={11} aria-hidden />
            {look.source(review)}
          </span>
        ) : (
          <span
            data-testid="review-source"
            className="flex-none text-[length:var(--fs-meta)] font-medium text-[var(--attn-text)]"
          >
            {look.source(review)}
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-[length:var(--fs-meta)] font-medium text-[var(--text)]"
          data-testid="review-subject"
        >
          {look.subject(review)}
        </span>
        <span className="flex-none text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums">
          {clockWords(review.openedAt)}
        </span>
      </div>
      <div className="mt-2.5 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {shown.map((evidence, index) => (
          <EvidenceBlock key={`${evidence.kind}:${String(index)}`} evidence={evidence} />
        ))}
        {problem === null || review.problem === null ? null : (
          <div
            role="alert"
            data-testid="review-problem"
            data-danger={problem.danger}
            className={`rounded-[var(--r-md)] px-3 py-2 text-[length:var(--fs-meta)] ${
              problem.danger
                ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                : "bg-[var(--attn-soft)] text-[var(--attn-text)]"
            }`}
          >
            {problem.text}
            {review.problem.files === undefined || review.problem.files.length === 0 ? null : (
              <ul className="m-0 mt-1.5 flex list-none flex-wrap gap-1 p-0">
                {review.problem.files.map((file) => (
                  <li
                    key={file}
                    className="max-w-full truncate rounded-[var(--r-sm)] bg-[var(--surface-3)] px-1.5 font-[family-name:var(--font-mono)] text-[length:var(--fs-xs)] text-[var(--text-2)]"
                  >
                    {file}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {opened === null ? null : (
        <div data-testid="review-form" className="mt-2.5 flex flex-none flex-col gap-2">
          {opened.targets.length === 0 ? null : (
            <div role="radiogroup" aria-label="打回到" className="flex flex-wrap items-center gap-1.5">
              {opened.targets.map((target) => {
                const exhausted = target.remaining === 0;
                const chosen =
                  draft.target === target.id ||
                  (draft.target === null &&
                    opened.targets.filter((one) => one.remaining !== 0).length === 1 &&
                    !exhausted);
                const name = look.nodeName(target.id);
                return (
                  <button
                    key={target.id}
                    type="button"
                    role="radio"
                    aria-checked={chosen}
                    disabled={exhausted}
                    data-target={target.id}
                    onClick={() => keep({ ...draft, target: target.id })}
                    className={`atrium-press inline-flex h-[26px] items-center gap-1.5 rounded-[var(--r-pill)] px-2.5 text-[length:var(--fs-sm)] disabled:cursor-not-allowed disabled:opacity-45 ${
                      chosen
                        ? "bg-[var(--linked)] text-[var(--tint)]"
                        : "bg-[var(--surface-2)] text-[var(--text-2)] dark:bg-[var(--surface-3)]"
                    }`}
                  >
                    {name === undefined ? target.id : `${target.id} ${name}`}
                    {target.remaining === null ? null : (
                      <span className="text-[var(--text-dim)]">
                        {exhausted ? "已用完" : `还能打回 ${String(target.remaining)} 次`}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {opened.reason === "none" ? null : (
            <textarea
              ref={box}
              aria-label={opened.reason === "required" ? "原因（必填）" : "原因（可选）"}
              rows={2}
              maxLength={REASON_LIMIT}
              value={draft.reason}
              placeholder={opened.reason === "required" ? "写下原因…" : "原因（可不写）"}
              onChange={(event) => keep({ ...draft, reason: event.target.value })}
              onKeyDown={boxKey}
              className="block max-h-[168px] min-h-[62px] w-full resize-none overflow-y-auto rounded-[var(--r-md)] bg-[var(--main)] px-3 py-[9px] text-[length:var(--fs)] leading-[1.5] text-[var(--text)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] outline-none placeholder:text-[var(--text-dim)] focus:shadow-[inset_0_0_0_1px_var(--tint),var(--focus-ring)]"
            />
          )}
        </div>
      )}
      {failure === null ? null : (
        <p role="alert" data-testid="review-failure" className="mt-2 text-[length:var(--fs-meta)] text-[var(--danger)]">
          {failure}
        </p>
      )}
      <div className="mt-2.5 flex flex-none flex-wrap items-center gap-1.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
        {opened !== null ? (
          <>
            {opened.reason === "none" ? null : (
              <>
                <span>
                  <kbd className={CARD_KEY}>⏎</kbd> 确定
                </span>
                <span>
                  <kbd className={CARD_KEY}>⇧⏎</kbd> 换行
                </span>
              </>
            )}
            <span>
              <kbd className={CARD_KEY}>Esc</kbd> 收起
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => keep({ ...draft, open: null })}
              className={`${CARD_BUTTON} text-[var(--text-2)] hover:bg-[var(--hover)]`}
            >
              取消
            </button>
            <button
              type="button"
              data-testid="review-confirm"
              disabled={!ready || sent}
              onClick={() => send(opened, draft)}
              className={`${CARD_BUTTON} font-medium ${
                ready && !sent
                  ? "bg-[var(--tint)] text-[var(--on-tint)]"
                  : "bg-[var(--surface-3)] text-[var(--text-dim)]"
              }`}
            >
              {look.confirm(opened, review)}
            </button>
          </>
        ) : (
          <>
            {ordered.map((action) => {
              const icon = look.icon(action, review);
              return (
                <button
                  key={action.id}
                  type="button"
                  data-action={action.id}
                  data-recommended={action.recommended}
                  aria-expanded={needsForm(action) ? false : undefined}
                  disabled={sent || onAnswer === undefined}
                  onClick={() => press(action)}
                  className={`${CARD_BUTTON} ${
                    action.recommended
                      ? "bg-[var(--tint)] font-medium text-[var(--on-tint)]"
                      : "text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]"
                  }`}
                >
                  {icon === null ? null : <ActionIcon icon={icon} />}
                  {look.action(action, review)}
                </button>
              );
            })}
            <span className="flex-1" />
            {note === null ? null : (
              <span data-testid="review-note" className="text-[length:var(--fs-xs)]">
                {note}
              </span>
            )}
          </>
        )}
      </div>
    </CardShell>
  );
}
