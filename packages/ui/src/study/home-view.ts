import type { Direction, SessionSummary, StudyAction } from "@atrium/protocol";
import { timeAgo } from "../sidebar/names";
import { directionName } from "./learning";
import { type StripDot, currentLevel, progressLine, stripView } from "./progress";
import { studySessionTitle } from "./study-icon";

// What the learning home shows for each direction (SPEC-0008, "ML4 定的细节"; design-language
// "学习模式", prototype study-home 1C 2A 3A). The host sends progress and next steps; the words are
// worked out here.

/** The dots a direction's card or the continue card draws, as the step strip's. */
export type HomeDots =
  | {
      readonly kind: "steps";
      readonly dots: readonly StripDot[];
      readonly look: "learning" | "archived" | "finished" | "newer";
    }
  | { readonly kind: "broken"; readonly count: number };

/** The continue card's words, dots and button (SPEC-0008, "ML4 定的细节 · 继续"). */
export interface ContinueCard {
  readonly eyebrow: string;
  /** The eyebrow warns: the file cannot be read. */
  readonly warn: boolean;
  readonly big: string;
  /** A line under the big words, for a broken or a newer file. */
  readonly desc: string | null;
  readonly dots: HomeDots | null;
  /** The strip's primary action; `null` when the card only opens the direction. */
  readonly primary: StudyAction | null;
  /** The primary goes back to a session that runs. */
  readonly running: boolean;
  /** "上次：…", or `null` with nothing to say. */
  readonly last: string | null;
}

/** A direction's card on the learning home (SPEC-0008, "ML4 定的细节 · 方向卡片"). */
export interface DirectionCard {
  /** One of its sessions waits for you, or one runs; waiting wins. */
  readonly mark: "asking" | "running" | null;
  /** The tag after its name. */
  readonly tag: "讨论中" | null;
  readonly line: string;
  /** The line warns: the file cannot be read. */
  readonly warn: boolean;
  readonly dots: HomeDots | null;
}

/** The line of a broken file, as the step strip's (prototype 2D). */
export const BROKEN_DESC = ".atrium-study.json 不是能读的格式，文件没有被改动";

/** The line of a file of a later version. */
const NEWER_DESC = "档案是更新版本的 Atrium 写的，只能看";

/**
 * A direction's sessions that count: in it and not archived.
 *
 * @remarks
 * An archived session neither runs nor is the last one worked in (SPEC-0008, ML4).
 *
 * @sideEffects none
 * @param direction - The direction.
 * @param sessions - Every session.
 * @returns Its sessions.
 */
function liveIn(direction: Pick<Direction, "id">, sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.filter((session) => session.containerId === direction.id && !session.archived);
}

/**
 * The dots of a direction, as its step strip draws them.
 *
 * @remarks
 * None while under discussion or for a level with no lessons yet; a broken file's are placeholders.
 *
 * @sideEffects none
 * @param view - The strip's view.
 * @returns The dots, or `null`.
 */
function dotsOf(view: ReturnType<typeof stripView>): HomeDots | null {
  if (view.kind === "broken") return { kind: "broken", count: view.dots };
  if (view.kind === "discussing" || !view.dots.some((dot) => !dot.round)) return null;
  return { kind: "steps", dots: view.dots, look: view.kind };
}

/**
 * "上次：…": when the direction's latest session was active, its name, and a quiz's or exam's score.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 继续": the session not archived active last; named as its tab is
 * (`studySessionTitle`); the score from the progress, as reported. `null` with no such session.
 *
 * @sideEffects none
 * @param direction - The direction.
 * @param sessions - Every session.
 * @param now - The time now.
 * @returns The line, or `null`.
 */
export function lastLine(
  direction: Pick<Direction, "id" | "progress">,
  sessions: readonly SessionSummary[],
  now: number,
): string | null {
  const latest = liveIn(direction, sessions).toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
  if (latest === undefined) return null;
  const parts = [timeAgo(latest.updatedAt, now), studySessionTitle(latest, direction)];
  const { study } = latest;
  const step =
    study?.level === undefined || direction.progress === null
      ? undefined
      : direction.progress.steps[study.level]?.find((one) => one.id === study.step);
  const score =
    study?.kind === "quiz" && step?.kind === "lesson" && step.quiz?.by === "agent"
      ? `${String(step.quiz.score)}/${String(step.quiz.of)}`
      : study?.kind === "exam" && step?.kind === "exam" && step.done?.score !== undefined && step.done.of !== undefined
        ? `${String(step.done.score)}/${String(step.done.of)}`
        : null;
  return `上次：${parts.join(" · ")}${score === null ? "" : ` ${score}`}`;
}

/**
 * The continue card of the direction opened last.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 继续" (prototype 1C): the eyebrow says the direction and where it is,
 * the big words what comes next, the dots are the strip's, and the button is the strip's primary.
 * A direction finished, under discussion, broken or of a newer file only opens; a broken or newer
 * one says why in its own line instead of the last session.
 *
 * @sideEffects none
 * @param direction - The direction.
 * @param sessions - Every session.
 * @param now - The time now.
 * @returns The card.
 */
