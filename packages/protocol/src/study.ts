import { z } from "zod";
import { SessionId } from "./ids";
import { seenText } from "./text";

/** What a learning session is for (SPEC-0008, "会话的用途"). */
export const StudyKind = z.enum(["discuss", "plan", "lesson", "quiz", "feynman", "sheet", "project", "exam", "ask"]);
export type StudyKind = z.infer<typeof StudyKind>;

/** An id in a direction's progress: a level, a step or a gap. */
export const StudyRef = z.string().min(1).max(64);

/** What a session of a direction is for, and which level, step or gap (SPEC-0008, "索引"). */
export const SessionStudy = z.strictObject({
  kind: StudyKind,
  level: StudyRef.optional(),
  step: StudyRef.optional(),
  gap: StudyRef.optional(),
});
export type SessionStudy = z.infer<typeof SessionStudy>;

/**
 * The limits of a direction's progress (SPEC-0008, "ML2 定的细节").
 *
 * @remarks
 * Text in characters as a reader sees them (`seenLength`); the ladder's level count is the user's 2–6 (2026-11-05).
 */
export const STUDY_LIMITS = {
  minLevels: 2,
  maxLevels: 6,
  minLessons: 1,
  maxLessons: 30,
  maxGaps: 200,
  levelName: 60,
  topics: 500,
  pass: 500,
  lessonTitle: 120,
  gap: 1000,
  profile: 200,
  maxQuestions: 100,
} as const;

/** Who marked a part of a step done: the agent's report, or you by hand. */
export const StudyBy = z.enum(["agent", "manual"]);
export type StudyBy = z.infer<typeof StudyBy>;

/** A part of a step marked done, and by whom. */
const Mark = z.strictObject({ by: StudyBy });

/** A score out of a total: `0 ≤ score ≤ of`. */
const Score = z.strictObject({
  score: z.number().int().nonnegative(),
  of: z.number().int().min(1).max(STUDY_LIMITS.maxQuestions),
});

/**
 * A lesson's quiz: reported with its score, marked by hand without one, or put off ("以后再测").
 *
 * @remarks
 * SPEC-0008, "ML2 定的细节".
 */
export const StudyQuiz = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("agent"), ...Score.shape }),
  z.strictObject({ by: z.literal("manual") }),
  z.strictObject({ by: z.literal("later") }),
]);
export type StudyQuiz = z.infer<typeof StudyQuiz>;

/** A lesson: taught, quizzed, then gone on from (SPEC-0008, "一级 = 一串步骤"). */
export const StudyLesson = z.strictObject({
  id: StudyRef,
  kind: z.literal("lesson"),
  title: seenText(STUDY_LIMITS.lessonTitle, 1),
  lesson: Mark.nullable(),
  quiz: StudyQuiz.nullable(),
  done: Mark.nullable(),
});
export type StudyLesson = z.infer<typeof StudyLesson>;

/** One of the steps after a level's lessons: the cheat sheet, the project, the exam, the upgrade. */
export const StudyFixedStep = z.strictObject({
  id: StudyRef,
  kind: z.enum(["sheet", "project", "exam", "up"]),
  /** Done, with the exam's score when it has one. */
  done: z
    .strictObject({ by: StudyBy, score: z.number().int().nonnegative().optional(), of: Score.shape.of.optional() })
    .nullable(),
});
export type StudyFixedStep = z.infer<typeof StudyFixedStep>;

/** A step of a level. */
export const StudyStep = z.discriminatedUnion("kind", [StudyLesson, StudyFixedStep]);
export type StudyStep = z.infer<typeof StudyStep>;

/** A level of the ladder (SPEC-0008, "讨论"). */
export const StudyLevel = z.strictObject({
  id: StudyRef,
  name: seenText(STUDY_LIMITS.levelName, 1),
  topics: seenText(STUDY_LIMITS.topics),
  pass: seenText(STUDY_LIMITS.pass),
  state: z.enum(["skipped", "current", "done", "todo"]),
});
export type StudyLevel = z.infer<typeof StudyLevel>;

/** A gap a quiz found, and whether it was fixed (SPEC-0008, "会话的用途"). */
export const StudyGap = z.strictObject({
  id: StudyRef,
  text: seenText(STUDY_LIMITS.gap, 1),
  from: z.strictObject({
    level: StudyRef,
    step: StudyRef,
    question: z.number().int().min(1).max(STUDY_LIMITS.maxQuestions).optional(),
  }),
  fixed: Mark.nullable(),
});
export type StudyGap = z.infer<typeof StudyGap>;

/** The one-line profile the home shows; the rest is in `AGENTS.md`. */
export const StudyProfile = z.strictObject({
  goal: seenText(STUDY_LIMITS.profile).optional(),
  weeklyHours: seenText(STUDY_LIMITS.profile).optional(),
  language: seenText(STUDY_LIMITS.profile).optional(),
});
export type StudyProfile = z.infer<typeof StudyProfile>;

/**
 * A direction's progress, as its `.atrium-study.json` holds it once the discussion wrote a ladder
 * (SPEC-0008, "ML2 定的细节").
 */
export const StudyProgress = z.strictObject({
  profile: StudyProfile,
  ladder: z.array(StudyLevel).min(STUDY_LIMITS.minLevels).max(STUDY_LIMITS.maxLevels),
  /** The steps of each level planned, by level id. */
  steps: z.record(StudyRef, z.array(StudyStep).max(STUDY_LIMITS.maxLessons + 4)),
  gaps: z.array(StudyGap).max(STUDY_LIMITS.maxGaps),
  /** When the last level was passed; `null` while learning (SPEC-0008, "升级"). */
  finishedAt: z.string().max(64).nullable(),
});
export type StudyProgress = z.infer<typeof StudyProgress>;

/**
 * What a step-strip button does, as the host worked it out (SPEC-0008, "下一步怎么算").
 *
 * @remarks
 * `available` was false in ML2 for the sessions not made yet (drawn as "即将开放"); since ML3
 * every one can be pressed (SPEC-0008, "ML3 定的细节 · 协议"). A start has no `step` for a plan
 * session (a level with no lessons yet) and for Feynman on a gap carried from an earlier level.
 */
export const StudyAction = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    kind: StudyKind,
    level: StudyRef,
    step: StudyRef.optional(),
    gap: StudyRef.optional(),
    available: z.boolean(),
  }),
  /** Goes back to the session already open for this step. */
  z.strictObject({ type: z.literal("open"), sessionId: SessionId }),
  /** "以后再测" or "进入下一步". */
  z.strictObject({ type: z.literal("mark"), mark: z.enum(["later", "step"]), level: StudyRef, step: StudyRef }),
  z.strictObject({ type: z.literal("upgrade"), level: StudyRef, available: z.boolean() }),
]);
export type StudyAction = z.infer<typeof StudyAction>;

/** The step strip's two buttons; both `null` when there is nothing to do. */
export const StudyNext = z.strictObject({ primary: StudyAction.nullable(), secondary: StudyAction.nullable() });
export type StudyNext = z.infer<typeof StudyNext>;
