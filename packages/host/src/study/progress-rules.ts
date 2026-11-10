import {
  STUDY_LIMITS,
  type SessionStudy,
  type StudyAction,
  type StudyKind,
  type StudyNext,
  type StudyProgress,
} from "@atrium/protocol";
import type { FileGap, FileStep, StudyFile } from "./progress";

/** What a rule refuses with: the tools' codes and the commands' (SPEC-0008, "ML2 定的细节"). */
export type StudyRuleCode =
  | "study_ladder_size"
  | "study_ladder_set"
  | "study_steps_set"
  | "study_bad_report"
  | "study_not_found"
  | "study_not_allowed"
  | "study_mark_refused"
  | "study_gaps_full"
  | "study_not_available"
  | "agent_bad_request";

/**
 * A rule refusing a change.
 *
 * @remarks
 * The host turns it into a tool's or a command's error code.
 *
 * @sideEffects none
 */
export class StudyRuleError extends Error {
  /**
   * A refusal with its code and parameters.
   *
   * @remarks
   * The host sends only codes and parameters (AGENTS.md).
   *
   * @sideEffects none
   * @param code - The code.
   * @param params - Its parameters.
   */
  constructor(
    readonly code: StudyRuleCode,
    readonly params: Readonly<Record<string, number>> = {},
  ) {
    super(code);
  }
}

/** The steps the host puts after a level's lessons, in order (SPEC-0008, "一级 = 一串步骤"). */
const AFTER_LESSONS = ["sheet", "project", "exam", "up"] as const;

/** A lesson's or step's part a mark is about. */
export type StepMark = "lesson" | "quiz" | "step" | "later";

/** What `nextOf` reads of a direction's sessions. */
export interface StudySession {
  readonly sessionId: string;
  readonly study: SessionStudy | null;
  readonly updatedAt: number;
  readonly archived: boolean;
}

/**
 * The next id with a prefix: one more than the highest number used.
 *
 * @remarks
 * Ids are the host's (`l1`, `s1`, `g1`…), never reused even after a hand edit removed one.
 *
 * @sideEffects none
 * @param prefix - `l`, `s` or `g`.
 * @param used - The ids there are.
 * @returns The id.
 */
function nextId(prefix: string, used: readonly { readonly id: string }[]): string {
  let highest = 0;
  for (const { id } of used) {
    const number = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : Number.NaN;
    if (Number.isInteger(number) && number > highest) highest = number;
  }
  return `${prefix}${String(highest + 1)}`;
}

/**
 * A level's steps: its lessons, then the four steps after them.
 *
 * @remarks
 * Numbered from `s1` in order, so ids are unique within the level.
 *
 * @sideEffects none
 * @param lessons - The lessons' titles.
 * @returns The steps.
 */
function stepsFor(lessons: readonly string[]): FileStep[] {
  const steps: FileStep[] = [];
  for (const title of lessons)
    steps.push({ id: nextId("s", steps), kind: "lesson", title, lesson: null, quiz: null, done: null });
  for (const kind of AFTER_LESSONS) steps.push({ id: nextId("s", steps), kind, done: null });
  return steps;
}

/**
 * The display name changed (`study_set_name`).
 *
 * @remarks
 * The directory keeps its name (SPEC-0008, "讨论").
 *
 * @sideEffects none
 * @param file - The file.
 * @param name - The name.
 * @returns The file changed.
 */
export function setName(file: StudyFile, name: string): StudyFile {
  return { ...file, name };
}

/**
 * The profile's fields given replaced (`study_set_profile`).
 *
 * @remarks
 * Others, the fields it does not know included, stay.
 *
 * @sideEffects none
 * @param file - The file.
 * @param profile - The fields given.
 * @returns The file changed.
 */
export function setProfile(
  file: StudyFile,
  profile: {
    readonly goal?: string | undefined;
    readonly weeklyHours?: string | undefined;
    readonly language?: string | undefined;
  },
): StudyFile {
  const given = Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined));
  return { ...file, profile: { ...file.profile, ...given } };
}

