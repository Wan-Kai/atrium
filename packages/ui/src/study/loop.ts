import { splitSeen } from "@atrium/client";
import type {
  Control,
  SessionStudy,
  SessionSummary,
  StudyAction,
  StudyGap,
  StudyKind,
  StudyProgress,
  TranscriptItem,
} from "@atrium/protocol";
import { KIND_NAMES, currentLevel, shownLevel, stepTitle } from "./progress";

// How the UI works out and words the study loop (SPEC-0008, "ML3 定的细节"; design-language
// "学习模式 · ML3 学习循环", prototype study-loop 1A 2A 3B 4A 5B 6A 7C). The host sends ids,
// states and tool arguments only; every word here is the UI's.

/** What the loop reads of a session. */
export type LoopSession = Pick<
  SessionSummary,
  "sessionId" | "containerId" | "parent" | "study" | "archived" | "running" | "updatedAt"
>;

/** How long a gap's text may run in a Feynman session's name before it is cut. */
const GAP_NAME = 24;

/**
 * The lesson session a step's quiz would be a child of: the latest of its lesson sessions not archived.
 *
 * @remarks
 * The host picks the same one (SPEC-0008, "ML3 定的细节 · 测验"), as "回到这个会话" does.
 *
 * @sideEffects none
 * @param sessions - The direction's sessions.
 * @param level - The level.
 * @param step - The step.
 * @returns The session, or `undefined`.
 */
