import type { AtriumClient } from "@atrium/client";
import type { StudyAction } from "@atrium/protocol";
import { useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { Archive, Award, Message, Mortarboard, Warning } from "../design/icons";
import { type LearningState, describeStudyError, openDirectionSession, showHome } from "./learning";
import { type StripDot, actionLabel, stripView } from "./progress";

/** The strip's buttons: 26px high, 10px across, 9px corners (design-language "常驻步骤条"). */
const STRIP_BUTTON =
  "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 text-[length:var(--fs-sm)] whitespace-nowrap";

/**
 * Runs one of the strip's actions.
 *
 * @remarks
 * SPEC-0008, "下一步怎么算": a start asks the host to open the session, shown over the home; going
 * back opens the session already there; a mark is "以后再测" or "进入下一步". Not available ones
 * are never run.
 *
 * @sideEffects Sends a command; updates the study store.
 * @param client - The client.
 * @param store - The study store.
 * @param directionId - The direction.
 * @param action - The action.
 * @returns When the host answered.
 */
export async function runAction(
  client: Pick<AtriumClient, "startStudySession" | "markStudyStep" | "openSession">,
  store: StoreApi<LearningState>,
  directionId: string,
  action: StudyAction,
): Promise<void> {
  switch (action.type) {
    case "open":
      await openDirectionSession(client, store, directionId, action.sessionId);
      return;
    case "mark":
      await client.markStudyStep(directionId, action.level, action.step, action.mark, true);
      return;
    case "start": {
      if (!action.available) return;
      const { kind, level, step, gap } = action;
      showHome(store, directionId, false);
      await client.startStudySession(directionId, { kind, level, step, ...(gap === undefined ? {} : { gap }) });
      return;
    }
    case "upgrade":
    default:
      return;
  }
}

/**
 * Whether an action can be pressed now.
 *
 * @remarks
 * A session ML2 cannot open, and the upgrade, are drawn but not pressed (prototype 2D).
 *
 * @sideEffects none
 * @param action - The action.
 * @returns Whether.
 */
function available(action: StudyAction): boolean {
  return action.type === "start" || action.type === "upgrade" ? action.available : true;
}

/**
 * One dot of the strip.
 *
 * @remarks
 * design-language "常驻步骤条" and prototype 2D: 8px, lessons square (2px corners), the steps after
 * round; done `--text-muted`, current `--tint`, not done `--line-strong`; the broken file's are
 * hollow placeholders, the current one of an archived direction or a later version's file a grey
 * ring, a finished one's all lit.
 *
 * @sideEffects none
 * @param props - The dot and how the strip draws it.
 * @returns The dot.
 */
function Dot({ dot, look }: { readonly dot: StripDot; readonly look: "learning" | "archived" | "finished" | "newer" }) {
  const shape = dot.round ? "rounded-full" : "rounded-[2px]";
  const fill =
    look === "finished"
      ? "bg-[var(--tint)]"
      : dot.state === "done"
        ? "bg-[var(--text-muted)]"
        : dot.state === "current"
          ? look === "archived" || look === "newer"
            ? "shadow-[inset_0_0_0_1.5px_var(--text-muted)]"
            : "bg-[var(--tint)]"
          : "bg-[var(--line-strong)]";
  return <i data-state={dot.state} className={`block size-2 ${shape} ${fill}`} />;
}

/**
 * The step strip under the tab bar, on a direction's home and in each of its sessions.
 *
 * @remarks
 * design-language "常驻步骤条" (option C, 2026-11-05) and prototype study-progress-states 2D
 * (2026-11-09): 40px, the level, a dot a step, the current step and its phase, the host's next
 * step as buttons at the right. Under discussion one sentence; a broken file, archived, a file of
 * a later version or finished, the dots without buttons; a button for a session not made yet
 * faded with "即将开放". The buttons wait while a press is under way, so one press opens one
 * session. A failure shows in place of the phase (provisional wording).
 *
 * @sideEffects Subscribes to the list; sends commands when a button is pressed.
 * @param props - The client, the study store and the direction.
 * @returns The strip, or nothing for a direction the list does not have.
 */
export function StepStrip({
  client,
  store,
  directionId,
}: {
  readonly client: AtriumClient;
  readonly store: StoreApi<LearningState>;
  readonly directionId: string;
}) {
  const direction = useStore(client.index, (index) => index.directions.find((one) => one.id === directionId));
  const sessions = useStore(client.index, (index) => index.sessions);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (direction === undefined) return null;
  const view = stripView(
    direction,
    sessions.filter((session) => session.containerId === directionId),
  );
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
        <span className="inline-flex gap-[3px]" aria-hidden>
          {Array.from({ length: view.dots }, (_, at) => (
            <i key={at} className="block size-2 rounded-[2px] shadow-[inset_0_0_0_1px_var(--line-strong)]" />
          ))}
        </span>
      </div>
    );
  }
  const { primary, secondary } = direction.next;
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
    void runAction(client, store, directionId, action)
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
      <span className="inline-flex gap-[3px]" role="img" aria-label={`共 ${String(view.dots.length)} 步`}>
        {view.dots.map((dot) => (
          <Dot key={dot.id} dot={dot} look={view.kind} />
        ))}
      </span>
      <span className="min-w-0 truncate">
        {problem !== null ? (
          <span role="alert" className="text-[var(--danger)]">
            {problem}
          </span>
        ) : view.kind === "finished" ? (
          `共 ${String(view.levels)} 级`
        ) : view.step === null ? null : view.kind === "archived" || view.kind === "newer" ? (
          `停在第 ${String(view.step.number)} 步`
        ) : (
          <>
            <b className="font-medium text-[var(--text)]">
              第 {view.step.number} 步 · {view.step.title}
            </b>
            {` · ${view.step.phase}`}
          </>
        )}
      </span>
      <span className="flex-1" />
      {view.kind !== "learning" ? null : (
        <>
          {secondary === null ? null : (
            <button
              type="button"
              disabled={busy || !available(secondary)}
              onClick={() => press(secondary)}
              className={`${STRIP_BUTTON} text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)] disabled:opacity-[0.42]`}
            >
              {actionLabel(secondary)}
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
              disabled={busy || !available(primary)}
              title={available(primary) ? undefined : "即将开放"}
              onClick={() => press(primary)}
              className={`${STRIP_BUTTON} bg-[var(--tint)] font-semibold text-[var(--on-tint)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-[0.42]`}
            >
              {actionLabel(primary)}
            </button>
          )}
        </>
      )}
    </div>
  );
}
