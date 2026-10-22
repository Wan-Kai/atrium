import { type AskedQuestion, QUESTION_LIMITS, QuestionAnswer, QuestionOutcome } from "@atrium/protocol";
import { z } from "zod";

/** The tool the agent asks you with (SPEC-0003, "工具"). */
export const ASK_USER_TOOL = "ask_user";

/** What a stopped `ask_user` throws, which pi keeps as its error result (SPEC-0003, "工具"). */
export const ASK_USER_STOPPED = "The user stopped the run before answering.";

/** How the user answered, as the host replies to `ask_user` (SPEC-0003, "接口与数据"). */
export type AskUserResult =
  | { readonly outcome: "answered"; readonly answers: readonly QuestionAnswer[] }
  | { readonly outcome: "skipped" }
  | { readonly outcome: "reply" };

/** A label's recommendation mark at its end: "(Recommended)" in any case, or "（推荐）" (SPEC-0003, "工具"). */
const RECOMMENDED = /\s*(?:\(recommended\)|（推荐）)\s*$/iu;

/** Labels that are the "Other" every question gets already. */
const RESERVED = new Set(["other", "其他"]);

/**
 * A question's shape as the model writes it; the limits are checked after, to word what to fix.
 *
 * pi runs a call with what it left out as `null` dropped and `"true"` / `"false"` read as booleans,
 * but keeps the arguments as written in its file, so they are read here the way pi ran them.
 */
const Written = z.looseObject({
  header: z.string(),
  question: z.string(),
  multiSelect: z.union([z.boolean(), z.enum(["true", "false"]), z.null()]).optional(),
  options: z.array(
    z.looseObject({ label: z.string(), description: z.string(), preview: z.string().nullable().optional() }),
  ),
});

/** The tool's arguments, as the model writes them. */
const WrittenCall = z.looseObject({ questions: z.array(Written) });

/**
 * A text's fault against its limit, if any.
 *
 * @remarks
 * Worded for the model to fix (see `checkQuestions`).
 *
 * @sideEffects none
 * @param what - What it is, as the error names it.
 * @param text - The text, trimmed.
 * @param limit - Its limit.
 * @param required - Whether it may be empty.
 * @returns The fault, or `null`.
 */
function fault(what: string, text: string, limit: number, required: boolean): string | null {
  if (required && text === "") return `the ${what} is empty.`;
  return text.length > limit ? `the ${what} is longer than ${String(limit)} characters.` : null;
}

/**
 * Reads one question as the model wrote it.
 *
 * @remarks
 * See `checkQuestions`.
 *
 * @sideEffects none
 * @param written - The question.
 * @param at - Its place, from 1, as the error names it.
 * @returns The question, or what to fix.
 */
function checkOne(written: z.infer<typeof Written>, at: number): AskedQuestion | string {
  const where = `Question ${String(at)}`;
  const header = written.header.trim();
  const question = written.question.trim();
  const headerFault = fault("header", header, QUESTION_LIMITS.header, true);
  if (headerFault !== null) return `${where}: ${headerFault}`;
  const questionFault = fault("question", question, QUESTION_LIMITS.question, true);
  if (questionFault !== null) return `${where}: ${questionFault}`;
  if (written.options.length < 2 || written.options.length > QUESTION_LIMITS.options)
    return `${where}: give between 2 and ${String(QUESTION_LIMITS.options)} options.`;
  const multiSelect = written.multiSelect === true || written.multiSelect === "true";
  const options: AskedQuestion["options"] = [];
  for (const [index, option] of written.options.entries()) {
    const place = `${where}, option ${String(index + 1)}`;
    const recommended = RECOMMENDED.test(option.label);
    const label = option.label.replace(RECOMMENDED, "").trim();
    const description = option.description.trim();
    // A blank preview shows nothing to compare: as none.
    const preview = option.preview == null || option.preview.trim() === "" ? null : option.preview;
    const problem =
      fault("label", label, QUESTION_LIMITS.label, true) ??
      fault("description", description, QUESTION_LIMITS.description, false) ??
      // Stryker disable next-line BooleanLiteral: a blank preview is none already, so one here is never empty.
      (preview === null ? null : fault("preview", preview, QUESTION_LIMITS.preview, true));
    if (problem !== null) return `${place}: ${problem}`;
    if (RESERVED.has(label.toLowerCase())) return `${place}: do not write an "Other" option; every question gets one.`;
    if (options.some((earlier) => earlier.label === label)) return `${where}: two options are labeled "${label}".`;
    if (multiSelect && preview !== null) return `${where}: only single-choice questions can have previews.`;
    options.push({ label, description, preview, recommended });
  }
  return { header, question, multiSelect, options };
}

