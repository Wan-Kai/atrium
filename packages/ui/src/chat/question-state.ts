import { answersQuestion } from "@atrium/client";
import type { AskedQuestion, QuestionAnswer, QuestionReply } from "@atrium/protocol";

/**
 * What you picked for one question: options by index, and the other answer, `null` while it is not
 * picked (SPEC-0003, "作答").
 */
export interface QuestionPick {
  readonly selected: readonly number[];
  readonly other: string | null;
  /** What was written in the other answer while it is not picked, to bring back when it is again. */
  readonly kept?: string;
}

/** The card's state for one call's questions: which one shows, and what you picked for each. */
export interface QuestionDraft {
  readonly current: number;
  readonly picks: readonly QuestionPick[];
}

/** Nothing picked. */
const NOTHING: QuestionPick = { selected: [], other: null };

/**
 * Picks an option, or the other answer, whose index is one past the options.
 *
 * @remarks
 * SPEC-0003, "作答": a single-choice question takes one of them, a multiple-choice one toggles it.
 * What was written in the other answer is kept while it is not picked, and comes back with it, so
 * a click away loses no text.
 *
 * @sideEffects none
 * @param question - The question.
 * @param pick - What was picked so far.
 * @param index - The option, or `question.options.length` for the other answer.
 * @returns What is picked now.
 */
export function choose(question: AskedQuestion, pick: QuestionPick, index: number): QuestionPick {
  const isOther = index === question.options.length;
  const back = pick.other ?? pick.kept ?? "";
  const kept =
    pick.other !== null && pick.other !== ""
      ? { kept: pick.other }
      : pick.kept === undefined
        ? {}
        : { kept: pick.kept };
  if (!question.multiSelect)
    return isOther ? { selected: [], other: back } : { selected: [index], other: null, ...kept };
  if (isOther)
    return pick.other === null
      ? { selected: pick.selected, other: back }
      : { selected: pick.selected, other: null, ...kept };
  const selected = pick.selected.includes(index)
    ? pick.selected.filter((one) => one !== index)
    : [...pick.selected, index].toSorted((a, b) => a - b);
  return { selected, other: pick.other, ...(pick.kept === undefined ? {} : { kept: pick.kept }) };
}

/**
 * What a pick answers with: the other answer trimmed.
 *
 * @remarks
 * Blanks around what you wrote are not part of the answer.
 *
 * @sideEffects none
 * @param pick - The pick.
 * @returns The answer.
 */
function answerOf(pick: QuestionPick): QuestionAnswer {
  return { selected: [...pick.selected], other: pick.other === null ? null : pick.other.trim() };
}

/**
 * Whether a pick answers its question.
 *
 * @remarks
 * See `answersQuestion`: the other answer counts once something is written in it.
 *
 * @sideEffects none
 * @param question - The question.
 * @param pick - The pick.
 * @returns Whether it does.
 */
export function answered(question: AskedQuestion, pick: QuestionPick): boolean {
  return answersQuestion(question, answerOf(pick));
}

/**
 * The next question without an answer after one, coming round to the first.
 *
 * @remarks
 * Where the card moves after a single choice, "下一题" and Enter (SPEC-0003, "作答").
 *
 * @sideEffects none
 * @param questions - The questions.
 * @param picks - What was picked for each.
 * @param from - The question after which to look.
 * @returns Its index, or `null` when every one is answered.
 */
export function nextUnanswered(
  questions: readonly AskedQuestion[],
  picks: readonly QuestionPick[],
  from: number,
): number | null {
  for (let step = 1; step <= questions.length; step += 1) {
    const index = (from + step) % questions.length;
    const question = questions[index];
    // Stryker disable next-line ConditionalExpression: the index is below the length; the check is for the type.
    if (question !== undefined && !answered(question, picks[index] ?? NOTHING)) return index;
  }
  return null;
}

/**
 * The answers to send, once every question has one.
 *
 * @remarks
 * SPEC-0003, "作答": no question may be left unanswered.
 *
 * @sideEffects none
 * @param questions - The questions.
 * @param picks - What was picked for each.
 * @returns The reply, or `null`.
 */
export function replyOf(questions: readonly AskedQuestion[], picks: readonly QuestionPick[]): QuestionReply | null {
  const all = questions.every((question, index) => answered(question, picks[index] ?? NOTHING));
  return all ? { answers: questions.map((_, index) => answerOf(picks[index] ?? NOTHING)) } : null;
}

/** What you picked on cards not sent yet, by session and question, kept in the page only (SPEC-0003, "作答"). */
const drafts = new Map<string, { readonly questionId: string; readonly draft: QuestionDraft }>();

/**
 * What you picked for a session's questions so far, or nothing picked.
 *
 * @remarks
 * Kept while you switch sessions or tabs; a draft for other questions, or another number of them,
 * starts afresh.
 *
 * @sideEffects none
 * @param sessionId - The session.
 * @param questionId - The call's id.
 * @param count - How many questions it asks.
 * @returns The draft.
 */
export function readDraft(sessionId: string, questionId: string, count: number): QuestionDraft {
  const kept = drafts.get(sessionId);
  if (kept?.questionId === questionId && kept.draft.picks.length === count) return kept.draft;
  return { current: 0, picks: Array.from({ length: count }, () => NOTHING) };
}

/**
 * Keeps what you picked for a session's questions.
 *
 * @remarks
 * One draft per session: a session has at most one call's questions waiting.
 *
 * @sideEffects Updates the page's drafts.
 * @param sessionId - The session.
 * @param questionId - The call's id.
 * @param draft - The draft.
 */
export function writeDraft(sessionId: string, questionId: string, draft: QuestionDraft): void {
  drafts.set(sessionId, { questionId, draft });
}

/**
 * Forgets a session's draft unless it is for the questions still asked.
 *
 * @remarks
 * Once the questions end, what was picked for them is no use.
 *
 * @sideEffects Updates the page's drafts.
 * @param sessionId - The session.
 * @param questionId - The questions still asked, or `null` for none.
 */
export function forgetDrafts(sessionId: string, questionId: string | null): void {
  if (drafts.get(sessionId)?.questionId !== questionId) drafts.delete(sessionId);
}
