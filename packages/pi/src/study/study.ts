import { STUDY_LIMITS, SessionStudy, type StudyKind, seenLength } from "@atrium/protocol";
import { decodeArgument, encodeArgument } from "../agent/agent";
import { escapeAttribute } from "../agent/words";

/** The flag the host gives a session of a direction its use with (SPEC-0008, "ML2 定的细节"). */
export const STUDY_FLAG = "atrium-study";

/** The hidden command the host starts a session it opened for a use with. */
export const STUDY_COMMAND = "atrium-study";

/** The system prompt section the extension adds; pi wraps it in a tag of this name. */
export const STUDY_SECTION = "atrium_study";

/** The study tools, by name. */
export const STUDY_TOOLS = [
  "study_set_name",
  "study_set_profile",
  "study_set_ladder",
  "study_set_steps",
  "study_report",
  "study_add_gap",
  "study_fix_gap",
] as const;
export type StudyTool = (typeof STUDY_TOOLS)[number];

/** The uses a session can be started with: every one but asking, which has no tools or prompt. */
export type StudyUse = Exclude<StudyKind, "ask">;

/**
 * Which study tools a session of each use has (SPEC-0008, "ML2 定的细节").
 *
 * @remarks
 * Registered only for these; a session without the flag has none at all (2026-11-09).
 */
export const TOOLS_BY_USE: { readonly [Use in StudyUse]: readonly StudyTool[] } = {
  discuss: ["study_set_name", "study_set_profile", "study_set_ladder"],
  plan: ["study_set_steps"],
  lesson: ["study_report"],
  sheet: ["study_report"],
  project: ["study_report"],
  quiz: ["study_report", "study_add_gap"],
  exam: ["study_report", "study_add_gap"],
  feynman: ["study_fix_gap"],
};

/** What the host tells the extension about the session's use. */
export interface StudyLaunch extends SessionStudy {
  readonly kind: StudyUse;
  /**
   * `none` for a quiz with no lesson session to come from, which quizzes from the notes and the
   * progress (SPEC-0008, "ML3 定的细节 · 测验"); left out otherwise.
   */
  readonly context?: "none";
}

/**
 * Encodes a session's use for `--atrium-study`.
 *
 * @remarks
 * Base64url JSON, as `--atrium-agent` is.
 *
 * @sideEffects none
 * @param study - The use, and which level, step or gap.
 * @returns The flag's value.
 */
export function studyArgument(study: StudyLaunch): string {
  return encodeArgument({ v: 1, ...study });
}

/**
 * Reads `--atrium-study`.
 *
 * @remarks
 * Anything but a version 1 object with a use other than asking reads as none: the session then
 * gets no study tools and no study prompt, as a session outside a direction.
 *
 * @sideEffects none
 * @param flag - The flag's value, as pi gives it.
 * @returns The use, or `null`.
 */
export function readStudyArgument(flag: unknown): StudyLaunch | null {
  if (typeof flag !== "string" || flag === "") return null;
  const value = decodeArgument(flag);
  if (typeof value !== "object" || value === null || Reflect.get(value, "v") !== 1) return null;
  const context: unknown = Reflect.get(value, "context");
  // Only a quiz may come without its lesson (ML3); any other value, or on another use, is no flag.
  if (context !== undefined && (context !== "none" || Reflect.get(value, "kind") !== "quiz")) return null;
  const study = SessionStudy.safeParse(
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== "v" && key !== "context")),
  );
  if (!study.success || study.data.kind === "ask") return null;
  return { ...study.data, kind: study.data.kind, ...(context === "none" ? { context } : {}) };
}

/**
 * Which level, step or gap the session is for, as the prompt names them.
 *
 * @remarks
 * Ids only, escaped as attribute values: the titles are the learner's to read in the file.
 *
 * @sideEffects none
 * @param launch - The session's use.
 * @returns The words, or empty for none.
 */
