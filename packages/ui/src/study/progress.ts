import type {
  Direction,
  SessionStudy,
  SessionSummary,
  StudyAction,
  StudyGap,
  StudyKind,
  StudyProgress,
  StudyStep,
} from "@atrium/protocol";

// How the UI words and draws a direction's progress (SPEC-0008, "ML2 定的细节"; design-language
// "学习模式", prototype study-progress-states 1A/2D/3A/4A/5A). The host sends ids and states only.

/** Each use's name, as a session's label and a step's kind say it. */
export const KIND_NAMES: Readonly<Record<StudyKind, string>> = {
  discuss: "讨论",
  plan: "排计划",
  lesson: "上课",
  quiz: "测验",
  feynman: "费曼",
  sheet: "速查表",
  project: "过关项目",
  exam: "综合测验",
  ask: "随口问",
};

/** A level of the ladder with its number, from 1. */
export interface NumberedLevel {
  readonly id: string;
  readonly number: number;
  readonly name: string;
}

/**
 * The current level, numbered.
 *
 * @remarks
 * The one the ladder marks current; `null` when none is, as once the last is passed.
 *
 * @sideEffects none
 * @param progress - The progress.
 * @returns The level, or `null`.
 */
export function currentLevel(progress: StudyProgress): NumberedLevel | null {
  const at = progress.ladder.findIndex((level) => level.state === "current");
  const level = progress.ladder[at];
  return level === undefined ? null : { id: level.id, number: at + 1, name: level.name };
}

/**
 * The level the strip and the home show: the current one, or the last once none is.
 *
 * @remarks
 * A finished direction has no current level; its last level's steps stay shown, all lit, with
 * their sessions (prototype 2D).
 *
 * @sideEffects none
 * @param progress - The progress.
 * @returns The level, or `null` for an empty ladder.
 */
export function shownLevel(progress: StudyProgress): NumberedLevel | null {
  const current = currentLevel(progress);
  if (current !== null) return current;
  const last = progress.ladder.at(-1);
  return last === undefined ? null : { id: last.id, number: progress.ladder.length, name: last.name };
}

/**
 * A step's title as the UI shows it: a lesson's own, or its kind's name for the steps after.
 *
 * @remarks
 * The upgrade names the level it goes up to when there is one (prototype: "升到第 3 级").
 *
 * @sideEffects none
 * @param step - The step.
 * @param levelNumber - Its level's number.
 * @param levels - How many levels the ladder has.
 * @returns The title.
 */
export function stepTitle(step: StudyStep, levelNumber: number, levels: number): string {
  if (step.kind === "lesson") return step.title;
  if (step.kind === "up") return levelNumber < levels ? `升到第 ${String(levelNumber + 1)} 级` : "学完最后一级";
  return KIND_NAMES[step.kind];
}

/**
 * A session's label from its use: "上课 · 第 2 级第 4 步", or the use alone.
 *
 * @remarks
 * For a session with no title yet, a tab and the home's list, and the first turn's source line
 * (design-language "学习模式", "宿主开的学习会话第一轮").
 *
 * @sideEffects none
 * @param study - The session's use.
 * @param progress - The direction's progress, if any.
 * @returns The label.
 */
export function studyLabel(study: SessionStudy, progress: StudyProgress | null): string {
  const name = KIND_NAMES[study.kind];
  if (progress === null || study.level === undefined) return name;
  const levelAt = progress.ladder.findIndex((level) => level.id === study.level);
  if (levelAt === -1) return name;
  const stepAt =
    study.step === undefined ? -1 : (progress.steps[study.level] ?? []).findIndex((step) => step.id === study.step);
  return stepAt === -1
    ? `${name} · 第 ${String(levelAt + 1)} 级`
    : `${name} · 第 ${String(levelAt + 1)} 级第 ${String(stepAt + 1)} 步`;
}

/** One of a lesson's three parts, as its small square shows it (prototype 1A, 4A). */
export type SubState = "done" | "manual" | "gap" | "later" | "todo";

/**
 * The three parts of a lesson: taught, quizzed, gaps fixed.
 *
 * @remarks
 * A part marked by hand is hollow (1A); a quiz put off is dashed (4A); the third is a gap still
 * open from this step, else done once the quiz is.
 *
 * @sideEffects none
 * @param step - The lesson.
 * @param level - Its level's id.
 * @param gaps - The direction's gaps.
 * @returns The three states.
 */
export function lessonParts(
  step: Extract<StudyStep, { kind: "lesson" }>,
  level: string,
  gaps: readonly StudyGap[],
): readonly [SubState, SubState, SubState] {
  const taught: SubState = step.lesson === null ? "todo" : step.lesson.by === "manual" ? "manual" : "done";
  const quizzed: SubState =
    step.quiz === null ? "todo" : step.quiz.by === "later" ? "later" : step.quiz.by === "manual" ? "manual" : "done";
  const open = gaps.some((gap) => gap.fixed === null && gap.from.level === level && gap.from.step === step.id);
  const fixed: SubState = open ? "gap" : step.quiz !== null && step.quiz.by !== "later" ? "done" : "todo";
  return [taught, quizzed, fixed];
}