/**
 * The ladder written, with the starting level's steps (`study_set_ladder`).
 *
 * @remarks
 * SPEC-0008, "ML2 定的细节": 2–6 levels or `study_ladder_size`; once only (`study_ladder_set`);
 * the first level not skipped is current, and gets the lessons and the four steps after them.
 *
 * @sideEffects none
 * @param file - The file.
 * @param ladder - The levels and the starting level's lessons.
 * @returns The file changed.
 * @throws {StudyRuleError} As above, or `agent_bad_request` when every level is skipped.
 */
export function setLadder(
  file: StudyFile,
  ladder: {
    readonly levels: readonly {
      readonly name: string;
      readonly topics: string;
      readonly pass: string;
      readonly skip?: boolean | undefined;
    }[];
    readonly lessons: readonly string[];
  },
): StudyFile {
  if (file.ladder !== undefined) throw new StudyRuleError("study_ladder_set");
  const got = ladder.levels.length;
  if (got < STUDY_LIMITS.minLevels || got > STUDY_LIMITS.maxLevels) {
    throw new StudyRuleError("study_ladder_size", { min: STUDY_LIMITS.minLevels, max: STUDY_LIMITS.maxLevels, got });
  }
  const start = ladder.levels.findIndex((level) => level.skip !== true);
  if (start === -1) throw new StudyRuleError("agent_bad_request");
  const levels = ladder.levels.map((level, at) => ({
    id: `l${String(at + 1)}`,
    name: level.name,
    topics: level.topics,
    pass: level.pass,
    state: level.skip === true ? ("skipped" as const) : at === start ? ("current" as const) : ("todo" as const),
  }));
  return {
    ...file,
    ladder: levels,
    steps: { [`l${String(start + 1)}`]: stepsFor(ladder.lessons) },
    gaps: file.gaps ?? [],
    finishedAt: file.finishedAt ?? null,
  };
}

/**
 * The current level's lessons written, when it has none (`study_set_steps`).
 *
 * @remarks
 * For the plan session after an upgrade (ML3), only for the level it was opened for: an old plan
 * session kept or restored never writes a later level's (SPEC-0008, "ML3 定的细节 · 排计划"). A level
 * with no steps gets the lessons and the four steps after them; one hand-edited down to some of
 * those four keeps them after the lessons, the lessons numbered after their ids.
 *
 * @sideEffects none
 * @param file - The file.
 * @param lessons - The lessons' titles.
 * @param level - The level the plan session is recorded at.
 * @returns The file changed.
 * @throws {StudyRuleError} `study_not_found` without a current level; `study_not_allowed` for
 * another level; `study_steps_set` when it has lessons.
 */
export function setSteps(file: StudyFile, lessons: readonly string[], level: string | undefined): StudyFile {
  const current = file.ladder?.find((one) => one.state === "current");
  if (current === undefined) throw new StudyRuleError("study_not_found");
  if (level !== current.id) throw new StudyRuleError("study_not_allowed");
  const there = file.steps?.[current.id] ?? [];
  if (there.some((step) => step.kind === "lesson")) throw new StudyRuleError("study_steps_set");
  if (there.length === 0) return { ...file, steps: { ...file.steps, [current.id]: stepsFor(lessons) } };
  const added: FileStep[] = [];
  for (const title of lessons) {
    added.push({ id: nextId("s", [...there, ...added]), kind: "lesson", title, lesson: null, quiz: null, done: null });
  }
  return { ...file, steps: { ...file.steps, [current.id]: [...added, ...there] } };
}

/**
 * A step changed in place, the others as they were.
 *
 * @remarks
 * Found by level and step id.
 *
 * @sideEffects none
 * @param file - The file.
 * @param level - The level.
 * @param step - The step.
 * @param change - What it becomes.
 * @returns The file changed.
 * @throws {StudyRuleError} `study_not_found`.
 */
function withStep(file: StudyFile, level: string, step: string, change: (step: FileStep) => FileStep): StudyFile {
  const steps = file.steps?.[level];
  const found = steps?.find((one) => one.id === step);
  if (steps === undefined || found === undefined) throw new StudyRuleError("study_not_found");
  return { ...file, steps: { ...file.steps, [level]: steps.map((one) => (one === found ? change(one) : one)) } };
}