function where(launch: StudyLaunch): string {
  const parts = [
    launch.level === undefined ? null : `level="${escapeAttribute(launch.level)}"`,
    launch.step === undefined ? null : `step="${escapeAttribute(launch.step)}"`,
    launch.gap === undefined ? null : `gap="${escapeAttribute(launch.gap)}"`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "" : ` (${parts.join(" ")} in .atrium-study.json)`;
}

/**
 * The rule that keeps the agent out of the direction's `AGENTS.md`.
 *
 * @remarks
 * Atrium writes the study method there and the learner may edit it; in the real-model check a
 * discussion rewrote it (SPEC-0008, "真实模型检查后改"). Only the prompt says so: the host adds no
 * block.
 */
export const AGENTS_RULE =
  "Do not modify AGENTS.md in the working directory: Atrium put the study method there, and only the learner edits it. The learner's profile is in .atrium-study.json; record it with study_set_profile, not in a file.";

/**
 * The common part of every study session's instructions.
 *
 * @remarks
 * Progress lives only in `.atrium-study.json` and only the tools change it (SPEC-0008, 2026-11-05).
 */
// Stryker disable StringLiteral,ArrayDeclaration: the model's instructions are words, tuned by the real-model checks (ML2, ML5); the tests pin how they are put together.
const COMMON = [
  "This session is part of a learning direction in Atrium's study mode. The learner's progress is in .atrium-study.json in the working directory: read it (and AGENTS.md, the notes of the last lesson in notes/ and the gaps not yet fixed) before you start, so the learner does not have to repeat themselves.",
  "Never edit .atrium-study.json yourself. Progress changes only through the study_* tools you have; if you do not call them, the progress does not move.",
  AGENTS_RULE,
  "Keep content in Markdown files: resources.md, cheatsheet.md (one section per level), notes/ (one note per lesson).",
  "Never say Atrium's internal ids (such as l1, s2 or g3) to the learner: call a level by its number and name, a lesson by its title, a gap by what it is about.",
].join("\n");

/** How a quiz asks (SPEC-0008, "ML3 定的细节 · 测验的题数和计分"). */
const QUESTIONS =
  "Ask one question at a time, from easy to hard: 5 to 10 questions, and stop early after two in a row the learner cannot answer.";

/** How the quiz and the exam put a question and judge it. */
const CHOICE = [
  "Ask every multiple-choice question with the ask_user tool, as a question card with the choices as its options; never list the choices in your text instead.",
  "Judge each answer as soon as it comes: say whether it was right, and when it was wrong or partly right, explain the right answer and what was missed right then, before you ask the next question. Do not leave the explanations for the summary at the end.",
].join("\n");

/** How the quiz and the exam record gaps. */
const GAPS =
  "Each time an answer shows a gap, call study_add_gap with what the learner does not understand and the question's number.";

/**
 * Each use's instructions, after the six prompts of sairahul1's article (SPEC-0008, "会话的用途").
 *
 * @remarks
 * First versions, to be tuned in use (2026-11-05).
 */
const USES: { readonly [Use in StudyUse]: string } = {
  discuss: [
    "This is the discussion that starts the direction. Do these, in order:",
    "1. Profile: the learner's goal, background, time per week, and language or environment. Ask only what their first message did not say, with ask_user. Record it with study_set_profile. If a better display name for the direction becomes clear, call study_set_name.",
    "2. Placement: ask one question at a time, from easy to hard, and judge each answer at once. No score; it only finds where to start and which levels can be skipped.",
    `3. Ladder: map the path from complete beginner to the learner's goal as a ladder of ${String(STUDY_LIMITS.minLevels)} to ${String(STUDY_LIMITS.maxLevels)} levels (skipped ones included). For each level give a name, what it covers, and how to tell it is passed. Then pick the 5 best resources for this learner (search the web with web_search and web_fetch when you have them; if not, say in resources.md that they were not checked online), with the order to use them in, and write them to resources.md. Plan the starting level as a 20-hour plan of lessons (at most ${String(STUDY_LIMITS.maxLessons)}), each a small piece the learner practises in lab/.`,
    "4. Confirm: Show the ladder and the starting level's lessons together as a proposal and ask the learner to confirm, in their language (for example: 准备这样排，确认吗？). Do not say the ladder is set or saved before you have called study_set_ladder. If they want changes, change the proposal and ask again.",
    "5. Set: Only after the learner confirms, call study_set_ladder once with the levels (skip: true for the ones placement showed they can skip) and the starting level's lesson titles. That ends the discussion: the ladder cannot be changed afterwards.",
    "6. Stop: Once it succeeds, wrap up in two or three sentences (what was set, and that the first lesson starts from the direction's home in Atrium), then stop. Do no more work with files in this session: do not create directories or files and do not edit resources.md or anything else.",
  ].join("\n"),
  plan: [
    "This session plans the current level, which the learner just reached. Do these, in order:",
    "1. Read the ladder, what the learner did in the levels before, and the gaps not yet fixed in .atrium-study.json.",
    `2. Plan the current level as a 20-hour plan of lessons (at most ${String(STUDY_LIMITS.maxLessons)}), each a small piece the learner practises in lab/; a lesson may review gaps not yet fixed.`,
    "3. Confirm: Show the lessons as a proposal and ask the learner to confirm, in their language (for example: 准备这样排，确认吗？). Do not say the lessons are set or saved before you have called study_set_steps. If they want changes, change the proposal and ask again.",
    "4. Set: Only after the learner confirms, call study_set_steps once with the lesson titles: it can be called only once for a level.",
    "5. Stop: Once it succeeds, wrap up in two or three sentences (how many lessons, and that the first one starts from the direction's home in Atrium), then stop.",
    "You may add this level's resources to resources.md; do not change the ladder or AGENTS.md.",
    "Apart from adding to resources.md, do not create or edit any file in this session: nothing in lab/, no probe, scratch or test files.",
  ].join("\n"),
  lesson: [
    "This is one lesson: teach the step of the current level named in .atrium-study.json, as part of the 20-hour plan.",
    "Teach one idea at a time, then let the learner try it in lab/ before going on; read their code, point at what is wrong, and do not write it for them. Keep the lesson to what the step covers.",
    "Do not create probe or scratch files to try things yourself. The files you write are the lesson's note in notes/ and, only when the lesson needs one, a short starting file in lab/ that the learner then fills in.",
    "Write a short note of the lesson to notes/. When the lesson is done, call study_report with no score.",
  ].join("\n"),
  quiz: [
    "Quiz the learner on the lesson until they break.",
    QUESTIONS,
    CHOICE,
    "Score each question out of 10 (partial credit allowed). At the end call study_report with score as the sum and of as 10 times the number of questions asked.",
    GAPS,
    "Calling study_report again in this session overwrites the score.",
  ].join("\n"),
  feynman: [
    "The gap is the entry of gaps in .atrium-study.json with the id above: read its text and where it came from first.",
    "Run the Feynman loop on it: explain it simply, as to a 12-year-old; then have the learner explain it back in their own words; where their explanation is unclear or wrong, explain that part again, and repeat until it is clear.",
    "Write the final clean explanation to notes/ as a Feynman note for this gap.",
    "Call study_fix_gap only once the learner has explained it back clearly in their own words. If they still cannot, do not call it: say what is still unclear and stop.",
  ].join("\n"),
  sheet:
    "Condense the current level into a one-page cheat sheet the learner can review in 5 minutes: the key ideas, commands and pitfalls. Add it to cheatsheet.md as this level's section, then call study_report with no score.",
  project:
    "Guide the learner through the level's passing project in lab/, against the level's pass criterion in .atrium-study.json. Do not write the project for them; review it. When it meets the criterion, call study_report with no score.",
  exam: [
    "Give the level's final exam: 10 questions over the whole level, from easy to hard, one at a time, judging each at once.",
    CHOICE,
    "Score each question out of 10 (partial credit allowed). At the end call study_report with score as the sum and of as 100.",
    GAPS,
    "Calling study_report again in this session overwrites the score.",
  ].join("\n"),
};
// Stryker restore StringLiteral,ArrayDeclaration

/**
 * The system prompt's instructions for a session of a use.
 *
 * @remarks
 * SPEC-0008, "会话的用途": the common rules, then the use's own.
 *
 * @sideEffects none
 * @param launch - The session's use.
 * @returns The section's text.
 */
export function studyPrompt(launch: StudyLaunch): string {
  return [COMMON, "", `This session's use: ${launch.kind}${where(launch)}.`, USES[launch.kind]].join("\n");
}

/**
 * What the model is told when the host starts a session it opened, in place of a message of yours.
 *
 * @remarks
 * The UI shows the turn as its use and step; the model gets this (SPEC-0008, "ML2 定的细节").
 *
 * @sideEffects none
 * @param launch - The session's use.
 * @returns The message's content.
 */
export function kickoffText(launch: StudyLaunch): string {
  const none = launch.context === "none";
  return [
    `<atrium-study use="${launch.kind}"${launch.level === undefined ? "" : ` level="${escapeAttribute(launch.level)}"`}${launch.step === undefined ? "" : ` step="${escapeAttribute(launch.step)}"`}${launch.gap === undefined ? "" : ` gap="${escapeAttribute(launch.gap)}"`}${none ? ' context="none"' : ""}>`,
    "Atrium opened this session for the learner. This is not the learner's message. Read the progress, then begin as your instructions for this use say.",
    // A quiz is the lesson's child with its history, or, with no lesson session, a new session (ML3).
    ...(launch.kind !== "quiz"
      ? []
      : none
        ? [
            "There is no conversation of the lesson in this session: build the questions from the lesson's note in notes/ and from .atrium-study.json.",
          ]
        : ["The lesson's conversation is above: quiz on what was taught there, with its examples."]),
    "</atrium-study>",
  ].join("\n");
}

/**
 * Reads the argument of `/atrium-study start`.
 *
 * @remarks
 * Only `{ v: 1 }`: the use comes from the flag, never from the command (security.md).
 *
 * @sideEffects none
 * @param args - The command's arguments.
 * @returns Whether it is a start the extension acts on.
 */
export function readStart(args: string): boolean {
  const [action, argument, ...rest] = args.trim().split(/\s+/u);
  if (action !== "start" || argument === undefined || rest.length > 0) return false;
  const value = decodeArgument(argument);
  return (
    typeof value === "object" && value !== null && Object.keys(value).length === 1 && Reflect.get(value, "v") === 1
  );
}

/**
 * The hidden command that starts a session the host opened.
 *
 * @remarks
 * See `readStart`.
 *
 * @sideEffects none
 * @returns The command.
 */
export function startCommand(): string {
  return `/${STUDY_COMMAND} start ${encodeArgument({ v: 1 })}`;
}

/** The most characters of a direction's display name. */
const NAME_MAX = 256;

/** A tool's text limits, by parameter: what the extension checks before asking the host. */
const TEXT_FIELDS: { readonly [Tool in StudyTool]?: Readonly<Record<string, number>> } = {
  study_set_name: { name: NAME_MAX },
  study_set_profile: { goal: STUDY_LIMITS.profile, weeklyHours: STUDY_LIMITS.profile, language: STUDY_LIMITS.profile },
  study_add_gap: { text: STUDY_LIMITS.gap },
};

/**
 * Whether a text is over its limit, in characters as a reader sees them.
 *
 * @remarks
 * SPEC-0008, "ML2 定的细节" (`seenLength`, as the host counts); the display name also within the
 * 256 UTF-16 units the list carries.
 *
 * @sideEffects none
 * @param text - The text.
 * @param max - The limit.
 * @returns Whether it is over.
 */
function tooLong(text: string, max: number): boolean {
  // The display name also fits the 256 UTF-16 units the list carries (protocol `Direction.name`).
  return seenLength(text) > max || (max === NAME_MAX && text.length > NAME_MAX);
}

/**
 * The first text over its limit in a study tool's parameters, if any.
 *
 * @remarks
 * As ADR-0013, point 9: the model gets `agent_text_too_long` with the field and the limit, not a
 * bad request. Lists of levels and lessons are checked item by item.
 *
 * @sideEffects none
 * @param tool - The tool.
 * @param params - Its parameters.
 * @returns The field and its limit, or `null`.
 */
export function studyTooLong(
  tool: StudyTool,
  params: Readonly<Record<string, unknown>>,
): { readonly field: string; readonly max: number } | null {
  for (const [field, max] of Object.entries(TEXT_FIELDS[tool] ?? {})) {
    const value = params[field];
    if (typeof value === "string" && tooLong(value, max)) return { field, max };
  }
  const levels = params["levels"];
  if (tool === "study_set_ladder" && Array.isArray(levels)) {
    for (const level of levels) {
      for (const [field, max] of [
        ["name", STUDY_LIMITS.levelName],
        ["topics", STUDY_LIMITS.topics],
        ["pass", STUDY_LIMITS.pass],
      ] as const) {
        const value: unknown = typeof level === "object" && level !== null ? Reflect.get(level, field) : undefined;
        if (typeof value === "string" && tooLong(value, max)) return { field: `levels[].${field}`, max };
      }
    }
  }
  const lessons = params["lessons"];
  if (Array.isArray(lessons)) {
    for (const lesson of lessons) {
      if (typeof lesson === "string" && tooLong(lesson, STUDY_LIMITS.lessonTitle)) {
        return { field: "lessons[]", max: STUDY_LIMITS.lessonTitle };
      }
    }
  }
  return null;
}