/**
 * Where the current step stands, in a few words, after its title on the strip.
 *
 * @remarks
 * A lesson's part; "进行中" while its session runs.
 *
 * @sideEffects none
 * @param step - The step.
 * @param level - Its level's id.
 * @param gaps - The direction's gaps.
 * @param running - Whether the session open for it runs.
 * @returns The words.
 */
export function stepPhase(step: StudyStep, level: string, gaps: readonly StudyGap[], running: boolean): string {
  if (running) return "进行中";
  if (step.kind !== "lesson") return "还没开始";
  if (step.lesson === null) return "还没开始";
  if (step.quiz === null) return "上课完成";
  return lessonParts(step, level, gaps)[2] === "gap" ? "有漏洞没补" : "测完了";
}

/**
 * A strip button's words.
 *
 * @remarks
 * SPEC-0008, "下一步怎么算": what each action of the host's next step is called.
 *
 * @sideEffects none
 * @param action - The action.
 * @returns The words.
 */
export function actionLabel(action: StudyAction): string {
  switch (action.type) {
    case "open":
      return "回到会话";
    case "upgrade":
      return "升级";
    case "mark":
      return action.mark === "later" ? "以后再测" : "进入下一步";
    case "start":
    default:
      return {
        lesson: "开始上课",
        quiz: "开始测验",
        feynman: "跑费曼",
        sheet: "生成速查表",
        project: "开始项目",
        exam: "开始测验",
        discuss: "开始讨论",
        plan: "排计划",
        ask: "随口问",
      }[action.kind];
  }
}

/** A dot of the step strip: a lesson's square or a later step's circle, and how far it is. */
export interface StripDot {
  readonly id: string;
  readonly round: boolean;
  readonly state: "done" | "current" | "todo";
}

/** What the step strip shows for a direction (design-language "常驻步骤条", prototype 2D). */
export type StripView =
  | { readonly kind: "discussing" }
  | { readonly kind: "broken"; readonly dots: number }
  | {
      /** `newer`: a file of a later version, read and shown, never written. */
      readonly kind: "learning" | "archived" | "finished" | "newer";
      readonly level: NumberedLevel | null;
      readonly levels: number;
      readonly dots: readonly StripDot[];
      /** The current step: its number in the level, title and phase; `null` with none. */
      readonly step: { readonly number: number; readonly title: string; readonly phase: string } | null;
    };

/** How many placeholder dots a direction whose file cannot be read shows. */
const BROKEN_DOTS = 13;

/**
 * What the strip shows for a direction and its sessions.
 *
 * @remarks
 * Prototype 2D: the dots always show. Under discussion, one sentence; a broken file, empty
 * placeholders; archived, and a file of a later version, the current dot a grey ring; finished,
 * every dot lit, of the last level.
 *
 * @sideEffects none
 * @param direction - The direction.
 * @param sessions - The direction's sessions.
 * @returns The view.
 */
export function stripView(
  direction: Pick<Direction, "broken" | "newer" | "archived" | "progress" | "next">,
  sessions: readonly Pick<SessionSummary, "sessionId" | "running">[],
): StripView {
  if (direction.broken) return { kind: "broken", dots: BROKEN_DOTS };
  const progress = direction.progress;
  if (progress === null) return { kind: "discussing" };
  const finished = progress.finishedAt !== null;
  const level = shownLevel(progress);
  const steps = level === null ? [] : (progress.steps[level.id] ?? []);
  const currentAt = steps.findIndex((step) => step.done === null);
  const dots = steps.map((step, at) => ({
    id: step.id,
    round: step.kind !== "lesson",
    state:
      finished || step.done !== null ? ("done" as const) : at === currentAt ? ("current" as const) : ("todo" as const),
  }));
  const current = steps[currentAt];
  const primary = direction.next.primary;
  const running =
    primary?.type === "open" && sessions.some((session) => session.sessionId === primary.sessionId && session.running);
  return {
    kind: direction.archived ? "archived" : direction.newer ? "newer" : finished ? "finished" : "learning",
    level,
    levels: progress.ladder.length,
    dots,
    step:
      current === undefined || level === null
        ? null
        : {
            number: currentAt + 1,
            title: stepTitle(current, level.number, progress.ladder.length),
            phase: stepPhase(current, level.id, progress.gaps, running),
          },
  };
}

/**
 * A learning home card's line for a direction with a ladder: "共 4 级 · 第 2 级第 4 步 · 漏洞 2".
 *
 * @remarks
 * design-language "学习模式" (ML2): the gaps only when some are open.
 *
 * @sideEffects none
 * @param progress - The progress.
 * @returns The line.
 */
export function progressLine(progress: StudyProgress): string {
  const level = currentLevel(progress);
  const steps = level === null ? [] : (progress.steps[level.id] ?? []);
  const at = steps.findIndex((step) => step.done === null);
  const open = progress.gaps.filter((gap) => gap.fixed === null).length;
  const where =
    progress.finishedAt !== null
      ? "已学完"
      : level === null
        ? null
        : at === -1
          ? `第 ${String(level.number)} 级`
          : `第 ${String(level.number)} 级第 ${String(at + 1)} 步`;
  return [`共 ${String(progress.ladder.length)} 级`, where, open > 0 ? `漏洞 ${String(open)}` : null]
    .filter((part) => part !== null)
    .join(" · ");
}
