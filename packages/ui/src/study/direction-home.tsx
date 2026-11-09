import type { AtriumClient } from "@atrium/client";
import type { Direction, SessionSummary, StudyAction, StudyGap, StudyProgress, StudyStep } from "@atrium/protocol";
import { Fragment, type ReactNode, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { CaretRight, Check, DotsThree, Message, Quiz, Undo } from "../design/icons";
import { PRIMARY_BUTTON } from "../settings/parts";
import { timeAgo } from "../sidebar/names";
import { useClock } from "../state/clock";
import {
  type LearningState,
  describeStudyError,
  directionName,
  directionSessions,
  directionStage,
  openDirectionSession,
} from "./learning";
import { KIND_NAMES, type SubState, actionLabel, currentLevel, lessonParts, shownLevel, stepTitle } from "./progress";
import { runAction } from "./step-strip";
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
  /** A command is under way; the buttons that start one wait. */
  readonly busy: boolean;
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
  if (actions.readOnly || (marks.length === 0 && undos.length === 0)) return null;
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
 * and on hover offers "补测" (opened in ML3, so faded here).
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
  const title = stepTitle(step, level.number, progress.ladder.length);
  const done = step.done !== null;
  const mine = sessions.filter((session) => session.study?.level === level.id && session.study.step === step.id);
  const later = step.kind === "lesson" && step.quiz?.by === "later";
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
              disabled
              title="即将开放"
              className="hidden h-[22px] items-center gap-1 rounded-[7px] px-2 text-[length:var(--fs-sm)] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] group-hover:inline-flex disabled:opacity-[0.42]"
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
  const available =
    action === null ? false : action.type === "start" || action.type === "upgrade" ? action.available : true;
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
            disabled={actions.busy || !available}
            title={available ? undefined : "即将开放"}
            onClick={() => actions.act(() => runAction(actions.client, actions.store, actions.direction.id, action))}
            className={PRIMARY_BUTTON}
          >
            {actionLabel(action)}
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
 * The ladder: each level a row, opened in place to say what it covers, how it is passed and where
 * it stands.
 *
 * @remarks
 * Prototype 5A (2026-11-09), wide and narrow alike.
 *
 * @sideEffects Keeps which level is open.
 * @param props - The progress.
 * @returns The list.
 */
function Ladder({ progress }: { readonly progress: StudyProgress }) {
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
 * Where a gap came from: the step's title and the question's number.
 *
 * @remarks
 * Prototype C: "事务 · 测验第 4 题".
 *
 * @sideEffects none
 * @param gap - The gap.
 * @param progress - The progress.
 * @returns The words.
 */
function gapSource(gap: StudyGap, progress: StudyProgress): string {
  const levelAt = progress.ladder.findIndex((level) => level.id === gap.from.level);
  const step = progress.steps[gap.from.level]?.find((one) => one.id === gap.from.step);
  const title = step === undefined ? null : stepTitle(step, levelAt + 1, progress.ladder.length);
  const question = gap.from.question === undefined ? null : `测验第 ${String(gap.from.question)} 题`;
  return [title, question].filter((part) => part !== null).join(" · ");
}

/**
 * The gaps: open ones first, fixed ones struck through; marking one fixed by hand and back.
 *
 * @remarks
 * Prototype 3A (2026-11-09): hovering an open gap shows a round tick, "标为已补"; a gap you
 * fixed says "你标的已补 · 撤回". Nothing without gaps; where nothing may change, the gaps
 * without their buttons.
 *
 * @sideEffects Sends `mark_study_gap` when used.
 * @param props - The progress and how to act.
 * @returns The section, or nothing.
 */
function Gaps({ progress, actions }: { readonly progress: StudyProgress; readonly actions: HomeActions }) {
  if (progress.gaps.length === 0) return null;
  const gaps = progress.gaps.toSorted((a, b) => Number(a.fixed !== null) - Number(b.fixed !== null));
  const { client, direction, act } = actions;
  return (
    <section aria-label="漏洞">
      <h2 className={SECTION_HEADING}>漏洞</h2>
      <ul className={CARD}>
        {gaps.map((gap, at) => {
          const source = gapSource(gap, progress);
          return (
            <li
              key={gap.id}
              data-testid="study-gap"
              data-fixed={gap.fixed === null ? "no" : gap.fixed.by}
              className={`group flex items-start gap-2.5 py-[9px] pr-2.5 pl-3 text-[length:var(--fs-meta)] leading-[1.5] text-[var(--text-2)] ${
                at === 0 ? "" : "shadow-[inset_0_0.5px_0_var(--line)]"
              }`}
            >
              <span
                className={`mt-1.5 block size-2 shrink-0 rounded-[2px] ${gap.fixed === null ? "bg-[var(--attn)]" : "bg-[var(--ok)]"}`}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={
                    gap.fixed === null ? "" : "text-[var(--text-dim)] line-through decoration-[var(--line-strong)]"
                  }
                >
                  {gap.text}
                </span>
                <span className="block text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                  {source}
                  {gap.fixed?.by === "manual" && actions.readOnly ? (
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
              {gap.fixed === null && !actions.readOnly ? (
                <button
                  type="button"
                  aria-label="标为已补"
                  title="标为已补"
                  onClick={() => act(() => client.markStudyGap(direction.id, gap.id, true))}
                  className="grid size-[22px] shrink-0 place-items-center rounded-full bg-[var(--surface-1)] text-[var(--text-muted)] opacity-0 shadow-[inset_0_0_0_1px_var(--line-strong)] group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Check size={12} aria-hidden />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
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
 * Prototype C with study-progress-states 1A, 3A, 4A and 5A (2026-11-09): two columns where the
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
}: {
  readonly progress: StudyProgress;
  readonly sessions: readonly SessionSummary[];
  readonly now: number;
  readonly actions: HomeActions;
}) {
  const level = shownLevel(progress);
  const steps = level === null ? [] : (progress.steps[level.id] ?? []);
  const currentAt = steps.findIndex((step) => step.done === null);
  const current = steps[currentAt];
  const others = sessions.filter((session) => session.study?.step === undefined);
  const { archived } = actions.direction;
  const finished = progress.finishedAt !== null;
  const card =
    current === undefined || level === null || archived || finished ? null : (
      <CurrentStep
        step={current}
        number={currentAt + 1}
        title={stepTitle(current, level.number, progress.ladder.length)}
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
            </section>
          )}
        </div>
        <div className="contents @min-[640px]:flex @min-[640px]:flex-col @min-[640px]:gap-5">
          <div className="order-2 @min-[640px]:order-none">
            <Ladder progress={progress} />
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
 * @sideEffects Subscribes to the list and the clock; sends commands when used.
 * @param props - The client, the study store and the direction.
 * @returns The home, or nothing for a direction the list does not have.
 */
export function DirectionHome({
  client,
  store,
  directionId,
}: {
  readonly client: AtriumClient;
  readonly store: StoreApi<LearningState>;
  readonly directionId: string;
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
  const actions: HomeActions = {
    client,
    store,
    direction,
    readOnly: direction.archived || direction.broken || direction.newer,
    busy,
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
  return (
    <div data-testid="direction-home" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[780px] px-6 py-8">
        <h1 className="text-[22px] font-semibold text-[var(--text)]">{directionName(direction)}</h1>
        <p className="mt-1.5 flex min-w-0 items-center gap-2 text-[length:var(--fs-meta)] whitespace-nowrap text-[var(--text-muted)]">
          {direction.archived ? (
            <span className="shrink-0 rounded-[var(--r-pill)] bg-[var(--selected)] px-[7px] text-[length:var(--fs-xs)] leading-[18px] font-semibold text-[var(--text-muted)]">
              已归档
            </span>
          ) : direction.discussing || direction.broken ? (
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
                  ? directionStage(direction).line
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
          sessions.length === 0 ? null : (
            <div className="mt-5">
              <SessionRows sessions={sessions} label="会话" now={now} actions={actions} />
            </div>
          )
        ) : (
          <Progress progress={progress} sessions={sessions} now={now} actions={actions} />
        )}
      </div>
    </div>
  );
}
