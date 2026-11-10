import { step } from "./scheduler";
import type { Action, Task, TaskEvent } from "./types";

/** One event of a replay with what it did. */
export interface ReplayStep {
  readonly event: TaskEvent;
  /** The task after the event. */
  readonly task: Task;
  /** What the scheduler asked for. */
  readonly actions: readonly Action[];
}

/**
 * An event log that cannot be replayed.
 *
 * @remarks
 * Thrown for a log that does not begin with `created` or whose `seq` skips: such a log was damaged or
 * written by something else, and playing it on would build a wrong task.
 *
 * @sideEffects none
 */
export class ReplayError extends Error {
  /**
   * Creates the error.
   *
   * @remarks
   * Carries the event that did not fit, so a tool can point at it.
   *
   * @sideEffects none
   * @param message - What was wrong.
   * @param seq - The `seq` of the event, when there is one.
   */
  constructor(
    message: string,
    readonly seq: number | null,
  ) {
    super(message);
    this.name = "ReplayError";
  }
}

/**
 * Plays an event log through the scheduler from nothing.
 *
 * @remarks
 * `task.json` is only a snapshot of this (SPEC-0006, "事件"): the first event is `created`, which
 * holds the task as it began, and each later one goes through `step`. The actions are returned too,
 * since a replay after a crash may have to send the last ones again (SPEC-0006, "动作要幂等").
 *
 * @sideEffects none
 * @param events - The events in `seq` order.
 * @returns Every step; empty for an empty log.
 * @throws {ReplayError} When the first event is not `created`, a `created` comes later, or `seq` is not 1, 2, 3….
 */
export function replayEvents(events: readonly TaskEvent[]): ReplayStep[] {
  const steps: ReplayStep[] = [];
  let task: Task | null = null;
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1) throw new ReplayError(`event ${index + 1} has seq ${event.seq}`, event.seq);
    if (task === null) {
      if (event.type !== "created") throw new ReplayError("the first event is not `created`", event.seq);
      task = structuredClone(event.task);
      steps.push({ event, task, actions: [] });
      continue;
    }
    if (event.type === "created") throw new ReplayError("`created` after the first event", event.seq);
    const result = step(task, event);
    task = result.task;
    steps.push({ event, task, actions: result.actions });
  }
  return steps;
}
