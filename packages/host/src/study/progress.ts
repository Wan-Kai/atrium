import { STUDY_LIMITS, StudyBy, type StudyProgress, StudyRef, seenText } from "@atrium/protocol";
import { z } from "zod";

/** The marker's version this host writes; a later one is read but not written (SPEC-0008, "ML2 定的细节"). */
export const STUDY_VERSION = 1;

/** A part of a step marked done; other fields are kept. */
const Mark = z.looseObject({ by: StudyBy });

/** A score out of a total, `score` no more than `of`. */
const scored = { score: z.number().int().nonnegative(), of: z.number().int().min(1).max(STUDY_LIMITS.maxQuestions) };

/** A lesson's quiz, as the file holds it. */
const Quiz = z.discriminatedUnion("by", [
  z.looseObject({ by: z.literal("agent"), ...scored }).refine((quiz) => quiz.score <= quiz.of),
  z.looseObject({ by: z.literal("manual") }),
  z.looseObject({ by: z.literal("later") }),
]);

/** A lesson, as the file holds it. */
const Lesson = z.looseObject({
  id: StudyRef,
  kind: z.literal("lesson"),
  title: seenText(STUDY_LIMITS.lessonTitle, 1),
  lesson: Mark.nullable(),
  quiz: Quiz.nullable(),
  /** `parts`: what marking the whole step marked with it, taken back with it (SPEC-0008, "手动标完成"). */
  done: Mark.extend({
    parts: z
      .array(z.enum(["lesson", "quiz"]))
      .max(2)
      .optional(),
  }).nullable(),
});

/** One of the four steps after a level's lessons, as the file holds it. */
const Fixed = z.looseObject({
  id: StudyRef,
  kind: z.enum(["sheet", "project", "exam", "up"]),
  done: z
    .looseObject({ by: StudyBy, score: scored.score.optional(), of: scored.of.optional() })
    .refine((done) => (done.score === undefined) === (done.of === undefined) && (done.score ?? 0) <= (done.of ?? 0))
    .nullable(),
});

/** A step, as the file holds it. */
const Step = z.discriminatedUnion("kind", [Lesson, Fixed]);

/** A level, as the file holds it. */
const Level = z.looseObject({
  id: StudyRef,
  name: seenText(STUDY_LIMITS.levelName, 1),
  topics: seenText(STUDY_LIMITS.topics),
  pass: seenText(STUDY_LIMITS.pass),
  state: z.enum(["skipped", "current", "done", "todo"]),
});

/** A gap, as the file holds it. */
const Gap = z.looseObject({
  id: StudyRef,
  text: seenText(STUDY_LIMITS.gap, 1),
  from: z.looseObject({
    level: StudyRef,
    step: StudyRef,
    question: z.number().int().min(1).max(STUDY_LIMITS.maxQuestions).optional(),
  }),
  fixed: Mark.nullable(),
});

/** The profile, as the file holds it. */
const Profile = z.looseObject({
  goal: seenText(STUDY_LIMITS.profile).optional(),
  weeklyHours: seenText(STUDY_LIMITS.profile).optional(),
  language: seenText(STUDY_LIMITS.profile).optional(),
});

/**
 * Whether a list's ids are all different.
 *
 * @remarks
 * Levels, steps and gaps are found by id; two of one id would make that ambiguous.
 *
 * @sideEffects none
 * @param items - The list.
 * @returns Whether they are.
 */
function distinct(items: readonly { readonly id: string }[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

/**
 * A direction's `.atrium-study.json`, read strictly where Atrium reads it and loosely elsewhere
 * (SPEC-0008, "ML2 定的细节").
 *
 * @remarks
 * Every object keeps the fields it does not know, all the way down, so a write keeps them. Any
 * shape it does know being wrong makes the file broken: a ladder of a size outside 2–6, ids used
 * twice, steps of a level the ladder lacks, a score above its total.
 */
export const StudyFile = z
  .looseObject({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(256),
    createdAt: z.string().optional(),
    profile: Profile.optional(),
    ladder: z.array(Level).min(STUDY_LIMITS.minLevels).max(STUDY_LIMITS.maxLevels).refine(distinct).optional(),
    steps: z
      .record(
        StudyRef,
        z
          .array(Step)
          .max(STUDY_LIMITS.maxLessons + 4)
          .refine(distinct),
      )
      .optional(),
    gaps: z.array(Gap).max(STUDY_LIMITS.maxGaps).refine(distinct).optional(),
    finishedAt: z.string().max(64).nullable().optional(),
  })
  .refine((file) =>
    Object.keys(file.steps ?? {}).every((level) => file.ladder?.some((one) => one.id === level) === true),
  );
export type StudyFile = z.infer<typeof StudyFile>;
export type FileStep = z.infer<typeof Step>;
export type FileGap = z.infer<typeof Gap>;

/**
 * What a marker file's text says, or that it is broken.
 *
 * @remarks
 * See `StudyFile`; text that is not JSON is broken too.
 *
 * @sideEffects none
 * @param text - The file's text.
 * @returns The file, or `null` when broken.
 */
export function parseStudyFile(text: string): StudyFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = StudyFile.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A mark as the protocol has it: only `by`.
 *
 * @remarks
 * The protocol's objects are strict; the file's other fields stay in the file.
 *
 * @sideEffects none
 * @param mark - The mark, or `null`.
 * @returns The mark.
 */
function markOf(mark: { readonly by: "agent" | "manual" } | null): { by: "agent" | "manual" } | null {
  return mark === null ? null : { by: mark.by };
}

/**
 * A direction's progress, as the protocol sends it: only what it knows.
 *
 * @remarks
 * `null` while there is no ladder: the direction is under discussion (SPEC-0008, "讨论").
 *
 * @sideEffects none
 * @param file - The file.
 * @returns The progress, or `null`.
 */
export function progressOf(file: StudyFile): StudyProgress | null {
  if (file.ladder === undefined) return null;
  const profile = file.profile ?? {};
  return {
    profile: {
      ...(profile.goal === undefined ? {} : { goal: profile.goal }),
      ...(profile.weeklyHours === undefined ? {} : { weeklyHours: profile.weeklyHours }),
      ...(profile.language === undefined ? {} : { language: profile.language }),
    },
    ladder: file.ladder.map(({ id, name, topics, pass, state }) => ({ id, name, topics, pass, state })),
    steps: Object.fromEntries(
      Object.entries(file.steps ?? {}).map(([level, steps]) => [
        level,
        steps.map((step) =>
          step.kind === "lesson"
            ? {
                id: step.id,
                kind: step.kind,
                title: step.title,
                lesson: markOf(step.lesson),
                quiz:
                  step.quiz === null
                    ? null
                    : step.quiz.by === "agent"
                      ? { by: "agent" as const, score: step.quiz.score, of: step.quiz.of }
                      : { by: step.quiz.by },
                done: markOf(step.done),
              }
            : {
                id: step.id,
                kind: step.kind,
                done:
                  step.done === null
                    ? null
                    : {
                        by: step.done.by,
                        ...(step.done.score === undefined ? {} : { score: step.done.score }),
                        ...(step.done.of === undefined ? {} : { of: step.done.of }),
                      },
              },
        ),
      ]),
    ),
    gaps: (file.gaps ?? []).map((gap) => ({
      id: gap.id,
      text: gap.text,
      from: {
        level: gap.from.level,
        step: gap.from.step,
        ...(gap.from.question === undefined ? {} : { question: gap.from.question }),
      },
      fixed: markOf(gap.fixed),
    })),
    finishedAt: file.finishedAt ?? null,
  };
}
