import type { AtriumClient } from "@atrium/client";
import { useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { Message } from "../design/icons";
import { PRIMARY_BUTTON } from "../settings/parts";
import { sessionTitle, timeAgo } from "../sidebar/names";
import { useClock } from "../state/clock";
import {
  type LearningState,
  describeStudyError,
  directionName,
  directionSessions,
  directionStage,
  openDirectionSession,
} from "./learning";

/**
 * A direction's home, under its fixed home tab.
 *
 * @remarks
 * SPEC-0008 ("方向主页", "ML1 定的细节"), ML1's part only: the title and "讨论中" or "已归档",
 * then the direction's sessions not archived, last active first, each opened from its row
 * (there is no "继续讨论"). Every session has a purpose icon; ML1 only has the discussion's. An
 * archived direction offers "恢复" above its list, and its sessions open to be read. The step
 * strip, ladder, gaps and files come in ML2. A failure shows under the list (provisional wording).
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
  const stranded = useStore(store, (state) =>
    state.stranded?.directionId === directionId ? state.stranded.failure : undefined,
  );
  if (direction === undefined) return null;
  const sessions = directionSessions(all, directionId);
  /**
   * Runs the home's command, showing its failure.
   *
   * @remarks
   * See `DirectionHome`.
   *
   * @sideEffects Runs the command; may set the problem.
   * @param command - The command.
   */
  const act = (command: () => Promise<unknown>): void => {
    setProblem(null);
    // Fire and forget: the failure is shown.
    void command().catch((error: unknown) => setProblem(describeStudyError(error)));
  };
  return (
    <div data-testid="direction-home" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[var(--column)] px-6 py-8">
        <h1 className="text-[22px] font-semibold text-[var(--text)]">{directionName(direction)}</h1>
        <p className="mt-1.5 flex items-center gap-2 text-[length:var(--fs-meta)] text-[var(--text-muted)]">
          {direction.archived ? (
            <span className="rounded-[var(--r-pill)] bg-[var(--selected)] px-[7px] text-[length:var(--fs-xs)] leading-[18px] font-semibold text-[var(--text-muted)]">
              已归档
            </span>
          ) : direction.discussing || direction.broken ? (
            <span className="rounded-[var(--r-pill)] bg-[var(--attn-soft)] px-[7px] text-[length:var(--fs-xs)] leading-[18px] font-semibold text-[var(--attn-text)]">
              讨论中
            </span>
          ) : null}
          <span>
            {direction.archived
              ? "会话只能看，恢复以后才能接着学"
              : direction.broken || !direction.discussing
                ? directionStage(direction).line
                : "排出阶梯以后，这里显示当前一级的步骤"}
          </span>
        </p>
        {direction.archived ? (
          <div className="mt-5">
            <button
              type="button"
              className={PRIMARY_BUTTON}
              onClick={() => act(() => client.restoreDirection(directionId))}
            >
              恢复
            </button>
          </div>
        ) : null}
        {sessions.length === 0 ? null : (
          <ul aria-label="会话" className="mt-5">
            {sessions.map((session) => (
              <li key={session.sessionId}>
                <button
                  type="button"
                  onClick={() => act(() => openDirectionSession(client, store, directionId, session.sessionId))}
                  className="my-0.5 flex h-[34px] w-full items-center gap-2 rounded-[var(--r)] px-2 text-left text-[var(--text-2)] hover:bg-[var(--hover)]"
                >
                  <Message size={14} aria-hidden className="shrink-0 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">{sessionTitle(session)}</span>
                  <span className="shrink-0 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                    {timeAgo(session.updatedAt, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {problem === null && stranded === undefined ? null : (
          <p role="alert" className="mt-3 text-[length:var(--fs-sm)] text-[var(--danger)]">
            {problem ?? `方向建好了，但没能开始会话：${describeStudyError(stranded)}`}
          </p>
        )}
      </div>
    </div>
  );
}