/**
 * The agent's mark, over whatever mark there was, its other fields kept.
 *
 * @remarks
 * The agent's report wins over a manual mark (SPEC-0008, "一级 = 一串步骤").
 *
 * @sideEffects none
 * @param mark - The mark there was.
 * @returns The agent's.
 */
function byAgent(mark: object | null): { by: "agent" } {
  return { ...mark, by: "agent" };
}

/**
 * What a session reported done (`study_report`), at its record's level and step.
 *
 * @remarks
 * SPEC-0008, "ML2 定的细节": a lesson is taught, with no score; a quiz has a score, and its
 * lesson becomes the agent's too; a cheat sheet or project is done, with no score; an exam is
 * done with its score.
 *
 * @sideEffects none
 * @param file - The file.
 * @param study - The session's record.
 * @param args - The score, if any.
 * @returns The file changed.
 * @throws {StudyRuleError} `study_not_allowed`, `study_not_found` or `study_bad_report`.
 */
export function report(
  file: StudyFile,
  study: SessionStudy,
  args: { readonly score?: number | undefined; readonly of?: number | undefined },
): StudyFile {
  const { kind, level, step } = study;
  if (!["lesson", "quiz", "sheet", "project", "exam"].includes(kind)) throw new StudyRuleError("study_not_allowed");
  if (level === undefined || step === undefined) throw new StudyRuleError("study_not_found");
  const scored = kind === "quiz" || kind === "exam";
  const { score, of } = args;
  if (scored ? score === undefined || of === undefined || score > of : score !== undefined || of !== undefined) {
    throw new StudyRuleError("study_bad_report");
  }
  return withStep(file, level, step, (found) => {
    const lessonUse = kind === "lesson" || kind === "quiz";
    if (lessonUse !== (found.kind === "lesson") || (!lessonUse && found.kind !== kind)) {
      throw new StudyRuleError("study_not_found");
    }
    if (found.kind === "lesson") {
      return kind === "lesson"
        ? { ...found, lesson: byAgent(found.lesson) }
        : {
            ...found,
            lesson: byAgent(found.lesson),
            quiz: { ...byAgent(found.quiz), score: score ?? 0, of: of ?? 1 },
          };
    }
    return { ...found, done: { ...byAgent(found.done), ...(scored ? { score, of } : {}) } };
  });
}

/**
 * A gap a session found (`study_add_gap`), from its record's level and step.
 *
 * @remarks
 * Ids go on from the highest; at most `STUDY_LIMITS.maxGaps`.
 *
 * @sideEffects none
 * @param file - The file.
 * @param study - The session's record.
 * @param args - What the learner does not understand, and the question's number.
 * @returns The file changed.
 * @throws {StudyRuleError} `study_not_found` for a step not there; `study_gaps_full`, with the
 * limit, past it.
 */
export function addGap(
  file: StudyFile,
  study: SessionStudy,
  args: { readonly text: string; readonly question?: number | undefined },
): StudyFile {
  const { level, step } = study;
  if (level === undefined || step === undefined || file.steps?.[level]?.some((one) => one.id === step) !== true) {
    throw new StudyRuleError("study_not_found");
  }
  const gaps = file.gaps ?? [];
  if (gaps.length >= STUDY_LIMITS.maxGaps) throw new StudyRuleError("study_gaps_full", { max: STUDY_LIMITS.maxGaps });
  const gap: FileGap = {
    id: nextId("g", gaps),
    text: args.text,
    from: { level, step, ...(args.question === undefined ? {} : { question: args.question }) },
    fixed: null,
  };
  return { ...file, gaps: [...gaps, gap] };
}

/**
 * A gap changed in place.
 *
 * @remarks
 * Found by id.
 *
 * @sideEffects none
 * @param file - The file.
 * @param gapId - The gap.
 * @param change - What it becomes.
 * @returns The file changed.
 * @throws {StudyRuleError} `study_not_found`.
 */
function withGap(file: StudyFile, gapId: string, change: (gap: FileGap) => FileGap): StudyFile {
  const gaps = file.gaps ?? [];
  const found = gaps.find((gap) => gap.id === gapId);
  if (found === undefined) throw new StudyRuleError("study_not_found");
  return { ...file, gaps: gaps.map((gap) => (gap === found ? change(gap) : gap)) };
}

