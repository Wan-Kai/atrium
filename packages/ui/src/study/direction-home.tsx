import type { AtriumClient } from "@atrium/client";
import type { Direction, SessionSummary, StudyAction, StudyGap, StudyProgress, StudyStep } from "@atrium/protocol";
import { Fragment, type ReactNode, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { CaretRight, Check, DotsThree, Idea, Message, Quiz, Target, Undo } from "../design/icons";
import { PRIMARY_BUTTON } from "../settings/parts";
import { timeAgo } from "../sidebar/names";
import { useClock } from "../state/clock";
import type { WorkspaceViews } from "../state/workspace-views";
import { DirectionArchive } from "./archive-part";
import { BROKEN_DESC } from "./home-view";
import {
  type LearningState,
  describeStudyError,
  directionName,
  directionSessions,
  openDirectionSession,
} from "./learning";
import { useLessonControl } from "./lesson-control";
import { archivedGroups, feynmanSessionOf, feynmanStudy, gapGroups, isLastLevel, type LoopSession } from "./loop";
import { KIND_NAMES, type SubState, actionLabel, currentLevel, lessonParts, shownLevel, stepTitle } from "./progress";
import { blockedBecause, runAction } from "./step-strip";
import { StudyIcon, studySessionTitle } from "./study-icon";

/** A section's small heading (prototype C, `.sect > .h`). */
const SECTION_HEADING = "mb-2 text-[length:var(--fs-xs)] font-normal text-[var(--text-dim)]";

/** A card: `--surface-1`, 16px corners, the card shadow. */
const CARD = "rounded-[16px] bg-[var(--surface-1)] shadow-[var(--card-shadow)]";

/** A small square of a lesson's part, by its state (prototype 1A, 4A). */
const PART_LOOK: Readonly<Record<SubState, string>> = {
  done: "bg-[var(--text-muted)]",
  manual: "shadow-[inset_0_0_0_1.25px_var(--text-muted)]",
  later: "outline-1 -outline-offset-1 outline-dashed outline-[var(--text-dim)]",
  gap: "bg-[var(--attn)]",
  todo: "shadow-[inset_0_0_0_1px_var(--line-strong)]",
};

/** What the home's parts need to act. */
interface HomeActions {
  /** Runs a command, showing its failure under the page's title. */
  readonly act: (command: () => Promise<unknown>) => void;
  readonly client: AtriumClient;
  readonly store: StoreApi<LearningState>;
  readonly direction: Direction;
  /**
   * Nothing is offered to change: the direction is archived, its file cannot be read, or is of a
   * later version (SPEC-0008, "ML2 定的细节").
   */
  readonly readOnly: boolean;
  /**
   * No manual mark or its undo: where nothing may change, and in a finished direction (SPEC-0008,
   * "ML2 定的细节"; the host refuses them too).
   */
  readonly noMarks: boolean;
  /** A command is under way; the buttons that start one wait. */
  readonly busy: boolean;
  /** Every session of the direction, archived ones too (SPEC-0008, "ML3 定的细节"); none of another direction. */
  readonly all: readonly SessionSummary[];
}

/** A mark a step's menu offers. */
interface MarkItem {
  readonly label: string;
  readonly hint?: string;
  readonly mark: "lesson" | "quiz" | "step" | "later";
  readonly done: boolean;
}

/**
 * The profile in one line: goal · language · hours a week.
 *
 * @remarks
 * design-language "学习模式": the parts the discussion recorded, in that order.
 *
 * @sideEffects none
 * @param progress - The progress.
 * @returns The line, or `null` with none recorded.
 */
function profileLine(progress: StudyProgress): string | null {
  const { goal, language, weeklyHours } = progress.profile;
  const parts = [goal, language, weeklyHours === undefined ? undefined : `每周 ${weeklyHours} 小时`].filter(
    (part) => part !== undefined && part !== "",
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * The marks a step's menu offers, and the manual ones it can take back.
 *
 * @remarks
 * Prototype 1A: a lesson not done offers its parts not done and the whole step; the cheat sheet,
 * project and exam only "标为完成"; the upgrade nothing, as only upgrading does it; a manual mark
 * is taken back by name.
 *
 * @sideEffects none
 * @param step - The step.
 * @returns The marks, then the undos.
 */
function markItems(step: StudyStep): { readonly marks: MarkItem[]; readonly undos: MarkItem[] } {
  const marks: MarkItem[] = [];
  const undos: MarkItem[] = [];
  if (step.kind === "lesson") {
    if (step.done === null) {
      if (step.lesson === null) marks.push({ label: "标上课完成", mark: "lesson", done: true });
      if (step.quiz === null) marks.push({ label: "标测验完成", hint: "连上课", mark: "quiz", done: true });
      marks.push({ label: "整步标为完成", mark: "step", done: true });
    }
    if (step.lesson?.by === "manual") undos.push({ label: "撤回“上课完成”", mark: "lesson", done: false });
    if (step.quiz?.by === "manual") undos.push({ label: "撤回“测验完成”", mark: "quiz", done: false });
    if (step.quiz?.by === "later") undos.push({ label: "撤回“以后再测”", mark: "later", done: false });
    else if (step.done?.by === "manual") undos.push({ label: "撤回“整步完成”", mark: "step", done: false });
  } else if (step.kind === "up") {
    // Upgrading is its own step (ML3), never a mark.
  } else if (step.done === null) {
    marks.push({ label: "标为完成", mark: "step", done: true });
  } else if (step.done.by === "manual") {
    undos.push({ label: "撤回“标为完成”", mark: "step", done: false });
  }
  return { marks, undos };
}

/**
 * A step's "···" menu: marking its parts done by hand, and taking manual marks back.
 *
 * @remarks
 * Prototype 1A (2026-11-09): the step's name first, the marks (`markItems`), a line before the
 * whole step's mark when a part's comes before it, and under the undos a note that the agent's
 * cannot be. Nothing for a step with nothing to do, nor where nothing may change.
 *
 * @sideEffects Sends `mark_study_step` when an item is chosen.
 * @param props - The step, its title and level, and how to act.
 * @returns The menu, or nothing.
 */
function StepMenu({
  step,
  title,
  level,
  actions,
}: {
  readonly step: StudyStep;
  readonly title: string;
  readonly level: string;
  readonly actions: HomeActions;
}) {
  const { marks, undos } = markItems(step);
  if (actions.noMarks || (marks.length === 0 && undos.length === 0)) return null;
  const { client, direction, act } = actions;
  return (
    <MenuButton label={`${title} 的更多操作`} compact content={<DotsThree size={14} />}>
      {(close) => (
        <>
          <p className="px-2.5 pt-1 pb-0.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">{title}</p>
          {[...marks, ...undos].map((item, at) => (
            <Fragment key={`${item.mark}${String(item.done)}`}>
              {item.mark === "step" && item.done && at > 0 ? (
                <div role="separator" aria-label="分隔线" className="mx-2.5 my-1 h-px bg-[var(--line)]" />
              ) : null}
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  act(() => client.markStudyStep(direction.id, level, step.id, item.mark, item.done));
                }}
              >
                {item.done ? <Check size={14} aria-hidden /> : <Undo size={14} aria-hidden />}
                <span className="flex-1">{item.label}</span>
                {item.hint === undefined ? null : (
                  <span className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">{item.hint}</span>
                )}
              </button>
            </Fragment>
          ))}
          {undos.length === 0 ? null : (
            <p className="max-w-[220px] px-2.5 pt-0.5 pb-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
              agent 报告的不能撤回；之后 agent 报告这一步，以它的为准。
            </p>
          )}
        </>
      )}
    </MenuButton>
  );
}

/**
 * The small things under a step: its sessions, and the parts you marked where a session would be.
 *
 * @remarks
 * Prototype C and 1A: a quiz shows its score; "测验 · 你标的" stands for a quiz marked by hand.
 *
 * @sideEffects Opens a session when its chip is clicked.
 * @param props - The step, its level, its sessions and how to act.
 * @returns The chips.
 */
function StepChips({
  step,
  sessions,
  actions,
}: {
  readonly step: StudyStep;
  readonly sessions: readonly SessionSummary[];
  readonly actions: HomeActions;
}) {
  const chips: ReactNode[] = sessions.map((session) => {
    const kind = session.study?.kind ?? "lesson";
    const score =
      kind === "quiz" && step.kind === "lesson" && step.quiz?.by === "agent"
        ? `${String(step.quiz.score)}/${String(step.quiz.of)}`
        : null;
    return (
      <button
        key={session.sessionId}
        type="button"
        onClick={() =>
          actions.act(() =>
            openDirectionSession(actions.client, actions.store, actions.direction.id, session.sessionId),
          )
        }
        className="inline-flex h-[22px] items-center gap-[5px] rounded-full bg-[var(--surface-1)] px-2 text-[length:var(--fs-sm)] text-[var(--text-2)] shadow-[var(--chip-shadow)]"
      >
        <StudyIcon kind={kind} size={12} className="text-[var(--text-muted)]" />
        {KIND_NAMES[kind]}
        {score === null ? null : <span className="text-[var(--text-dim)]">{score}</span>}
      </button>
    );
  });
  if (step.kind === "lesson") {
    for (const [part, mark] of [
      ["lesson", step.lesson],
      ["quiz", step.quiz],
    ] as const) {
      if (mark?.by === "manual" && !sessions.some((session) => session.study?.kind === part)) {
        chips.push(
          <span
            key={part}
            className="inline-flex h-[22px] items-center gap-[5px] rounded-full px-2 text-[length:var(--fs-sm)] text-[var(--text-muted)] outline-1 -outline-offset-1 outline-dashed outline-[var(--line-strong)]"
          >
            {KIND_NAMES[part]} · <span className="text-[var(--text-dim)]">你标的</span>
          </span>,
        );
      }
    }
  }
  return chips.length === 0 ? null : (
    <div className="flex flex-wrap items-center gap-1 pr-2.5 pb-2 pl-[38px]">{chips}</div>
  );
}

/**
 * One step of the level: its number or use, a tick once done, its title, a lesson's parts, its
 * sessions below.
 *
 * @remarks
 * Prototype C's list with 1A and 4A: the current step floats white; a quiz put off says "没测",
 * and on hover offers "补测", a quiz of the step (ML3), on the current level only.
 *
 * @sideEffects Opens a session or sends a mark when used.
 * @param props - The step, where it is, its sessions and how to act.
 * @returns The row.
 */
function StepRow({
  step,
  at,
  current,
  level,
  progress,
  sessions,
  actions,
}: {
  readonly step: StudyStep;
  readonly at: number;
  readonly current: boolean;
  readonly level: { readonly id: string; readonly number: number };
  readonly progress: StudyProgress;
  readonly sessions: readonly SessionSummary[];
  readonly actions: HomeActions;
}) {
  const title = stepTitle(step, level.number, progress.ladder);
  const done = step.done !== null;
  const mine = sessions.filter((session) => session.study?.level === level.id && session.study.step === step.id);
  const later = step.kind === "lesson" && step.quiz?.by === "later";
  // A quiz put off is retaken only on the current level (SPEC-0008, "现在能开的"集合).
  const retakable = progress.ladder.find((one) => one.id === level.id)?.state === "current";
  const retake: StudyAction = { type: "start", kind: "quiz", level: level.id, step: step.id, available: true };
  // As "开始测验": faded while its lesson's turn is on (SPEC-0008, "ML3 定的细节 · 测验").
  const waiting = blockedBecause(
    retake,
    actions.all,
    useLessonControl(actions.client, later ? retake : null, actions.all),
  );
  return (
    <li
      data-testid="study-step"
      data-state={done ? "done" : current ? "current" : "todo"}
      className={`group rounded-[var(--r)] ${current ? "bg-[var(--surface-1)] shadow-[var(--chip-shadow)]" : ""}`}
    >
      <div
        className={`flex min-h-8 items-center gap-2.5 pr-1.5 pl-2.5 text-[length:var(--fs-meta)] ${
          current ? "text-[var(--text)]" : done ? "text-[var(--text-3)]" : "text-[var(--text-dim)]"
        }`}
      >
        <span
          className={`inline-flex w-[18px] shrink-0 text-[length:var(--fs-sm)] ${current ? "font-semibold text-[var(--tint)]" : "text-[var(--text-dim)]"}`}
        >
          {step.kind === "lesson" ? at + 1 : <StudyIcon kind={step.kind === "up" ? "plan" : step.kind} size={14} />}
        </span>
        {done ? <Check size={14} aria-label="完成" className="shrink-0 text-[var(--ok-text)]" /> : null}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {step.kind === "lesson" && (done || step.lesson !== null) ? (
          <span className="inline-flex shrink-0 gap-0.5" title="上课 · 测验 · 补漏">
            {lessonParts(step, level.id, progress.gaps).map((part, index) => (
              <i key={index} data-part={part} className={`block size-[5px] rounded-[1.4px] ${PART_LOOK[part]}`} />
            ))}
          </span>
        ) : null}
        {later ? (
          <>
            <span className="text-[length:var(--fs-sm)] text-[var(--text-dim)] group-hover:hidden">没测</span>
            <button
              type="button"
              disabled={actions.busy || actions.readOnly || !retakable || waiting !== null}
              title={waiting || undefined}
              onClick={() => actions.act(() => runAction(actions.client, actions.store, actions.direction.id, retake))}
              className="hidden h-[22px] items-center gap-1 rounded-[7px] px-2 text-[length:var(--fs-sm)] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] group-hover:inline-flex hover:bg-[var(--hover)] disabled:opacity-[0.42]"
            >
              <Quiz size={12} aria-hidden />
              补测
            </button>
          </>
        ) : null}
        <StepMenu step={step} title={title} level={level.id} actions={actions} />
      </div>
      <StepChips step={step} sessions={mine} actions={actions} />
    </li>
  );
}

/**
 * The card of the step to do now: its number and use, its title, a lesson's parts, the button.
 *
 * @remarks
 * Prototype C's hero: the button does what the strip's primary does (the host's next step).
 *
 * @sideEffects Runs the action when pressed.
 * @param props - The step, its number and title, the next action and how to act.
 * @returns The card.
 */
function CurrentStep({
  step,
  number,
  title,
  action,
  actions,
}: {
  readonly step: StudyStep;
  readonly number: number;
  readonly title: string;
  readonly action: StudyAction | null;
  readonly actions: HomeActions;
}) {
  const kindName = step.kind === "up" ? "升级" : KIND_NAMES[step.kind];
  const part = step.kind !== "lesson" ? -1 : step.lesson === null ? 0 : step.quiz === null ? 1 : 2;
  const control = useLessonControl(actions.client, action, actions.all);
  const blocked = action === null ? null : blockedBecause(action, actions.all, control);
  const progress = actions.direction.progress;
  const last = action?.type === "upgrade" && progress !== null && isLastLevel(progress, action.level);
  return (
    <section aria-label="当前步骤" className={`${CARD} px-[18px] pt-4 pb-3.5`}>
      <p className="text-[length:var(--fs-sm)] font-semibold text-[var(--tint)]">
        第 {number} 步 · {kindName}
      </p>
      <p className="mt-1 mb-0.5 text-[16px] font-semibold text-[var(--text)]">{title}</p>
      {step.kind === "lesson" ? (
        <div className="mt-2.5 flex items-center gap-1.5 text-[length:var(--fs-sm)]">
          {["上课", "测验", "补漏"].map((name, at) => (
            <span key={name} className="contents">
              {at === 0 ? null : <span className="text-[var(--text-dim)]">›</span>}
              <span
                className={`inline-flex h-6 items-center rounded-full px-[9px] ${
                  at === part
                    ? "bg-[var(--linked)] font-medium text-[var(--tint)]"
                    : "bg-[var(--surface-2)] text-[var(--text-muted)]"
                }`}
              >
                {name}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      {action === null ? null : (
        <div className="mt-3">
          <button
            type="button"
            disabled={actions.busy || blocked !== null}
            title={blocked || undefined}
            onClick={() => actions.act(() => runAction(actions.client, actions.store, actions.direction.id, action))}
            className={PRIMARY_BUTTON}
          >
            {actionLabel(action, last)}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The card in place of the current step's while the current level has no lessons yet: the plan.
 *
 * @remarks
 * Prototype 6A (SPEC-0008, "ML3 定的细节 · 升级"): the plan's icon and "第 N 级 · 排计划", "第 N 级还没排课",
 * a line on what the plan session does, then "开始排计划", or "回到会话" with its plan session open
 * (a green dot while it runs).
 *
 * @sideEffects Runs the action when pressed.
 * @param props - The level's number, the next action, how many gaps are carried, and how to act.
 * @returns The card.
 */
function PlanCard({
  number,
  action,
  carried,
  actions,
}: {
  readonly number: number;
  readonly action: StudyAction | null;
  readonly carried: number;
  readonly actions: HomeActions;
}) {
  const open = action?.type === "open" ? action.sessionId : null;
  const running = open !== null && actions.all.some((session) => session.sessionId === open && session.running);
  return (
    <section aria-label="当前步骤" className={`${CARD} px-[18px] pt-4 pb-3.5`}>
      <p className="flex items-center gap-[5px] text-[length:var(--fs-sm)] font-semibold text-[var(--tint)]">
        <Target size={14} aria-hidden />第 {number} 级 · 排计划
      </p>
      <p className="mt-1 mb-0.5 text-[16px] font-semibold text-[var(--text)]">第 {number} 级还没排课</p>
      <p className="text-[length:var(--fs-sm)] text-[var(--text-muted)]">
        {carried === 0
          ? "排计划会话按阶梯排出这一级的课，问过你才写进去。"
          : `排计划会话按阶梯和带来的 ${String(carried)} 个漏洞排出这一级的课，问过你才写进去。`}
      </p>
      {action === null ? null : (
        <div className="mt-3 flex items-center gap-2">
          {running ? <span aria-label="在跑" className="size-[7px] shrink-0 rounded-full bg-[var(--ok)]" /> : null}
          <button
            type="button"
            disabled={actions.busy}
            onClick={() => actions.act(() => runAction(actions.client, actions.store, actions.direction.id, action))}
            className={
              open === null
                ? PRIMARY_BUTTON
                : "inline-flex h-7 items-center rounded-[var(--r-pill)] px-3 text-[length:var(--fs-meta)] font-medium text-[var(--tint)] shadow-[inset_0_0_0_1px_var(--tint)] hover:bg-[var(--linked)] disabled:opacity-45"
            }
          >
            {open === null ? "开始排计划" : "回到会话"}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Where a level stands, in a few words, for its opened row.
 *
 * @remarks
 * Prototype 5A's "状态".
 *
 * @sideEffects none
 * @param state - The level's state.
 * @param steps - Its steps.
 * @returns The words.
 */
function levelState(state: StudyProgress["ladder"][number]["state"], steps: readonly StudyStep[]): string {
  if (state === "skipped") return "摸底时跳过";
  if (state === "done") return "学完了";
  if (state === "todo") return "还没到";
  const at = steps.findIndex((step) => step.done === null);
  return steps.length === 0
    ? "还没排步骤"
    : `第 ${String(at === -1 ? steps.length : at + 1)} / ${String(steps.length)} 步`;
}

/**
 * A level's sessions archived with it, under the ladder's level opened: "会话 N 个 · 已归档", opened
 * to list them by step, each opened to be read or restored.
 *
 * @remarks
 * Prototype 5B (SPEC-0008, "ML3 定的细节 · 方向里归档了的会话"): a row is the use's icon, the session's
 * name and its quiz score or when it was last active; on hover "恢复" in place of that. Opening one
 * does not restore it. Nothing for a level with none archived; no "恢复" where nothing may change.
 *
 * @sideEffects Keeps whether the list is open; opens a session or sends `restore_study_sessions`.
 * @param props - The level, the progress and how to act.
 * @returns The section, or nothing.
 */
function ArchivedSessions({
  level,
  progress,
  actions,
}: {
  readonly level: string;
  readonly progress: StudyProgress;
  readonly actions: HomeActions;
}) {
  const [shown, setShown] = useState(false);
  const now = useClock().now();
  const groups = archivedGroups(
    actions.all.filter((session) => session.containerId === actions.direction.id),
    progress,
    level,
  );
  const count = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  if (count === 0) return null;
  const { client, store, direction, act } = actions;
  const byId = new Map(actions.all.map((session) => [session.sessionId, session]));
  /**
   * A row's meta: a quiz's score from its step, else when it was last active.
   *
   * @remarks
   * Prototype 5B: "42/50", "11月2日".
   *
   * @sideEffects none
   * @param session - The session.
   * @returns The words.
   */
  const meta = (session: LoopSession): string => {
    const study = session.study;
    const step = study?.kind === "quiz" ? progress.steps[level]?.find((one) => one.id === study.step) : undefined;
    return step?.kind === "lesson" && step.quiz?.by === "agent"
      ? `${String(step.quiz.score)}/${String(step.quiz.of)}`
      : timeAgo(session.updatedAt, now);
  };
  return (
    <>
      <dt>
        <button
          type="button"
          aria-expanded={shown}
          onClick={() => setShown(!shown)}
          className="mt-1 inline-flex items-center gap-1 text-[length:var(--fs-xs)] text-[var(--text-dim)] hover:text-[var(--text-muted)]"
        >
          会话 {count} 个 · 已归档
          <CaretRight size={12} aria-hidden className={`transition-transform ${shown ? "rotate-90" : ""}`} />
        </button>
      </dt>
      {shown ? (
        <dd className="mt-0.5 -ml-2" aria-label="已归档的会话">
          {groups.map((group) => (
            <div key={group.key}>
              <p className="px-2 pt-1.5 pb-0.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">{group.title}</p>
              <ul>
                {group.sessions.map((one) => {
                  const session = byId.get(one.sessionId);
                  if (session === undefined) return null;
                  return (
                    <li
                      key={session.sessionId}
                      data-testid="archived-session"
                      className="group/archived flex min-h-[30px] items-center gap-2 rounded-[var(--r)] px-2 text-[length:var(--fs-meta)] text-[var(--text-muted)] focus-within:bg-[var(--hover)] hover:bg-[var(--hover)]"
                    >
                      <button
                        type="button"
                        onClick={() => act(() => openDirectionSession(client, store, direction.id, session.sessionId))}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        {session.study === null ? (
                          <Message size={14} aria-hidden className="shrink-0" />
                        ) : (
                          <StudyIcon kind={session.study.kind} size={14} className="shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{studySessionTitle(session, direction)}</span>
                        <span
                          className={`shrink-0 text-[length:var(--fs-sm)] text-[var(--text-dim)] ${actions.readOnly ? "" : "group-focus-within/archived:hidden group-hover/archived:hidden"}`}
                        >
                          {meta(session)}
                        </span>
                      </button>
                      {actions.readOnly ? null : (
                        <button
                          type="button"
                          onClick={() => act(() => client.restoreStudySessions(direction.id, [session.sessionId]))}
                          className="hidden shrink-0 text-[length:var(--fs-sm)] text-[var(--tint)] group-focus-within/archived:inline group-hover/archived:inline"
                        >
                          恢复
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </dd>
      ) : null}
    </>
  );
}

/**
 * The ladder: each level a row, opened in place to say what it covers, how it is passed and where
 * it stands.
 *
 * @remarks
 * Prototype 5A (2026-11-09), wide and narrow alike; a level opened also lists the sessions archived
 * with it (5B, `ArchivedSessions`).
 *
 * @sideEffects Keeps which level is open.
 * @param props - The progress and how to act.
 * @returns The list.
 */
function Ladder({ progress, actions }: { readonly progress: StudyProgress; readonly actions: HomeActions }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-label="阶梯">
      <h2 className={SECTION_HEADING}>阶梯 · {progress.ladder.length} 级</h2>
      <ul className="flex flex-col gap-px">
        {progress.ladder.map((level, at) => {
          const shown = open === level.id;
          return (
            <li key={level.id} data-testid="study-level" data-state={level.state}>
              <button
                type="button"
                aria-expanded={shown}
                onClick={() => setOpen(shown ? null : level.id)}
                className={`flex min-h-[30px] w-full items-center gap-2 rounded-[var(--r)] pr-1.5 pl-1 text-left text-[length:var(--fs-meta)] ${
                  shown ? "bg-[var(--hover)]" : ""
                } ${level.state === "todo" ? "text-[var(--text-dim)]" : "text-[var(--text-2)]"}`}
              >
                <span className="grid size-[18px] shrink-0 place-items-center">
                  <i
                    className={`block rounded-full ${
                      level.state === "current"
                        ? "size-[11px] shadow-[inset_0_0_0_2px_var(--tint)]"
                        : level.state === "todo"
                          ? "size-2 shadow-[inset_0_0_0_1.5px_var(--rail)]"
                          : "size-2 bg-[var(--node)]"
                    }`}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate" title={`第 ${String(at + 1)} 级 · ${level.name}`}>
                  第 {at + 1} 级 · {level.name}
                </span>
                {level.state === "skipped" || level.state === "current" ? (
                  <span className="shrink-0 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                    {level.state === "skipped" ? "跳过" : "当前"}
                  </span>
                ) : null}
                <CaretRight
                  size={12}
                  aria-hidden
                  className={`shrink-0 text-[var(--text-dim)] transition-transform ${shown ? "rotate-90" : ""}`}
                />
              </button>
              {shown ? (
                <dl className="mt-0.5 mb-1.5 ml-[30px] text-[length:var(--fs-sm)] leading-[1.6]">
                  <dt className="text-[length:var(--fs-xs)] text-[var(--text-dim)]">学什么</dt>
                  <dd className="mb-1 text-[var(--text-2)]">{level.topics === "" ? "—" : level.topics}</dd>
                  <dt className="text-[length:var(--fs-xs)] text-[var(--text-dim)]">怎样算过关</dt>
                  <dd className="mb-1 text-[var(--text-2)]">{level.pass === "" ? "—" : level.pass}</dd>
                  <dt className="text-[length:var(--fs-xs)] text-[var(--text-dim)]">状态</dt>
                  <dd className="text-[var(--text-2)]">{levelState(level.state, progress.steps[level.id] ?? [])}</dd>
                  <ArchivedSessions level={level.id} progress={progress} actions={actions} />
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Where a gap came from: the step's title and the question's number, and the level for one of an
 * earlier level.
 *
 * @remarks
 * Prototype C: "事务 · 测验第 4 题"; 3B: "第 1 级 · 移动 · 测验第 2 题" for one carried.
 *
 * @sideEffects none
 * @param gap - The gap.
 * @param progress - The progress.
 * @param here - The level the home shows.
 * @returns The words.
 */
function gapSource(gap: StudyGap, progress: StudyProgress, here: string | undefined): string {
  const levelAt = progress.ladder.findIndex((level) => level.id === gap.from.level);
  const step = progress.steps[gap.from.level]?.find((one) => one.id === gap.from.step);
  const title = step === undefined ? null : stepTitle(step, levelAt + 1, progress.ladder);
  const question = gap.from.question === undefined ? null : `测验第 ${String(gap.from.question)} 题`;
  const level = gap.from.level === here || levelAt === -1 ? null : `第 ${String(levelAt + 1)} 级`;
  return [level, title, question].filter((part) => part !== null).join(" · ");
}

/**
 * One gap's row: its square, its words struck through once fixed, where it came from, and on hover
 * "跑费曼" and "标为已补".
 *
 * @remarks
 * Prototype 3A and 3B: the round buttons show on hover, the bulb first (going back to its Feynman
 * session when one is open, "回到费曼"); a gap you fixed says "你标的已补 · 撤回". Where nothing may
 * change, none of them.
 *
 * @sideEffects Sends `start_study_session` or `mark_study_gap` when used.
 * @param props - The gap, whether it is the card's first, the progress and how to act.
 * @returns The row.
 */
function GapRow({
  gap,
  first,
  progress,
  actions,
}: {
  readonly gap: StudyGap;
  readonly first: boolean;
  readonly progress: StudyProgress;
  readonly actions: HomeActions;
}) {
  const { client, direction, act } = actions;
  const source = gapSource(gap, progress, shownLevel(progress)?.id);
  const feynman = gap.fixed === null && !actions.readOnly ? feynmanStudy(gap, progress) : null;
  const open = feynman === null ? null : feynmanSessionOf(actions.all, feynman);
  const ROUND =
    "grid size-[22px] shrink-0 place-items-center rounded-full bg-[var(--surface-1)] text-[var(--text-muted)] shadow-[inset_0_0_0_1px_var(--line-strong)] disabled:opacity-[0.42]";
  return (
    <li
      data-testid="study-gap"
      data-fixed={gap.fixed === null ? "no" : gap.fixed.by}
      className={`group relative flex items-start gap-2.5 py-[9px] pr-2.5 pl-3 text-[length:var(--fs-meta)] leading-[1.5] text-[var(--text-2)] first:rounded-t-[16px] last:rounded-b-[16px] ${
        gap.fixed === null && !actions.readOnly ? "hover:bg-[var(--hover)]" : ""
      } ${first ? "" : "shadow-[inset_0_0.5px_0_var(--line)]"}`}
    >
      <span
        className={`mt-1.5 block size-2 shrink-0 rounded-[2px] ${gap.fixed === null ? "bg-[var(--attn)]" : "bg-[var(--ok)]"}`}
      />
      <span className="min-w-0 flex-1">
        <span
          className={gap.fixed === null ? "" : "text-[var(--text-dim)] line-through decoration-[var(--line-strong)]"}
        >
          {gap.text}
        </span>
        <span className="block text-[length:var(--fs-sm)] text-[var(--text-dim)]">
          {source}
          {gap.fixed?.by === "manual" && actions.noMarks ? (
            <>{source === "" ? "" : " · "}你标的已补</>
          ) : gap.fixed?.by === "manual" ? (
            <>
              {source === "" ? "" : " · "}你标的已补 ·{" "}
              <button
                type="button"
                className="text-[var(--tint)] hover:underline"
                onClick={() => act(() => client.markStudyGap(direction.id, gap.id, false))}
              >
                撤回
              </button>
            </>
          ) : null}
        </span>
      </span>
      {/* Over the row's right on hover or focus: the words keep the row, and nothing moves (prototype 3B). */}
      <span className="pointer-events-none absolute top-2 right-2.5 flex gap-1 opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 empty:hidden">
        {feynman === null ? null : (
          <button
            type="button"
            aria-label={open === null ? "跑费曼" : "回到费曼"}
            title={open === null ? "跑费曼" : "回到费曼"}
            disabled={actions.busy}
            onClick={() =>
              act(() =>
                open === null
                  ? runAction(actions.client, actions.store, direction.id, {
                      type: "start",
                      ...feynman,
                      available: true,
                    })
                  : openDirectionSession(actions.client, actions.store, direction.id, open),
              )
            }
            className={`${ROUND} hover:text-[var(--tint)] hover:shadow-[inset_0_0_0_1px_var(--tint)]`}
          >
            <Idea size={12} aria-hidden />
          </button>
        )}
        {gap.fixed === null && !actions.noMarks ? (
          <button
            type="button"
            aria-label="标为已补"
            title="标为已补"
            onClick={() => act(() => client.markStudyGap(direction.id, gap.id, true))}
            className={ROUND}
          >
            <Check size={12} aria-hidden />
          </button>
        ) : null}
      </span>
    </li>
  );
}

/**
 * The gaps: this level's, those carried from earlier levels, and earlier ones fixed folded.
 *
 * @remarks
 * Prototype 3B (SPEC-0008, "ML3 定的细节 · 带到下一级的漏洞"): the heading says how many are open in
 * the whole direction; "这一级" lists this level's open then fixed ("还没有" with none); "之前带来的"
 * lists earlier levels' open ones, and ends with "之前已补 · M 个", opened in place. A group with
 * nothing to list is left out; nothing without gaps.
 *
 * @sideEffects Keeps whether the earlier fixed ones show; sends commands when used.
 * @param props - The progress and how to act.
 * @returns The section, or nothing.
 */
function Gaps({ progress, actions }: { readonly progress: StudyProgress; readonly actions: HomeActions }) {
  const [earlierShown, setEarlierShown] = useState(false);
  if (progress.gaps.length === 0) return null;
  const { here, carried, earlierFixed, open } = gapGroups(progress);
  const hereOpen = here.filter((gap) => gap.fixed === null).length;
  const GROUP = "mt-3 mb-1 flex items-center gap-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)] first:mt-0";
  const earlier = earlierShown ? [...carried, ...earlierFixed] : carried;
  return (
    <section aria-label="漏洞">
      <h2 className={`${SECTION_HEADING} flex items-center`}>
        漏洞
        {open === 0 ? null : <span className="ml-auto">{open} 个没补</span>}
      </h2>
      <div>
        <h3 className={GROUP}>
          这一级
          <span className="ml-auto">
            {here.length === 0 ? "还没有" : hereOpen === 0 ? "都补了" : `${String(hereOpen)} 个没补`}
          </span>
        </h3>
        {here.length === 0 ? null : (
          <ul aria-label="这一级的漏洞" className={CARD}>
            {here.map((gap, at) => (
              <GapRow key={gap.id} gap={gap} first={at === 0} progress={progress} actions={actions} />
            ))}
          </ul>
        )}
        {carried.length === 0 && earlierFixed.length === 0 ? null : (
          <>
            <h3 className={GROUP}>
              之前带来的<span className="ml-auto">{carried.length} 个</span>
            </h3>
            <ul aria-label="之前带来的漏洞" className={CARD}>
              {earlier.map((gap, at) => (
                <GapRow key={gap.id} gap={gap} first={at === 0} progress={progress} actions={actions} />
              ))}
              {earlierFixed.length === 0 ? null : (
                <li className={carried.length === 0 && !earlierShown ? "" : "shadow-[inset_0_0.5px_0_var(--line)]"}>
                  <button
                    type="button"
                    aria-expanded={earlierShown}
                    onClick={() => setEarlierShown(!earlierShown)}
                    className="flex min-h-8 w-full items-center gap-1.5 pr-2.5 pl-3 text-left text-[length:var(--fs-sm)] text-[var(--text-muted)]"
                  >
                    <CaretRight
                      size={12}
                      aria-hidden
                      className={`shrink-0 transition-transform ${earlierShown ? "rotate-90" : ""}`}
                    />
                    之前已补
                    <span className="ml-auto text-[var(--text-dim)]">{earlierFixed.length} 个</span>
                  </button>
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The direction's sessions as rows: use icon, title, last active.
 *
 * @remarks
 * ML1's list, for a direction under discussion and for the sessions of no step ("其他会话").
 *
 * @sideEffects Opens a session when a row is clicked.
 * @param props - The sessions, the label, the time and how to act.
 * @returns The list.
 */
function SessionRows({
  sessions,
  label,
  now,
  actions,
}: {
  readonly sessions: readonly SessionSummary[];
  readonly label: string;
  readonly now: number;
  readonly actions: HomeActions;
}) {
  return (
    <ul aria-label={label}>
      {sessions.map((session) => (
        <li key={session.sessionId}>
          <button
            type="button"
            onClick={() =>
              actions.act(() =>
                openDirectionSession(actions.client, actions.store, actions.direction.id, session.sessionId),
              )
            }
            className="my-0.5 flex h-[34px] w-full items-center gap-2 rounded-[var(--r)] px-2 text-left text-[var(--text-2)] hover:bg-[var(--hover)]"
          >
            {session.study === null ? (
              <Message size={14} aria-hidden className="shrink-0 text-[var(--text-muted)]" />
            ) : (
              <StudyIcon kind={session.study.kind} size={14} className="shrink-0 text-[var(--text-muted)]" />
            )}
            <span className="min-w-0 flex-1 truncate">{studySessionTitle(session, actions.direction)}</span>
            <span className="shrink-0 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
              {timeAgo(session.updatedAt, now)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * A direction's progress on its home: the current step, the level's steps, the ladder, the gaps
 * and the other sessions.
 *
 * @remarks
 * Prototype C with study-progress-states 1A, 3A, 4A and 5A (2026-11-09), and study-loop 3B, 5B and
 * 6A (ML3: the gaps grouped, archived sessions under the ladder, the plan's card while the current
 * level has no lessons): two columns where the
 * page is wide enough, the current step's card and the level's steps on the left, the ladder, the
 * gaps and the other sessions in the right one, 200px (design-language "学习模式"); one column
 * below that, in the order current step, ladder, steps, gaps, other sessions. Once none is
 * current, the last level's steps (`shownLevel`). The files ("档案") come with ML4's visuals.
 *
 * @sideEffects Sends commands when used.
 * @param props - The progress, the sessions, the time and how to act.
 * @returns The content.
 */
function Progress({
  progress,
  sessions,
  now,
  actions,
  archive,
}: {
  readonly progress: StudyProgress;
  readonly sessions: readonly SessionSummary[];
  readonly now: number;
  readonly actions: HomeActions;
  readonly archive: ReactNode;
}) {
  const level = shownLevel(progress);
  const steps = level === null ? [] : (progress.steps[level.id] ?? []);
  const currentAt = steps.findIndex((step) => step.done === null);
  const current = steps[currentAt];
  // Of no step, and those of another level kept or restored: the steps list only the level shown
  // (SPEC-0008, "ML3 定的细节 · 方向里归档了的会话").
  const others = sessions.filter(
    (session) =>
      session.study?.step === undefined || (session.study.level !== undefined && session.study.level !== level?.id),
  );
  const { archived } = actions.direction;
  const finished = progress.finishedAt !== null;
  // The current level with no lessons yet: the plan's card, and a placeholder for the steps (6A).
  const unplanned =
    level !== null &&
    !steps.some((step) => step.kind === "lesson") &&
    !archived &&
    !finished &&
    currentLevel(progress) !== null;
  const card = unplanned ? (
    <PlanCard
      number={level.number}
      action={actions.direction.next.primary}
      carried={gapGroups(progress).carried.length}
      actions={actions}
    />
  ) : current === undefined || level === null || archived || finished ? null : (
    <CurrentStep
      step={current}
      number={currentAt + 1}
      title={stepTitle(current, level.number, progress.ladder)}
      action={actions.direction.next.primary}
      actions={actions}
    />
  );
  // Wide: the left column the current step and the level's steps, the right one (240px) the
  // ladder, the gaps and the other sessions. Narrow: one column, in the order current step,
  // ladder, steps, gaps, other sessions (`order`, the columns' boxes left out).
  return (
    <div className="@container mt-[18px]">
      <div
        data-testid="direction-columns"
        className="flex flex-col gap-5 @min-[640px]:grid @min-[640px]:grid-cols-[minmax(0,1fr)_240px] @min-[640px]:items-start @min-[640px]:gap-x-[22px]"
      >
        <div className="contents @min-[640px]:flex @min-[640px]:flex-col @min-[640px]:gap-5">
          {card === null ? null : <div className="order-1 @min-[640px]:order-none">{card}</div>}
          {level === null ? null : (
            <section aria-label="步骤" className="order-3 @min-[640px]:order-none">
              <h2 className={SECTION_HEADING}>第 {level.number} 级的步骤</h2>
              {unplanned ? (
                <p
                  data-testid="steps-placeholder"
                  className="grid min-h-[86px] place-items-center rounded-xl p-3 text-center text-[length:var(--fs-sm)] text-[var(--text-dim)] outline-1 -outline-offset-1 outline-dashed outline-[var(--line-strong)]"
                >
                  课排出来以后列在这里，后面接速查表、过关项目、综合测验、升级。
                </p>
              ) : (
                <ol className="rounded-xl bg-[var(--code)] p-1">
                  {steps.map((step, at) => (
                    <StepRow
                      key={step.id}
                      step={step}
                      at={at}
                      current={at === currentAt && !archived && !finished}
                      level={level}
                      progress={progress}
                      sessions={sessions}
                      actions={actions}
                    />
                  ))}
                </ol>
              )}
            </section>
          )}
        </div>
        <div className="contents @min-[640px]:flex @min-[640px]:flex-col @min-[640px]:gap-5">
          <div className="order-2 @min-[640px]:order-none">
            <Ladder progress={progress} actions={actions} />
          </div>
          <div className="order-4 empty:hidden @min-[640px]:order-none">
            <Gaps progress={progress} actions={actions} />
          </div>
          {others.length === 0 ? null : (
            <section aria-label="其他会话" className="order-5 @min-[640px]:order-none">
              <h2 className={SECTION_HEADING}>其他会话</h2>
              <SessionRows sessions={others} label="其他会话" now={now} actions={actions} />
            </section>
          )}
          <div className="order-6 @min-[640px]:order-none">{archive}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * A direction's home, under its fixed home tab.
 *
 * @remarks
 * SPEC-0008 ("方向主页", "ML1 定的细节", "ML2 定的细节"): the title with "讨论中", "已归档" or the
 * current level, the profile in a line. Under discussion (or with a broken file), the
 * direction's sessions, last active first, each opened from its row; with a ladder, its progress
 * (`Progress`). An archived direction offers "恢复", and its sessions open to be read. A failure
 * shows under the title (provisional wording).
 *
 * The files ("档案", ML4) come last, in the right column, or under the sessions while under
 * discussion; they open in the direction's viewer tabs.
 *
 * @sideEffects Subscribes to the list and the clock; sends commands when used; lists the direction's files.
 * @param props - The client, the study store, the direction and the views its viewer tabs are in.
 * @returns The home, or nothing for a direction the list does not have.
 */
export function DirectionHome({
  client,
  store,
  directionId,
  views,
}: {
  readonly client: AtriumClient;
  readonly store: StoreApi<LearningState>;
  readonly directionId: string;
  readonly views: StoreApi<WorkspaceViews>;
}) {
  const direction = useStore(client.index, (index) => index.directions.find((one) => one.id === directionId));
  const all = useStore(client.index, (index) => index.sessions);
  const now = useClock().now();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stranded = useStore(store, (state) =>
    state.stranded?.directionId === directionId ? state.stranded.failure : undefined,
  );
  if (direction === undefined) return null;
  const sessions = directionSessions(all, directionId);
  const progress = direction.broken ? null : direction.progress;
  const level = progress === null ? null : currentLevel(progress);
  const readOnly = direction.archived || direction.broken || direction.newer;
  const actions: HomeActions = {
    client,
    store,
    direction,
    readOnly,
    noMarks: readOnly || (progress?.finishedAt ?? null) !== null,
    busy,
    all: all.filter((session) => session.containerId === directionId),
    act: (command) => {
      setProblem(null);
      setBusy(true);
      // Fire and forget: the failure is shown; the buttons that start a command wait for it.
      void command()
        .catch((error: unknown) => setProblem(describeStudyError(error)))
        .finally(() => setBusy(false));
    },
  };
  const profile = progress === null ? null : profileLine(progress);
  const archive = <DirectionArchive client={client} direction={direction} views={views} />;
  return (
    <div data-testid="direction-home" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[780px] px-6 py-8">
        <h1 className="text-[22px] font-semibold text-[var(--text)]">{directionName(direction)}</h1>
        <p className="mt-1.5 flex min-w-0 items-center gap-2 text-[length:var(--fs-meta)] whitespace-nowrap text-[var(--text-muted)]">
          {direction.archived ? (
            <span className="shrink-0 rounded-[var(--r-pill)] bg-[var(--selected)] px-[7px] text-[length:var(--fs-xs)] leading-[18px] font-semibold text-[var(--text-muted)]">
              已归档
            </span>
          ) : direction.discussing && !direction.broken ? (
            <span className="shrink-0 rounded-[var(--r-pill)] bg-[var(--attn-soft)] px-[7px] text-[length:var(--fs-xs)] leading-[18px] font-semibold text-[var(--attn-text)]">
              讨论中
            </span>
          ) : level === null ? null : (
            <span
              data-testid="level-tag"
              title={`第 ${String(level.number)} 级 · ${level.name}`}
              className="max-w-[60%] min-w-0 shrink truncate rounded-[var(--r-sm)] bg-[var(--linked)] px-[7px] text-[length:var(--fs-sm)] leading-5 font-medium text-[var(--tint)]"
            >
              第 {level.number} 级 · {level.name}
            </span>
          )}
          <span
            data-testid="profile-line"
            className="min-w-0 flex-1 truncate"
            {...(progress !== null && profile !== null && !direction.archived ? { title: profile } : {})}
          >
            {direction.archived
              ? "会话只能看，恢复以后才能接着学"
              : progress === null
                ? direction.broken
                  ? BROKEN_DESC
                  : "排出阶梯以后，这里显示当前一级的步骤"
                : (profile ?? "")}
          </span>
        </p>
        {problem === null && stranded === undefined ? null : (
          <p role="alert" className="mt-3 text-[length:var(--fs-sm)] text-[var(--danger)]">
            {problem ?? `方向建好了，但没能开始会话：${describeStudyError(stranded)}`}
          </p>
        )}
        {direction.archived ? (
          <div className="mt-5">
            <button
              type="button"
              className={PRIMARY_BUTTON}
              onClick={() => actions.act(() => client.restoreDirection(directionId))}
            >
              恢复
            </button>
          </div>
        ) : null}
        {progress === null ? (
          <>
            {sessions.length === 0 ? null : (
              <div className="mt-5">
                <SessionRows sessions={sessions} label="会话" now={now} actions={actions} />
              </div>
            )}
            <div className="mt-5">{archive}</div>
          </>
        ) : (
          <Progress progress={progress} sessions={sessions} now={now} actions={actions} archive={archive} />
        )}
      </div>
    </div>
  );
}
