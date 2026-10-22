import { z } from "zod";

/** How many questions, choices and characters a question the agent asks may have (SPEC-0003, "工具"). */
export const QUESTION_LIMITS = {
  questions: 4,
  options: 4,
  header: 12,
  question: 1000,
  label: 60,
  description: 300,
  preview: 4000,
  other: 4000,
} as const;

/** One choice of a question the agent asks you. */
export const QuestionOption = z.strictObject({
  /** Without the "(Recommended)" the agent may have written. */
  label: z.string().min(1).max(QUESTION_LIMITS.label),
  description: z.string().max(QUESTION_LIMITS.description),
  /** Markdown to compare the choices by; single-choice questions only. */
  preview: z.string().max(QUESTION_LIMITS.preview).nullable(),
  recommended: z.boolean(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

/** One question the agent asks you with `ask_user` (SPEC-0003, "工具"). */
export const AskedQuestion = z.strictObject({
  /** A short name, for the card's tabs and the transcript. */
  header: z.string().min(1).max(QUESTION_LIMITS.header),
  question: z.string().min(1).max(QUESTION_LIMITS.question),
  multiSelect: z.boolean(),
  options: z.array(QuestionOption).min(2).max(QUESTION_LIMITS.options),
});
export type AskedQuestion = z.infer<typeof AskedQuestion>;

/** The questions an `ask_user` call waits on you to answer (SPEC-0003, "接口与数据"). */
export const PendingQuestion = z.strictObject({
  /** The tool call's id. */
  id: z.string().min(1).max(256),
  /** When the host was asked, in milliseconds since the Unix epoch. */
  askedAt: z.number().int().nonnegative(),
  questions: z.array(AskedQuestion).min(1).max(QUESTION_LIMITS.questions),
});
export type PendingQuestion = z.infer<typeof PendingQuestion>;

/** Your answer to one question: the choices picked, by index, and the other answer you wrote. */
export const QuestionAnswer = z.strictObject({
  selected: z.array(z.number().int().nonnegative()).max(QUESTION_LIMITS.options),
  other: z.string().max(QUESTION_LIMITS.other).nullable(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

/** Your answers to all the questions, one each in order, or skipping them all. */
export const QuestionReply = z.union([
  z.strictObject({ answers: z.array(QuestionAnswer).min(1).max(QUESTION_LIMITS.questions) }),
  z.strictObject({ skipped: z.literal(true) }),
]);
export type QuestionReply = z.infer<typeof QuestionReply>;

/** How a question ended, as the transcript keeps it; a direct reply follows as a steer. */
export const QuestionOutcome = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answered"), answers: z.array(QuestionAnswer) }),
  z.strictObject({ kind: z.literal("skipped") }),
  z.strictObject({ kind: z.literal("reply") }),
]);
export type QuestionOutcome = z.infer<typeof QuestionOutcome>;

/**
 * Whether an answer answers its question.
 *
 * @remarks
 * SPEC-0003, "作答": a single-choice question takes exactly one choice or the other answer, a
 * multiple-choice one at least one of them; choices are distinct and among the question's, and
 * an other answer has more than blanks. The host checks it, and the card enables "提交回答" by it.
 *
 * @sideEffects none
 * @param question - The question.
 * @param answer - The answer.
 * @returns Whether it does.
 */
export function answersQuestion(question: AskedQuestion, answer: QuestionAnswer): boolean {
  const known = answer.selected.every((index) => index >= 0 && index < question.options.length);
  const distinct = new Set(answer.selected).size === answer.selected.length;
  if (!known || !distinct) return false;
  if (answer.other !== null && answer.other.trim() === "") return false;
  const count = answer.selected.length + (answer.other === null ? 0 : 1);
  return question.multiSelect ? count >= 1 : count === 1;
}