/**
 * The gap a Feynman session is for, fixed by the agent (`study_fix_gap`).
 *
 * @remarks
 * Over a manual mark, as the agent's reports are.
 *
 * @sideEffects none
 * @param file - The file.
 * @param gapId - The gap.
 * @returns The file changed.
 * @throws {StudyRuleError} `study_not_found`.
 */
export function fixGap(file: StudyFile, gapId: string): StudyFile {
  return withGap(file, gapId, (gap) => ({ ...gap, fixed: byAgent(gap.fixed) }));
}

/**
 * A gap marked fixed by hand, or that mark taken back (`mark_study_gap`).
 *
 * @remarks
 * SPEC-0008, "手动标完成": only a gap not fixed is marked; only a manual mark is taken back; nothing
 * in a finished direction.
 *
 * @sideEffects none
 * @param file - The file.
 * @param gapId - The gap.
 * @param fixed - Mark it, or take the mark back.
 * @returns The file changed.
 * @throws {StudyRuleError} `study_mark_refused` in a finished direction, or as above; `study_not_found`.
 */
export function markGap(file: StudyFile, gapId: string, fixed: boolean): StudyFile {
  // A finished direction is only looked back on (SPEC-0008, "ML2 定的细节").
  if ((file.finishedAt ?? null) !== null) return refused();
  return withGap(file, gapId, (gap) => {
    if (fixed ? gap.fixed !== null : gap.fixed?.by !== "manual") throw new StudyRuleError("study_mark_refused");
    return { ...gap, fixed: fixed ? { by: "manual" } : null };
  });
}

/**
 * Refuses a mark the rules do not allow.
 *
 * @remarks
 * See `markStep`.
 *
 * @sideEffects none
 * @throws {StudyRuleError} `study_mark_refused`, always.
 */
function refused(): never {
  throw new StudyRuleError("study_mark_refused");
}

/**
 * A step's part marked done by hand, or a manual mark taken back (`mark_study_step`).
 *
 * @remarks
 * SPEC-0008, "手动标完成":
 * - only what is not done is marked, and only on a step not done; the quiz brings its lesson,
 *   the whole step its lesson and quiz; `later` needs the lesson taught and no quiz, and is done;
 * - only a manual mark is taken back, with the manual marks after it on the step; the whole
 *   step's takes back the parts it marked with it (`parts`), unless the agent reported them since;
 * - a step after the lessons has only `step`, and the upgrade none;
 * - nothing in a finished direction (ML3).
 *
 * @sideEffects none
 * @param file - The file.
 * @param level - The level.
 * @param step - The step.
 * @param mark - The part.
 * @param done - Mark it, or take the mark back.
 * @returns The file changed.
 * @throws {StudyRuleError} `study_not_found` or `study_mark_refused`.
 */
export function markStep(file: StudyFile, level: string, step: string, mark: StepMark, done: boolean): StudyFile {
  // A finished direction is only looked back on (SPEC-0008, "ML2 定的细节").
  if ((file.finishedAt ?? null) !== null) return refused();
  return withStep(file, level, step, (found) => {
    const manual = { by: "manual" as const };
    if (found.kind !== "lesson") {
      // The upgrade is done by upgrading, never by a mark (prototype 1A).
      if (mark !== "step" || found.kind === "up") return refused();
      if (done ? found.done !== null : found.done?.by !== "manual") return refused();
      return { ...found, done: done ? manual : null };
    }
    /** The manual marks after the lesson taken back too. */
    const laterParts = {
      quiz: found.quiz === null || found.quiz.by === "agent" ? found.quiz : null,
      done: found.done?.by === "manual" ? null : found.done,
    };
    if (done) {
      if (found.done !== null) return refused();
      switch (mark) {
        case "lesson":
          return found.lesson === null ? { ...found, lesson: manual } : refused();
        case "quiz":
          return found.quiz === null ? { ...found, lesson: found.lesson ?? manual, quiz: manual } : refused();
        case "later":
          return found.lesson !== null && found.quiz === null
            ? { ...found, quiz: { by: "later" }, done: manual }
            : refused();
        case "step":
        default: {
          // What it marks with it, so taking it back takes those back too.
          const parts = (["lesson", "quiz"] as const).filter((part) => found[part] === null);
          return {
            ...found,
            lesson: found.lesson ?? manual,
            quiz: found.quiz ?? manual,
            done: { ...manual, ...(parts.length === 0 ? {} : { parts }) },
          };
        }
      }
    }
    switch (mark) {
      case "lesson":
        return found.lesson?.by === "manual" ? { ...found, lesson: null, ...laterParts } : refused();
      case "quiz":
        return found.quiz?.by === "manual" ? { ...found, quiz: null, done: laterParts.done } : refused();
      case "later":
        return found.quiz?.by === "later" ? { ...found, quiz: null, done: laterParts.done } : refused();
      case "step":
      default: {
        if (found.done?.by !== "manual") return refused();
        const parts: readonly string[] = found.done.parts ?? [];
        // A part this mark marked, still by hand, goes; one marked before it or reported since stays.
        return {
          ...found,
          lesson: parts.includes("lesson") && found.lesson?.by === "manual" ? null : found.lesson,
          quiz: parts.includes("quiz") && found.quiz?.by === "manual" ? null : found.quiz,
          done: null,
        };
      }
    }
  });
}