/**
 * Reads the questions the model asked, or tells it what to fix.
 *
 * @remarks
 * SPEC-0003, "工具": 1 to 4 questions of 2 to 4 options; headers, questions and labels not empty,
 * each text within its limit; a label's "(Recommended)" or "（推荐）" taken off and kept as a flag;
 * no option the "Other" every question gets; labels distinct in a question, headers in the call;
 * previews only on single-choice questions, a blank one taken as none. The limits are not in the tool's schema, so the model
 * gets this text instead of pi's validation error (as ADR-0013, point 9).
 *
 * @sideEffects none
 * @param params - The tool's arguments.
 * @returns The questions, or what to fix.
 */
export function checkQuestions(
  params: unknown,
): { readonly ok: true; readonly questions: AskedQuestion[] } | { readonly ok: false; readonly error: string } {
  const call = WrittenCall.safeParse(params);
  if (!call.success || call.data.questions.length === 0 || call.data.questions.length > QUESTION_LIMITS.questions)
    return { ok: false, error: `Ask between 1 and ${String(QUESTION_LIMITS.questions)} questions.` };
  const questions: AskedQuestion[] = [];
  for (const [index, written] of call.data.questions.entries()) {
    const read = checkOne(written, index + 1);
    if (typeof read === "string") return { ok: false, error: read };
    if (questions.some((earlier) => earlier.header === read.header))
      return { ok: false, error: `Two questions have the header "${read.header}".` };
    questions.push(read);
  }
  return { ok: true, questions };
}

/**
 * The questions a call asked, as the transcript shows them.
 *
 * @remarks
 * Read from the call's arguments, which every step has, live or rebuilt, answered or stopped
 * (SPEC-0003, "对话记录"); arguments the tool would have refused show no questions.
 *
 * @sideEffects none
 * @param args - The call's arguments.
 * @returns The questions, or `null`.
 */
export function askedQuestions(args: unknown): AskedQuestion[] | null {
  const read = checkQuestions(args);
  return read.ok ? read.questions : null;
}

/**
 * One answer as the model reads it: the options' labels, and the other answer, joined.
 *
 * @remarks
 * Options in their order in the question, the other answer last.
 *
 * @sideEffects none
 * @param question - The question.
 * @param answer - The answer.
 * @returns The text.
 */
function oneAnswer(question: AskedQuestion, answer: QuestionAnswer): string {
  // Quoted, so a line break or a quote in what you wrote stays inside this question's answer.
  const picked = answer.selected
    .toSorted((a, b) => a - b)
    .flatMap((index) => {
      // Stryker disable next-line OptionalChaining: the host took only choices among the question's (`answersQuestion`); the check is for the type.
      const label = question.options[index]?.label;
      // Stryker disable next-line ConditionalExpression,ArrayDeclaration: as above.
      return label === undefined ? [] : [JSON.stringify(label)];
    });
  return [...picked, ...(answer.other === null ? [] : [`Other: ${JSON.stringify(answer.other.trim())}`])].join(", ");
}

/**
 * What `ask_user` tells the model the user did.
 *
 * @remarks
 * SPEC-0003, "工具": each question with its answer; a skip, to go on by its own judgment; a direct
 * reply, whose message follows as a steer.
 *
 * @sideEffects none
 * @param questions - The questions asked.
 * @param result - The host's answer.
 * @returns The text.
 */
export function answerText(questions: readonly AskedQuestion[], result: AskUserResult): string {
  if (result.outcome === "skipped")
    return "The user skipped these questions. Continue with your best judgment, or ask in a different way.";
  if (result.outcome === "reply") return "The user did not pick an answer and replied directly; their message follows.";
  const lines = questions.map((question, index) => {
    const answer = result.answers[index];
    // Stryker disable next-line ConditionalExpression,StringLiteral: the host took an answer for every question (`answerQuestion`); the fallback is for the type.
    return `${JSON.stringify(question.question)} = ${answer === undefined ? "" : oneAnswer(question, answer)}`;
  });
  return ["The user answered:", ...lines, "Go on with these answers in mind."].join("\n");
}

/** What `ask_user` keeps in its result's details: how the questions ended (SPEC-0003, "接口与数据"). */
const Details = z.looseObject({ v: z.literal(1), outcome: QuestionOutcome });

/**
 * How an `ask_user` call's questions ended, from its result's details.
 *
 * @remarks
 * A stopped call's result has pi's empty details, and reads as no outcome (SPEC-0003, "对话记录").
 *
 * @sideEffects none
 * @param details - The result's details.
 * @returns The outcome, or `null`.
 */
export function askUserOutcome(details: unknown): QuestionOutcome | null {
  const parsed = Details.safeParse(details);
  return parsed.success ? parsed.data.outcome : null;
}