export function continueCard(direction: Direction, sessions: readonly SessionSummary[], now: number): ContinueCard {
  const name = directionName(direction);
  const mine = liveIn(direction, sessions);
  const view = stripView(direction, mine);
  const dots = dotsOf(view);
  const last = lastLine(direction, sessions, now);
  const plain = { warn: false, desc: null, running: false } as const;
  if (view.kind === "broken") {
    return {
      ...plain,
      eyebrow: name,
      warn: true,
      big: "档案读不出来",
      desc: BROKEN_DESC,
      dots,
      primary: null,
      last: null,
    };
  }
  if (view.kind === "discussing") {
    return { ...plain, eyebrow: `${name} · 讨论中`, big: "还没排出阶梯", dots: null, primary: null, last };
  }
  if (view.kind === "finished") {
    return { ...plain, eyebrow: name, big: `已学完 · 共 ${String(view.levels)} 级`, dots, primary: null, last };
  }
  const level = view.level === null ? "" : ` · 第 ${String(view.level.number)} 级`;
  const primary = direction.next.primary;
  if (dots === null && view.kind === "newer") {
    // Only to be read, so no plan and no last session, as any newer file (ML4 three-way review).
    return { ...plain, eyebrow: `${name}${level}`, big: "还没排课", desc: NEWER_DESC, dots, primary: null, last: null };
  }
  if (dots === null) {
    // A level with no lessons yet: its plan session to start or to go back to (ML3).
    return {
      ...plain,
      eyebrow: `${name}${level}`,
      big: primary?.type === "open" ? "排计划中" : "还没排课",
      dots,
      primary,
      running: running(primary, mine),
      last,
    };
  }
  const step = view.step;
  const eyebrow = `${name}${level}${step === null ? "" : ` · 第 ${String(step.number)} 步`}`;
  const big = step?.title ?? "";
  if (view.kind === "newer" || view.kind === "archived") {
    return { ...plain, eyebrow, big, desc: view.kind === "newer" ? NEWER_DESC : null, dots, primary: null, last: null };
  }
  return { ...plain, eyebrow, big, dots, primary, running: running(primary, mine), last };
}

/**
 * Whether an action goes back to a session that runs.
 *
 * @remarks
 * Its button then has the running dot, as the strip's.
 *
 * @sideEffects none
 * @param action - The action.
 * @param sessions - The direction's sessions.
 * @returns Whether.
 */
function running(action: StudyAction | null, sessions: readonly SessionSummary[]): boolean {
  return (
    action?.type === "open" && sessions.some((session) => session.sessionId === action.sessionId && session.running)
  );
}

/**
 * A direction's card: its mark, tag, line and dots.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 方向卡片" (prototype 2A): a broken file no longer shows as under
 * discussion; a session waiting for you wins over one running (domain-model §4).
 *
 * @sideEffects none
 * @param direction - The direction.
 * @param sessions - Every session.
 * @returns The card.
 */
export function directionCard(direction: Direction, sessions: readonly SessionSummary[]): DirectionCard {
  const mine = liveIn(direction, sessions);
  const mark = mine.some((one) => one.asking !== null) ? "asking" : mine.some((one) => one.running) ? "running" : null;
  const view = stripView(direction, mine);
  const dots = dotsOf(view);
  const plain = { mark, tag: null, warn: false } as const;
  if (view.kind === "broken") return { ...plain, warn: true, line: "档案读不出来", dots };
  if (view.kind === "discussing") return { ...plain, tag: "讨论中", line: "还没排出阶梯", dots: null };
  if (view.kind === "finished") return { ...plain, line: `已学完 · 共 ${String(view.levels)} 级`, dots };
  if (dots === null && view.level !== null) {
    const unplanned = `第 ${String(view.level.number)} 级 · 还没排课`;
    return { ...plain, line: view.kind === "newer" ? `${unplanned} · 只能看` : unplanned, dots };
  }
  const line = direction.progress === null ? "" : progressLine(direction.progress);
  return { ...plain, line: view.kind === "newer" ? `${line} · 只能看` : line, dots };
}

/**
 * Where an archived direction stopped, after its name in the archived list.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 已归档的方向" (prototype 3A).
 *
 * @sideEffects none
 * @param direction - The direction.
 * @returns The words.
 */
export function archivedLine(direction: Pick<Direction, "broken" | "progress">): string {
  if (direction.broken) return "档案读不出来";
  const progress = direction.progress;
  if (progress === null) return "讨论中";
  if (progress.finishedAt !== null) return "已学完";
  const level = currentLevel(progress);
  if (level === null) return "已学完";
  const at = (progress.steps[level.id] ?? []).findIndex((step) => step.done === null);
  return at === -1 ? `停在第 ${String(level.number)} 级` : `停在第 ${String(level.number)} 级第 ${String(at + 1)} 步`;
}

/**
 * The archived directions, in the order their list shows them.
 *
 * @remarks
 * The one opened last first, then the newest made: archiving records no time (SPEC-0008, ML4).
 *
 * @sideEffects none
 * @param directions - Every direction.
 * @returns The archived ones.
 */
export function archivedDirections(directions: readonly Direction[]): Direction[] {
  return directions
    .filter((direction) => direction.archived)
    .toSorted(
      (a, b) =>
        (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        a.id.localeCompare(b.id),
    );
}