/** A step-strip button that starts a session. */
export type StartAction = Extract<StudyAction, { type: "start" }>;

/**
 * Starting a session for a use.
 *
 * @remarks
 * Every use can be opened since ML3 (SPEC-0008, "ML3 定的细节 · 协议"); a plan has no step, nor
 * Feynman on a gap from an earlier level.
 *
 * @sideEffects none
 * @param kind - The use.
 * @param level - The level.
 * @param step - The step, if any.
 * @param gap - The gap, for Feynman.
 * @returns The action.
 */
function startAction(kind: StudyKind, level: string, step?: string, gap?: string): StartAction {
  return {
    type: "start",
    kind,
    level,
    ...(step === undefined ? {} : { step }),
    ...(gap === undefined ? {} : { gap }),
    available: true,
  };
}

/**
 * The session open for a use, level, step and gap: the latest of those not archived.
 *
 * @remarks
 * Running or not (SPEC-0008, "ML2 定的细节"), so a step never gets a second session; a start asked
 * for what has one gets it back (SPEC-0008, "ML3 定的细节 · 费曼和补测从哪开").
 *
 * @sideEffects none
 * @param study - The use, level, step and gap.
 * @param sessions - The direction's sessions.
 * @returns The session, or `null`.
 */
export function existingFor(study: StartFields, sessions: readonly StudySession[]): string | null {
  const open = sessions
    .filter((session) => !session.archived && session.study !== null && sameStart(session.study, study))
    .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
  return open?.sessionId ?? null;
}

/**
 * The session already open for what a start would open, or the start.
 *
 * @remarks
 * See `existingFor`.
 *
 * @sideEffects none
 * @param action - The start.
 * @param sessions - The direction's sessions.
 * @returns Going back to it, or the start.
 */
function openFor(action: StudyAction, sessions: readonly StudySession[]): StudyAction {
  if (action.type !== "start") return action;
  const open = existingFor(action, sessions);
  return open === null ? action : { type: "open", sessionId: open };
}

/** Whether a direction can be gone on with: archived, broken, of a later version or finished cannot. */
type DirectionState = { readonly archived: boolean; readonly broken: boolean; readonly newer: boolean };

/**
 * The current level of a direction that can be gone on with.
 *
 * @remarks
 * See `nextOf`.
 *
 * @sideEffects none
 * @param progress - The progress, or `null` under discussion.
 * @param state - Whether it is archived, broken or newer.
 * @returns The level, or `undefined`.
 */
function currentLevel(progress: StudyProgress | null, state: DirectionState) {
  if (progress === null || state.archived || state.broken || state.newer || progress.finishedAt !== null) {
    return undefined;
  }
  return progress.ladder.find((one) => one.state === "current");
}

/**
 * The step strip's buttons before a start is matched to the session it would open.
 *
 * @remarks
 * See `nextOf`.
 *
 * @sideEffects none
 * @param progress - The progress, or `null` under discussion.
 * @param state - Whether it is archived, broken or newer.
 * @returns The two buttons.
 */
