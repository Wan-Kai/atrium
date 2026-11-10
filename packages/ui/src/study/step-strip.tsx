import type { AtriumClient } from "@atrium/client";
import type { Control, StudyAction } from "@atrium/protocol";
import { useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { type WorkspaceViews, showViewer } from "../state/workspace-views";
import { Archive, Award, Message, Mortarboard, Warning } from "../design/icons";
import { type LearningState, confirmUpgrade, describeStudyError, openDirectionSession, showHome } from "./learning";
import { useLessonControl } from "./lesson-control";
import { isLastLevel, waitsForLesson } from "./loop";
import { actionLabel, stripView } from "./progress";
import { StepDots } from "./step-dots";
import { UpgradeDialog } from "./upgrade-dialog";

/** The strip's buttons: 26px high, 10px across, 9px corners (design-language "常驻步骤条"). */
const STRIP_BUTTON =
  "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 text-[length:var(--fs-sm)] whitespace-nowrap";

/**
 * Runs one of the strip's actions.
 *
 * @remarks
 * SPEC-0008, "下一步怎么算": a start asks the host to open the session, shown over the home (the
 * host opens its tab, a new one or the one there already); going back opens the session already
 * there; a mark is "以后再测" or "进入下一步"; the upgrade asks first (prototype 4A). Not
 * available ones are never run. A session opened or started shows over the direction's viewer tab
 * too: it may be the one already active, which the host's answer does not change (ML4 three-way
 * review).
 *
 * @sideEffects Sends a command; updates the study store and, given, the views.
 * @param client - The client.
 * @param store - The study store.
 * @param directionId - The direction.
 * @param action - The action.
 * @param views - The workspace views, whose viewer tab of the direction gives way to the session.
 * @returns When the host answered.
 */
export async function runAction(
  client: Pick<AtriumClient, "startStudySession" | "markStudyStep" | "openSession">,
  store: StoreApi<LearningState>,
  directionId: string,
  action: StudyAction,
  views?: StoreApi<WorkspaceViews>,
): Promise<void> {
  switch (action.type) {
    case "open":
      await openDirectionSession(client, store, directionId, action.sessionId);
      if (views !== undefined) showViewer(views, directionId, null);
      return;
    case "mark":
      await client.markStudyStep(directionId, action.level, action.step, action.mark, true);
      return;
    case "upgrade":
      if (action.available) confirmUpgrade(store, { directionId, level: action.level });
      return;
    case "start":
    default: {
      if (!action.available) return;
      const { kind, level, step, gap } = action;
      showHome(store, directionId, false);
      await client.startStudySession(directionId, {
        kind,
        level,
        ...(step === undefined ? {} : { step }),
        ...(gap === undefined ? {} : { gap }),
      });
      if (views !== undefined) showViewer(views, directionId, null);
      return;
    }
  }
}

/**
 * Why an action cannot be pressed now, as its tooltip says; `null` when it can.
 *
 * @remarks
 * Prototype 2A: a quiz waits for its lesson's turn to end (`waitsForLesson`); one the host marks not
 * available (none since ML3) is faded without words.
 *
 * @sideEffects none
 * @param action - The action.
 * @param sessions - The direction's sessions, of this direction only.
 * @param control - The lesson's control, when this window shows it (`useLessonControl`).
 * @returns The reason, "" for one faded without words, or `null`.
 */
export function blockedBecause(
  action: StudyAction,
  sessions: Parameters<typeof waitsForLesson>[1],
  control: Control | null = null,
): string | null {
  if ((action.type === "start" || action.type === "upgrade") && !action.available) return "";
  return waitsForLesson(action, sessions, () => control) ? "等上课这一轮结束" : null;
}

/**
 * The step strip under the tab bar, on a direction's home and in each of its sessions.
 *
 * @remarks
 * design-language "常驻步骤条" (option C, 2026-11-05) and prototype study-progress-states 2D
 * (2026-11-09): 40px, the level, a dot a step, the current step and its phase, the host's next
 * step as buttons at the right. Under discussion one sentence; a broken file, archived, a file of
 * a later version or finished, the dots without buttons. ML3 (prototype 2A): a quiz faded with
 * "等上课这一轮结束" while its lesson's turn runs; a level with no lessons yet shows no dots and
 * "还没排课" (or "排计划中" with its plan session open); the last level's upgrade says "学完"; the
 * upgrade's confirmation shows from here, for the home's card too. The buttons wait while a press
 * is under way, so one press opens one session. A failure shows in place of the phase
 * (provisional wording).
 *
 * @sideEffects Subscribes to the list and the study store; sends commands when a button is pressed.
 * @param props - The client, the study store, the direction and the workspace views.
 * @returns The strip, or nothing for a direction the list does not have.
 */
export function StepStrip({
  client,
  store,
  directionId,
  views,
}: {
  readonly client: AtriumClient;
  readonly store: StoreApi<LearningState>;
  readonly directionId: string;
  /** The workspace views: a session the strip opens shows over the direction's viewer tab. */
  readonly views?: StoreApi<WorkspaceViews> | undefined;
}) {
  const direction = useStore(client.index, (index) => index.directions.find((one) => one.id === directionId));
  const sessions = useStore(client.index, (index) => index.sessions);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const upgradingHere = useStore(store, (state) =>
    state.upgrading?.directionId === directionId ? state.upgrading.level : null,
  );
  const mine = sessions.filter((session) => session.containerId === directionId);
  // Only a quiz waits for a lesson; at most one of the two buttons is one.
  const quizAction = [direction?.next.primary ?? null, direction?.next.secondary ?? null].find(
    (action) => action?.type === "start" && action.kind === "quiz",
  );
  const lessonControl = useLessonControl(client, quizAction ?? null, mine);
  if (direction === undefined) return null;
  const view = stripView(direction, mine);
  const frame =
    "flex h-10 shrink-0 items-center gap-3 overflow-hidden pr-2.5 pl-4 text-[length:var(--fs-sm)] whitespace-nowrap text-[var(--text-muted)] shadow-[inset_0_-0.5px_0_var(--line)]";
  if (view.kind === "discussing") {
    return (
      <div data-testid="step-strip" data-state="discussing" className={frame}>
        <Message size={14} aria-hidden className="shrink-0 text-[var(--text-2)]" />
        <span className="min-w-0 truncate">讨论中，排出阶梯以后这里显示当前一级的步骤</span>
      </div>
    );
  }
  if (view.kind === "broken") {
    return (
      <div data-testid="step-strip" data-state="broken" className={frame}>
        <span className="inline-flex items-center gap-[5px] font-medium text-[var(--attn-text)]">
          <Warning size={14} aria-hidden />
          档案读不出来
        </span>
        <StepDots dots={{ kind: "broken", count: view.dots }} />
      </div>
    );
  }
  const { primary, secondary } = direction.next;
  const last = view.level !== null && direction.progress !== null && isLastLevel(direction.progress, view.level.id);
  // No lesson yet (only the round dots of the steps after the lessons, or none): plan it (2A).
  const unplanned = view.kind === "learning" && !view.dots.some((dot) => !dot.round);
  const running =
    primary?.type === "open" && sessions.some((session) => session.sessionId === primary.sessionId && session.running);
  /**
   * Runs a button's action, showing its failure.
   *
   * @remarks
   * See `runAction`.
   *
   * @sideEffects Sends a command; may set the problem.
   * @param action - The action.
   */
  const press = (action: StudyAction): void => {
    setProblem(null);
    setBusy(true);
    // Fire and forget: a failure is shown on the strip; the buttons wait until the host answered.
    void runAction(client, store, directionId, action, views)
      .catch((error: unknown) => setProblem(describeStudyError(error)))
      .finally(() => setBusy(false));
  };

  const label =
    view.kind === "archived"
      ? "已归档"
      : view.kind === "newer"
        ? "档案是更新版本的 Atrium 写的，只能看"
        : view.kind === "finished"
          ? "已学完"
          : view.level === null
            ? ""
            : `第 ${String(view.level.number)} 级 · ${view.level.name}`;
  const upgrading =
    upgradingHere === null ? null : (
      <UpgradeDialog client={client} store={store} directionId={directionId} level={upgradingHere} />
    );
  return (
    <div data-testid="step-strip" data-state={view.kind} className={frame}>
      <span
        className={`inline-flex max-w-[40%] min-w-0 shrink-0 items-center gap-[5px] font-medium ${view.kind === "finished" ? "text-[var(--ok-text)]" : "text-[var(--text-2)]"}`}
      >
        {view.kind === "archived" ? (
          <Archive size={14} aria-hidden />
        ) : view.kind === "newer" ? (
          <Warning size={14} aria-hidden />
        ) : view.kind === "finished" ? (
          <Award size={14} aria-hidden />
        ) : (
          <Mortarboard size={14} aria-hidden className="shrink-0" />
        )}
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
      </span>
      {unplanned ? null : <StepDots dots={{ kind: "steps", dots: view.dots, look: view.kind }} />}
      <span className="min-w-0 truncate">
        {problem !== null ? (
          <span role="alert" className="text-[var(--danger)]">
            {problem}
          </span>
        ) : view.kind === "finished" ? (
          `共 ${String(view.levels)} 级`
        ) : unplanned ? (
          primary?.type === "open" ? (
            <b className="font-medium text-[var(--text)]">排计划中</b>
          ) : (
            <>
              <b className="font-medium text-[var(--text)]">还没排课</b>
              {" · 排计划会话排出课以后，这里是这一级的步骤"}
            </>
          )
        ) : view.step === null ? null : view.kind === "archived" || view.kind === "newer" ? (
          `停在第 ${String(view.step.number)} 步`
        ) : (
          <>
            <b className="font-medium text-[var(--text)]">
              第 {view.step.number} 步 · {last && view.step.number === view.dots.length ? "学完" : view.step.title}
            </b>
            {view.step.phase === "" ? null : ` · ${view.step.phase}`}
          </>
        )}
      </span>
      <span className="flex-1" />
      {view.kind !== "learning" ? null : (
        <>
          {secondary === null ? null : (
            <button
              type="button"
              disabled={busy || blockedBecause(secondary, mine, lessonControl) !== null}
              onClick={() => press(secondary)}
              className={`${STRIP_BUTTON} text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)] disabled:opacity-[0.42]`}
            >
              {actionLabel(secondary, last)}
            </button>
          )}
          {primary === null ? null : primary.type === "open" ? (
            <>
              {running ? <span aria-label="在跑" className="size-[7px] shrink-0 rounded-full bg-[var(--ok)]" /> : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => press(primary)}
                className={`${STRIP_BUTTON} font-medium text-[var(--tint)] shadow-[inset_0_0_0_1px_var(--tint)] hover:bg-[var(--linked)] disabled:opacity-[0.42]`}
              >
                {actionLabel(primary)}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || blockedBecause(primary, mine, lessonControl) !== null}
              title={blockedBecause(primary, mine, lessonControl) || undefined}
              onClick={() => press(primary)}
              className={`${STRIP_BUTTON} bg-[var(--tint)] font-semibold text-[var(--on-tint)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-[0.42]`}
            >
              {actionLabel(primary, last)}
            </button>
          )}
        </>
      )}
      {upgrading}
    </div>
  );
}
