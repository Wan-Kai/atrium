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
 * Forgets the drafts of a session's reviews that are not there any more.
 *
 * @remarks
 * Once a review is decided or closed, what was written for it is of no use.
 *
 * @sideEffects Updates the page's drafts.
 * @param sessionId - The session.
 * @param live - The ids of the reviews still pending.
 */
export function forgetReviewDrafts(sessionId: string, live: readonly string[]): void {
  const prefix = `${sessionId}\n`;
  for (const key of drafts.keys())
    if (key.startsWith(prefix) && !live.includes(key.slice(prefix.length))) drafts.delete(key);
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
 * The button to press by default: the one the host recommends.
 *
 * @remarks
 * The host decides from the facts (a worktree not merged defaults to "先留着"); when it recommends none, the first.
 *
 * @sideEffects none
 * @param review - The review.
 * @returns The button.
 */
export function primaryOf(review: PendingReview): ReviewAction | undefined {
  return review.actions.find((action) => action.recommended) ?? review.actions[0];
}