function buttonsOf(progress: StudyProgress | null, state: DirectionState): StudyNext {
  const none: StudyNext = { primary: null, secondary: null };
  const level = currentLevel(progress, state);
  if (progress === null || level === undefined) return none;
  const levelSteps = progress.steps[level.id] ?? [];
  // A level with no lessons yet, as after an upgrade: plan it (SPEC-0008, "ML3 定的细节 · 升级").
  if (!levelSteps.some((one) => one.kind === "lesson"))
    return { primary: startAction("plan", level.id), secondary: null };
  const step = levelSteps.find((one) => one.done === null);
  if (step === undefined) return none;
  const at = { level: level.id, step: step.id };
  /**
   * The first gap not fixed that a step of this level found.
   *
   * @remarks
   * The one Feynman is offered on.
   *
   * @sideEffects none
   * @param stepId - The step.
   * @returns The gap, or `undefined`.
   */
  const gapOf = (stepId: string | undefined) =>
    progress.gaps.find((one) => one.fixed === null && one.from.level === level.id && one.from.step === stepId);
  if (step.kind === "up") {
    // The exam's gaps first, but not in the way (SPEC-0008, "ML3 定的细节 · 综合测验的漏洞和升级").
    const up: StudyAction = { type: "upgrade", level: level.id, available: true };
    const exam = levelSteps.find((one) => one.kind === "exam");
    const gap = gapOf(exam?.id);
    return gap === undefined
      ? { primary: up, secondary: null }
      : { primary: startAction("feynman", level.id, gap.from.step, gap.id), secondary: up };
  }
  if (step.kind !== "lesson") return { primary: startAction(step.kind, at.level, at.step), secondary: null };
  if (step.lesson === null) return { primary: startAction("lesson", at.level, at.step), secondary: null };
  if (step.quiz === null) {
    return { primary: startAction("quiz", at.level, at.step), secondary: { type: "mark", mark: "later", ...at } };
  }
  const gap = gapOf(at.step);
  return gap === undefined
    ? { primary: { type: "mark", mark: "step", ...at }, secondary: null }
    : {
        primary: startAction("feynman", at.level, at.step, gap.id),
        secondary: { type: "mark", mark: "step", ...at },
      };
}

/**
 * What the step strip offers (SPEC-0008, "下一步怎么算", "ML2 定的细节", "ML3 定的细节").
 *
 * @remarks
 * The current step is the current level's first not done. A level with no lessons yet: plan it. A
 * lesson: not taught, start it; taught and not quizzed, the quiz, or put it off; quizzed with a
 * gap of this step not fixed, Feynman on the first, or go on; else go on. The steps after the
 * lessons: start each; the upgrade last, after Feynman on the exam's first gap not fixed when
 * there is one. A start whose session is open goes back to it. An archived or broken direction,
 * one whose file is of a later version (read, never written), one finished, and one with no
 * current level offer nothing.
 *
 * @sideEffects none
 * @param progress - The progress, or `null` under discussion.
 * @param sessions - The direction's sessions.
 * @param state - Whether the direction is archived, its file broken or of a later version.
 * @returns The two buttons.
 */
export function nextOf(
  progress: StudyProgress | null,
  sessions: readonly StudySession[],
  state: DirectionState,
): StudyNext {
  const next = buttonsOf(progress, state);
  return { primary: next.primary === null ? null : openFor(next.primary, sessions), secondary: next.secondary };
}

/**
 * The sessions that can be started now (SPEC-0008, "ML3 定的细节 · 费曼和补测从哪开").
 *
 * @remarks
 * The main button's start (a plan included); Feynman on every gap not fixed, of any level, as a
 * session of the current level, with the gap's step only when the gap is of this level; the quiz
 * of every step of the current level put off ("以后再测"). Nothing for a direction that cannot be
 * gone on with. `start_study_session` takes only these.
 *
 * @sideEffects none
 * @param progress - The progress, or `null` under discussion.
 * @param state - Whether the direction is archived, its file broken or of a later version.
 * @returns The starts, without repeats.
 */