export function lessonSessionOf<T extends LoopSession>(
  sessions: readonly T[],
  level: string,
  step: string,
): T | undefined {
  return sessions
    .filter(
      ({ study, archived }) => !archived && study?.kind === "lesson" && study.level === level && study.step === step,
    )
    .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** A session's control as this window sees it, for a session it shows; `null` for one it does not. */
export type ControlOf = (sessionId: string) => Control | null;

/**
 * The lesson session a quiz start would fork from.
 *
 * @remarks
 * See `lessonSessionOf`; nothing for any other action.
 *
 * @sideEffects none
 * @param action - The button's action.
 * @param sessions - The direction's sessions.
 * @returns The lesson session, or `undefined`.
 */
export function quizLessonOf<T extends LoopSession>(action: StudyAction | null, sessions: readonly T[]): T | undefined {
  if (action?.type !== "start" || action.kind !== "quiz" || action.step === undefined) return undefined;
  return lessonSessionOf(sessions, action.level, action.step);
}

/**
 * Whether a button waits for its step's lesson turn to end: a quiz while the lesson is busy.
 *
 * @remarks
 * Prototype 2A, 2026-11-09 C: the host would answer `session_busy`, so "开始测验" (and "补测") is
 * faded with "等上课这一轮结束" and lights up once the turn ends. Busy is what this window can see:
 * the lesson running (a pi being started counts) by the list, and, for a lesson it shows, a stop,
 * a compaction or a restart under way or messages queued. The host still refuses one that slips through.
 *
 * @sideEffects none
 * @param action - The button's action.
 * @param sessions - The direction's sessions, of this direction only.
 * @param controlOf - The control of a session this window shows.
 * @returns Whether it waits.
 */
export function waitsForLesson(
  action: StudyAction | null,
  sessions: readonly LoopSession[],
  controlOf: ControlOf = () => null,
): boolean {
  const lesson = quizLessonOf(action, sessions);
  if (lesson === undefined) return false;
  if (lesson.running) return true;
  const control = controlOf(lesson.sessionId);
  return control !== null && (control.stopping || control.compacting || control.restarting || control.queue.length > 0);
}

/**
 * The sessions archived with a level: those of it not archived, discussions and asking left out,
 * with their children below them in the direction.
 *
 * @remarks
 * SPEC-0008, "ML3 定的细节 · 升级确认框": the host picks them by the same rule, and its count wins
 * when they differ.
 *
 * @sideEffects none
 * @param sessions - The direction's sessions.
 * @param level - The level.
 * @returns Their ids, the level's own first.
 */
export function levelSessions(sessions: readonly LoopSession[], level: string): string[] {
  const picked = sessions
    .filter(
      ({ study, archived }) =>
        !archived && study !== null && study.kind !== "discuss" && study.kind !== "ask" && study.level === level,
    )
    .map((session) => session.sessionId);
  const chosen = new Set(picked);
  // Children below a chosen one, however deep, in the same direction and not archived.
  for (let grew = true; grew;) {
    grew = false;
    for (const session of sessions) {
      const parent = session.parent?.sessionId;
      if (session.archived || chosen.has(session.sessionId) || parent === undefined || !chosen.has(parent)) continue;
      chosen.add(session.sessionId);
      picked.push(session.sessionId);
      grew = true;
    }
  }
  return picked;
}

/** The upgrade confirmation's words and numbers (prototype 4A). */
export interface UpgradeView {
  /** The last level: the direction becomes finished, no plan session opens. */
  readonly last: boolean;
  readonly title: string;
  readonly body: string;
  /** "把第 M 级的 X 个会话一起归档", or `null` with none to archive. */
  readonly archive: string | null;
  /** The sessions to archive. */
  readonly sessionIds: readonly string[];
  /** How many of them run. */
  readonly running: number;
  /** "还没补的 Z 个漏洞带到第 N 级。", or `null` with none, or after the last level. */
  readonly carried: string | null;
  /** The confirming button's words. */
  readonly confirm: string;
}

/**
 * What the upgrade confirmation says for a level.
 *
 * @remarks
 * SPEC-0008, "ML3 定的细节 · 升级确认框", prototype 4A: the level gone up to is the next one not
 * skipped (`todo`); without one this is the last level, finished rather than upgraded. Gaps carried
 * are every open gap of the direction.
 *
 * @sideEffects none
 * @param progress - The progress.
 * @param level - The level upgraded from.
 * @param sessions - The direction's sessions.
 * @returns The words, or `null` for a level the ladder lacks.
 */
export function upgradeView(
  progress: StudyProgress,
  level: string,
  sessions: readonly LoopSession[],
): UpgradeView | null {
  const at = progress.ladder.findIndex((one) => one.id === level);
  if (at === -1) return null;
  const from = at + 1;
  const nextAt = progress.ladder.findIndex((one, index) => index > at && one.state === "todo");
  const next = progress.ladder[nextAt];
  const before = Math.max(0, (progress.steps[level]?.length ?? 1) - 1);
  const sessionIds = levelSessions(sessions, level);
  const running = sessions.filter((session) => sessionIds.includes(session.sessionId) && session.running).length;
  const archive =
    sessionIds.length === 0 ? null : `把第 ${String(from)} 级的 ${String(sessionIds.length)} 个会话一起归档`;
  const done = `第 ${String(from)} 级前面的 ${String(before)} 步都做完了。`;
  if (next === undefined) {
    return {
      last: true,
      title: "学完最后一级",
      body: `${done}确定后这个方向标为“已学完”，还能随口问、复习。`,
      archive,
      sessionIds,
      running,
      carried: null,
      confirm: "学完",
    };
  }
  const to = nextAt + 1;
  const open = progress.gaps.filter((gap) => gap.fixed === null).length;
  return {
    last: false,
    title: `升到第 ${String(to)} 级「${next.name}」`,
    body: `${done}确定后开一个“排计划”会话，排第 ${String(to)} 级的课。`,
    archive,
    sessionIds,
    running,
    carried: open === 0 ? null : `还没补的 ${String(open)} 个漏洞带到第 ${String(to)} 级。`,
    confirm: "升级并排计划",
  };
}

/**
 * Whether upgrading from a level finishes the direction: no level after it is still to come.
 *
 * @remarks
 * The strip's button says "学完" then (prototype 2A ⑦).
 *
 * @sideEffects none
 * @param progress - The progress.
 * @param level - The level.
 * @returns Whether.
 */
export function isLastLevel(progress: StudyProgress, level: string): boolean {
  const at = progress.ladder.findIndex((one) => one.id === level);
  return at !== -1 && !progress.ladder.some((one, index) => index > at && one.state === "todo");
}

/** The home's gaps, in their groups (prototype 3B). */
export interface GapGroups {
  /** The current level's, open first, then fixed. */
  readonly here: readonly StudyGap[];
  /** Earlier levels' still open: carried to this one. */
  readonly carried: readonly StudyGap[];
  /** Earlier levels' fixed, folded into one row. */
  readonly earlierFixed: readonly StudyGap[];
  /** Open in the whole direction. */
  readonly open: number;
}

/**
 * The gaps grouped as the home lists them.
 *
 * @remarks
 * SPEC-0008, "ML3 定的细节 · 带到下一级的漏洞": this level's, open and fixed; those carried from
 * earlier levels, open only; earlier levels' fixed in one folded row. The level is the current
 * one, else the shown (a finished direction's last).
 *
 * @sideEffects none
 * @param progress - The progress.
 * @returns The groups.
 */
export function gapGroups(progress: StudyProgress): GapGroups {
  const level = shownLevel(progress)?.id;
  const here = progress.gaps
    .filter((gap) => gap.from.level === level)
    .toSorted((a, b) => Number(a.fixed !== null) - Number(b.fixed !== null));
  const earlier = progress.gaps.filter((gap) => gap.from.level !== level);
  return {
    here,
    carried: earlier.filter((gap) => gap.fixed === null),
    earlierFixed: earlier.filter((gap) => gap.fixed !== null),
    open: progress.gaps.filter((gap) => gap.fixed === null).length,
  };
}

/**
 * What a gap row's "跑费曼" opens: Feynman on the gap, recorded at the current level.
 *
 * @remarks
 * SPEC-0008, "ML3 定的细节 · 费曼和补测从哪开": the level is the current one; the step the gap's
 * source when it is of that level, none for one carried from an earlier level.
 *
 * @sideEffects none
 * @param gap - The gap.
 * @param progress - The progress.
 * @returns The use to start, or `null` without a current level.
 */
export function feynmanStudy(
  gap: StudyGap,
  progress: StudyProgress,
): { readonly kind: "feynman"; readonly level: string; readonly step?: string; readonly gap: string } | null {
  const level = currentLevel(progress);
  if (level === null) return null;
  return {
    kind: "feynman" as const,
    level: level.id,
    ...(gap.from.level === level.id ? { step: gap.from.step } : {}),
    gap: gap.id,
  };
}

/**
 * The session open already for a gap's Feynman start: the latest not archived of the same use,
 * level, step and gap.
 *
 * @remarks
 * Its row's button goes back to it ("回到费曼"); matched as the host matches a start, so one of an
 * earlier level for the same gap is not it (SPEC-0008, "ML3 定的细节 · 界面实现时定的小处").
 *
 * @sideEffects none
 * @param sessions - The direction's sessions.
 * @param start - What "跑费曼" would start.
 * @returns The session id, or `null`.
 */
export function feynmanSessionOf(
  sessions: readonly LoopSession[],
  start: Pick<SessionStudy, "level" | "step" | "gap">,
): string | null {
  return (
    sessions
      .filter(
        ({ study, archived }) =>
          !archived &&
          study?.kind === "feynman" &&
          study.level === start.level &&
          study.step === start.step &&
          study.gap === start.gap,
      )
      .toSorted((a, b) => b.updatedAt - a.updatedAt)[0]?.sessionId ?? null
  );
}

/** One step's group of a level's archived sessions (prototype 5B). */
export interface ArchivedGroup {
  readonly key: string;
  readonly title: string;
  readonly sessions: readonly LoopSession[];
}

/**
 * A level's archived sessions, grouped by step in the level's order, then those of no step.
 *
 * @remarks
 * Prototype 5B: under the ladder's level opened. Sessions of no step (a plan session, Feynman on a
 * gap carried) group by use. A child archived with a session of the level (by parent) goes with
 * its parent's group.
 *
 * @sideEffects none
 * @param sessions - The direction's sessions.
 * @param progress - The progress.
 * @param level - The level.
 * @returns The groups, none when nothing of the level is archived.
 */
export function archivedGroups(
  sessions: readonly LoopSession[],
  progress: StudyProgress,
  level: string,
): ArchivedGroup[] {
  const archived = sessions.filter((session) => session.archived);
  const byId = new Map(archived.map((session) => [session.sessionId, session]));
  /**
   * The archived session of the level a session belongs to: itself, or the parent it came under.
   *
   * @remarks
   * A loop in the parents ends the walk.
   *
   * @sideEffects none
   * @param session - The session.
   * @returns The owner, or `undefined` for one not of the level.
   */
  const ownerOf = (session: LoopSession): LoopSession | undefined => {
    const seen = new Set<string>();
    for (let at: LoopSession | undefined = session; at !== undefined && !seen.has(at.sessionId);) {
      seen.add(at.sessionId);
      if (at.study !== null && at.study.kind !== "discuss" && at.study.kind !== "ask" && at.study.level !== undefined)
        return at.study.level === level ? at : undefined;
      const parent: string | undefined = at.parent?.sessionId;
      at = parent === undefined ? undefined : byId.get(parent);
    }
    return undefined;
  };
  const levelAt = progress.ladder.findIndex((one) => one.id === level);
  const steps = progress.steps[level] ?? [];
  const groups = new Map<string, { title: string; order: number; sessions: LoopSession[] }>();
  for (const session of archived.toSorted((a, b) => a.updatedAt - b.updatedAt)) {
    const owner = ownerOf(session);
    if (owner?.study === undefined || owner.study === null) continue;
    const stepAt = owner.study.step === undefined ? -1 : steps.findIndex((step) => step.id === owner.study?.step);
    const step = steps[stepAt];
    const key = step === undefined ? `kind:${owner.study.kind}` : `step:${step.id}`;
    const title = step === undefined ? KIND_NAMES[owner.study.kind] : stepTitle(step, levelAt + 1, progress.ladder);
    const group = groups.get(key) ?? { title, order: step === undefined ? steps.length : stepAt, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .toSorted(([, a], [, b]) => a.order - b.order)
    .map(([key, group]) => ({ key, title: group.title, sessions: group.sessions }));
}

/**
 * How many of a quiz child's first turns were copied from its lesson: those before its own start.
 *
 * @remarks
 * SPEC-0008, "ML3 定的细节 · 测验" (prototype 1A): the quiz's start is the first turn opened by a
 * study start of the quiz; what is before it came with `--fork`. Before the quiz started, every
 * turn is copied, as is every turn shown while no quiz start is among them, older ones not loaded
 * or not: a quiz far longer than a page is rarer than a long lesson not started on yet, and the
 * fold opens to show them all.
 *
 * @sideEffects none
 * @param items - The transcript's items, oldest first.
 * @returns How many items, from the first, are copied.
 */
export function copiedItems(items: readonly TranscriptItem[]): number {
  const start = items.findIndex(
    (item) => item.kind === "turn" && item.source?.kind === "study" && item.source.study.kind === "quiz",
  );
  return start === -1 ? items.length : start;
}

/** A study tool's step as the process track says it (prototype 7C). */
export interface StudyToolLine {
  readonly verb: string;
  readonly object: string;
  /** The node's small square: a gap found (`--attn`), a gap fixed (`--ok`), or none. */
  readonly square: "gap" | "fixed" | null;
  /** Where it wrote, for the detail: "第 2 级第 5 步 · 测验"; `null` when nothing says. */
  readonly wrote: string | null;
}

/** The study tools the track words, with their verbs running and done. */
const STUDY_TOOL_VERBS: Readonly<Record<string, readonly [string, string]>> = {
  study_add_gap: ["正在记下漏洞", "记下漏洞"],
  study_fix_gap: ["正在补上漏洞", "补上漏洞"],
  study_report: ["正在报告", "报告"],
  study_set_steps: ["正在排课", "排了课"],
};

/**
 * What a session's report says it did, by its use.
 *
 * @remarks
 * Prototype 7C: "测验 32 / 50"; the uses without a score say they are done.
 *
 * @sideEffects none
 * @param kind - The session's use.
 * @param args - The report's arguments.
 * @returns The words.
 */
function reported(kind: StudyKind | undefined, args: Readonly<Record<string, unknown>>): string {
  const { score, of } = args;
  const scored = typeof score === "number" && typeof of === "number" ? ` ${String(score)} / ${String(of)}` : "";
  switch (kind) {
    case "lesson":
      return "上课完成";
    case "sheet":
      return "速查表完成";
    case "project":
      return "过关项目通过";
    case "quiz":
    case "exam":
      return `${KIND_NAMES[kind]}${scored}`;
    case "discuss":
    case "plan":
    case "feynman":
    case "ask":
    case undefined:
    default:
      return scored.trim();
  }
}

/**
 * A study tool's step in words, from its arguments and the session's use.
 *
 * @remarks
 * Prototype 7C: "记下漏洞 · 文字", "补上漏洞 · 文字" (the session's own gap, from the progress),
 * "报告 · 测验 32 / 50", "排了课 · 第 3 级 · 6 节"; a gap found or fixed marked by a small square.
 * Other tools, the discussion's among them, are not worded here.
 *
 * @sideEffects none
 * @param tool - The tool's name.
 * @param args - Its arguments.
 * @param running - Whether the call is going on.
 * @param study - The session's use, if it has one.
 * @param progress - The direction's progress, if read.
 * @returns The line, or `null` for a tool not worded here.
 */
export function studyToolLine(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  running: boolean,
  study: SessionStudy | null,
  progress: StudyProgress | null,
): StudyToolLine | null {
  const verbs = STUDY_TOOL_VERBS[tool];
  if (verbs === undefined) return null;
  const verb = verbs[running ? 0 : 1];
  const levelAt = study?.level === undefined ? -1 : (progress?.ladder.findIndex((one) => one.id === study.level) ?? -1);
  const level = levelAt === -1 ? null : `第 ${String(levelAt + 1)} 级`;
  const stepAt =
    study?.level === undefined || study.step === undefined
      ? -1
      : (progress?.steps[study.level]?.findIndex((one) => one.id === study.step) ?? -1);
  const where = level === null ? null : stepAt === -1 ? level : `${level}第 ${String(stepAt + 1)} 步`;
  const use = study === null ? null : KIND_NAMES[study.kind];
  const wrote = where === null ? null : use === null ? where : `${where} · ${use}`;
  if (tool === "study_add_gap") {
    const text = typeof args["text"] === "string" ? args["text"] : "";
    return { verb, object: text.split("\n")[0] ?? "", square: "gap", wrote };
  }
  if (tool === "study_fix_gap") {
    const gap = progress?.gaps.find((one) => one.id === study?.gap);
    return { verb, object: gap?.text.split("\n")[0] ?? "", square: "fixed", wrote };
  }
  if (tool === "study_report") return { verb, object: reported(study?.kind, args), square: null, wrote };
  const lessons = args["lessons"];
  const count = Array.isArray(lessons) ? `${String(lessons.length)} 节` : null;
  return { verb, object: [level, count].filter((part) => part !== null).join(" · "), square: null, wrote: level };
}

/**
 * A session's name from its use, for the sessions the host opens with no name of their own.
 *
 * @remarks
 * design-language "学习模式 · ML3 学习循环" (2026-11-09, B): "上课 · 课名", "测验 · 课名", "费曼 · 漏洞文字"
 * (cut by seen characters, as the gaps' limits count them), "排计划 · 第 N 级", "速查表 · 第 N 级"
 * and the same for the project and the exam; `null` where the lesson, gap or level is not found,
 * and for the other uses, which ML2 names ("上课 · 第 2 级第 4 步"). The host names none (it emits
 * no text).
 *
 * @sideEffects none
 * @param study - The session's use.
 * @param progress - The direction's progress.
 * @returns The name, or `null`.
 */
export function loopSessionName(study: SessionStudy, progress: StudyProgress | null): string | null {
  if (progress === null || study.level === undefined) return null;
  const level = study.level;
  if (study.kind === "quiz" || study.kind === "lesson") {
    const step = progress.steps[level]?.find((one) => one.id === study.step);
    return step?.kind === "lesson" ? `${KIND_NAMES[study.kind]} · ${step.title}` : null;
  }
  if (study.kind === "feynman") {
    const text = progress.gaps.find((one) => one.id === study.gap)?.text.split("\n")[0];
    if (text === undefined) return null;
    const chars = splitSeen(text);
    return `费曼 · ${chars.length > GAP_NAME ? `${chars.slice(0, GAP_NAME).join("")}…` : text}`;
  }
  if (study.kind === "plan" || study.kind === "sheet" || study.kind === "project" || study.kind === "exam") {
    const at = progress.ladder.findIndex((one) => one.id === level);
    return at === -1 ? null : `${KIND_NAMES[study.kind]} · 第 ${String(at + 1)} 级`;
  }
  return null;
}
