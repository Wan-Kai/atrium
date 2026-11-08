import type { PendingReview, ReviewAction, Verdict } from "@atrium/protocol";

/** What you have filled in on a review card that has not been answered yet. */
export interface ReviewDraft {
  /** The button whose form is open, or `null` while none is. */
  readonly open: string | null;
  readonly target: string | null;
  readonly reason: string;
}

/** Nothing opened or written. */
export const NO_DRAFT: ReviewDraft = { open: null, target: null, reason: "" };

/** What you wrote on cards not answered yet, by session and review, kept in the page only (like the questions'). */
const drafts = new Map<string, ReviewDraft>();

/**
 * What was filled in on a card so far.
 *
 * @remarks
 * Kept while you switch cards, sessions or tabs, so a reason half written is not lost (SPEC-0006, "审核卡片").
 *
 * @sideEffects none
 * @param sessionId - The session the card is above.
 * @param reviewId - The review.
 * @returns The draft, or nothing filled in.
 */
export function readReviewDraft(sessionId: string, reviewId: string): ReviewDraft {
  return drafts.get(`${sessionId}\n${reviewId}`) ?? NO_DRAFT;
}

/**
 * Keeps what is filled in on a card.
 *
 * @remarks
 * Writing nothing again forgets the entry, so the map does not grow with cards that were only opened.
 *
 * @sideEffects Updates the page's drafts.
 * @param sessionId - The session.
 * @param reviewId - The review.
 * @param draft - The draft.
 */
export function writeReviewDraft(sessionId: string, reviewId: string, draft: ReviewDraft): void {
  const key = `${sessionId}\n${reviewId}`;
  if (draft.open === null && draft.target === null && draft.reason === "") drafts.delete(key);
  else drafts.set(key, draft);
}

/**
 * Where a verdict on a review stands: on its way, taken by the host, or refused with words.
 *
 * @remarks
 * Kept per session and review, not in the card that sent it (T8 review fix 9): the card is dropped when you switch to
 * another one and drawn again when you come back, and the verdict, its answer and the lock that keeps it from being
 * sent twice are not the card's.
 */
export type ReviewProgress =
  | { readonly phase: "sending" }
  /** The host took the verdict; the card goes when the list stops carrying the review, and until then it stays off. */
  | { readonly phase: "sent" }
  | { readonly phase: "failed"; readonly words: string };

/** The verdicts under way, taken or refused, by session and review. */
const progress = new Map<string, ReviewProgress>();
const watchers = new Set<() => void>();

/**
 * Where the verdict on a review stands.
 *
 * @remarks
 * The same object until it changes, as `useSyncExternalStore` needs.
 *
 * @sideEffects none
 * @param sessionId - The session.
 * @param reviewId - The review.
 * @returns The progress, or nothing for a review no verdict was given on (or one whose answer was forgotten).
 */
export function readReviewProgress(sessionId: string, reviewId: string): ReviewProgress | null {
  return progress.get(`${sessionId}\n${reviewId}`) ?? null;
}

/**
 * Records where the verdict on a review stands, and tells the cards watching.
 *
 * @remarks
 * Every change tells every watcher, as there are few cards and a card reads its own key; a `null` forgets the entry.
 *
 * @sideEffects Updates the page's progress; calls the watchers.
 * @param sessionId - The session.
 * @param reviewId - The review.
 * @param next - The progress, or `null` to forget it.
 */
export function writeReviewProgress(sessionId: string, reviewId: string, next: ReviewProgress | null): void {
  const key = `${sessionId}\n${reviewId}`;
  if (next === null) progress.delete(key);
  else progress.set(key, next);
  for (const watcher of watchers) watcher();
}

/**
 * Calls `watcher` whenever any review's progress changes.
 *
 * @remarks
 * The subscription for `useSyncExternalStore`: the cards read their own entry when told.
 *
 * @sideEffects Adds the watcher until the returned function is called.
 * @param watcher - What to call.
 * @returns A function that stops it.
 */
export function watchReviewProgress(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

/**
 * Forgets the drafts and the progress of a session's reviews that are not there any more.
 *
 * @remarks
 * Once a review is decided or closed, what was written for it is of no use, and the lock of a verdict the host took
 * is let go: a review with the same id that comes later is a new question.
 *
 * @sideEffects Updates the page's drafts and progress; calls the watchers if progress was dropped.
 * @param sessionId - The session.
 * @param live - The ids of the reviews still pending.
 */
export function forgetReviewDrafts(sessionId: string, live: readonly string[]): void {
  const prefix = `${sessionId}\n`;
  for (const key of drafts.keys())
    if (key.startsWith(prefix) && !live.includes(key.slice(prefix.length))) drafts.delete(key);
  let dropped = false;
  for (const key of progress.keys()) {
    if (key.startsWith(prefix) && !live.includes(key.slice(prefix.length))) {
      progress.delete(key);
      dropped = true;
    }
  }
  if (dropped) for (const watcher of watchers) watcher();
}

/**
 * Whether a button can be sent as it stands, or needs a form first.
 *
 * @remarks
 * A button with a reason to take (required or optional) or a target to choose opens a form; one with neither is a
 * verdict at once (SPEC-0006, "审核卡片" 4).
 *
 * @sideEffects none
 * @param action - The button.
 * @returns Whether pressing it asks for more.
 */
export function needsForm(action: ReviewAction): boolean {
  return action.reason !== "none" || action.targets.length > 0;
}

/**
 * The verdict a button gives with what is filled in, or why it is not complete.
 *
 * @remarks
 * A target is needed when the button has any (one left is taken by itself; a used-up one, `remaining: 0`, cannot be
 * chosen); a required reason must have a word in it; an optional one is sent only when written; a button that takes
 * no reason sends none.
 *
 * @sideEffects none
 * @param action - The button.
 * @param draft - What is filled in.
 * @returns The verdict, or `null` when something is missing.
 */
export function verdictOf(action: ReviewAction, draft: ReviewDraft): Verdict | null {
  const usable = action.targets.filter((target) => target.remaining !== 0);
  const target =
    action.targets.length === 0 ? undefined : (draft.target ?? (usable.length === 1 ? usable[0]?.id : undefined));
  if (action.targets.length > 0 && (target === undefined || !usable.some((one) => one.id === target))) return null;
  const reason = draft.reason.trim();
  if (action.reason === "required" && reason === "") return null;
  return {
    action: action.id,
    ...(target === undefined ? {} : { target }),
    ...(action.reason === "none" || reason === "" ? {} : { reason }),
  };
}

/**
 * The buttons in the order they are drawn: the ones the host recommends first, the others as it listed them.
 *
 * @remarks
 * The host decides from the facts (a worktree not merged defaults to "先留着"). When it recommends none, none is
 * put first or painted as the recommended one: the first button is not the host's advice just for being first
 * (T8 review fix 10).
 *
 * @sideEffects none
 * @param review - The review.
 * @returns The buttons.
 */
export function orderedActions(review: PendingReview): ReviewAction[] {
  return [
    ...review.actions.filter((action) => action.recommended),
    ...review.actions.filter((action) => !action.recommended),
  ];
}