export function startable(progress: StudyProgress | null, state: DirectionState): StartAction[] {
  const level = currentLevel(progress, state);
  if (progress === null || level === undefined) return [];
  const starts: StartAction[] = [];
  /**
   * Adds a start not listed yet.
   *
   * @remarks
   * The main button's Feynman is a gap's too.
   *
   * @sideEffects Updates `starts`.
   * @param action - The start.
   */
  const add = (action: StartAction) => {
    if (!starts.some((one) => sameStart(one, action))) starts.push(action);
  };
  const { primary } = buttonsOf(progress, state);
  if (primary?.type === "start") add(primary);
  for (const gap of progress.gaps) {
    if (gap.fixed !== null) continue;
    add(startAction("feynman", level.id, gap.from.level === level.id ? gap.from.step : undefined, gap.id));
  }
  for (const step of progress.steps[level.id] ?? []) {
    if (step.kind === "lesson" && step.quiz?.by === "later") add(startAction("quiz", level.id, step.id));
  }
  return starts;
}

/** What a start opens: a use, at a level, step and gap. */
type StartFields = Pick<SessionStudy, "kind" | "level" | "step" | "gap">;

/**
 * Whether two starts open the same: the same use, level, step and gap.
 *
 * @remarks
 * See `startable`.
 *
 * @sideEffects none
 * @param a - One.
 * @param b - The other.
 * @returns Whether.
 */
export function sameStart(a: StartFields, b: StartFields): boolean {
  return a.kind === b.kind && a.level === b.level && a.step === b.step && a.gap === b.gap;
}

/** The uses whose sessions are a level's, archived with it (SPEC-0008, "ML3 定的细节 · 升级确认框"). */
const LEVEL_USES: ReadonlySet<StudyKind> = new Set(["plan", "lesson", "quiz", "feynman", "sheet", "project", "exam"]);

/**
 * The sessions of a level an upgrade archives.
 *
 * @remarks
 * Not archived, recorded at the level, for any use but the discussion and asking; their children
 * go with them when they are archived (SPEC-0002). By the sessions' records, not the file: a level
 * the agent edited by hand may leave some out (accepted, SPEC-0008).
 *
 * @sideEffects none
 * @param sessions - The direction's sessions.
 * @param level - The level.
 * @returns Their ids, in the order given.
 */
export function levelSessions(sessions: readonly StudySession[], level: string): string[] {
  return sessions
    .filter(({ study, archived }) => !archived && study !== null && study.level === level && LEVEL_USES.has(study.kind))
    .map(({ sessionId }) => sessionId);
}

/**
 * A level upgraded (`upgrade_study`, SPEC-0008, "ML3 定的细节 · 升级").
 *
 * @remarks
 * Only the current level, and only once its upgrade is the step to do (every step before it done):
 * the upgrade is marked done by you (you pressed it; no mark makes or takes it back), the level
 * done, and the first level after it still to learn current, skipped ones left; after the last,
 * the direction is finished at `now`. The next level's lessons come from its plan session.
 *
 * @sideEffects none
 * @param file - The file.
 * @param level - The level the client saw as current.
 * @param now - The time, as ISO text, for `finishedAt`.
 * @returns The file changed.
 * @throws {StudyRuleError} `study_not_available` otherwise, as when a second window upgrades again.
 */
export function upgrade(file: StudyFile, level: string, now: string): StudyFile {
  const levels = file.ladder ?? [];
  const at = levels.findIndex((one) => one.id === level && one.state === "current");
  const levelSteps = file.steps?.[level] ?? [];
  const step = levelSteps.find((one) => one.done === null);
  if (at === -1 || step?.kind !== "up") throw new StudyRuleError("study_not_available");
  const next = levels.findIndex((one, index) => index > at && one.state === "todo");
  return {
    ...file,
    ladder: levels.map((one, index) =>
      index === at ? { ...one, state: "done" } : index === next ? { ...one, state: "current" } : one,
    ),
    steps: {
      ...file.steps,
      [level]: levelSteps.map((one) => (one === step ? { ...one, done: { by: "manual" } } : one)),
    },
    ...(next === -1 ? { finishedAt: now } : {}),
  };
}
