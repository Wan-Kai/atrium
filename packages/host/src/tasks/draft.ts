import { activeGraphOf } from "./graph";
import type { Action, Attention, NodeId, NodeRun, NodeState, ProgressLine, Task, TaskEvent } from "./types";

/**
 * A step in progress: a private copy of the task, the actions so far and the event being handled.
 *
 * @remarks
 * `step` never touches the task it is given; handlers change this copy and the result is returned
 * as a whole.
 */
export interface Draft {
  readonly task: Task;
  readonly actions: Action[];
  readonly event: TaskEvent;
  /** Progress lines written so far in this step, for their ids. */
  lines: number;
}

/**
 * Queues an action.
 *
 * @remarks
 * Order matters: the runner carries actions out in this order, and finishes them before the next
 * event, so a commit queued before a start is made before the next node begins.
 *
 * @sideEffects Changes `draft.actions`.
 * @param draft - The step.
 * @param action - The action.
 */
export function emit(draft: Draft, action: Action): void {
  draft.actions.push(action);
}

/**
 * Queues a line for the task conversation.
 *
 * @remarks
 * The id is the event's `seq` and the line's position, the same on a replay, so the extension can
 * drop a line it already wrote (SPEC-0006, "动作要幂等").
 *
 * @sideEffects Changes `draft.actions` and `draft.lines`.
 * @param draft - The step.
 * @param kind - What happened.
 * @param node - The node it is about, if any.
 */
export function progress(draft: Draft, kind: ProgressLine["kind"], node?: NodeId): void {
  const line: ProgressLine = {
    id: `${draft.event.seq}.${draft.lines}`,
    kind,
    ...(node === undefined ? {} : { node }),
  };
  draft.lines += 1;
  emit(draft, { kind: "progress_line", line });
}

/**
 * Asks for the user's attention.
 *
 * @remarks
 * Becomes an entry in "等你处理".
 *
 * @sideEffects Changes `draft.actions`.
 * @param draft - The step.
 * @param attention - Why.
 */
export function notify(draft: Draft, attention: Attention): void {
  emit(draft, { kind: "notify", attention });
}

/**
 * Makes a fresh run of a node.
 *
 * @remarks
 * A run begins under the graph in force. A node that is not yet running has no session, no start
 * commit and nothing pending.
 *
 * @sideEffects none
 * @param task - The task, for the graph version and the time of nothing else.
 * @param node - The node.
 * @param attempt - Which try.
 * @param state - Its first state.
 * @param at - The event's time.
 * @returns The run, not yet added to the task.
 */
export function freshRun(task: Task, node: NodeId, attempt: number, state: NodeState, at: number): NodeRun {
  return {
    node,
    attempt,
    graph: activeGraphOf(task)?.version ?? 1,
    state,
    waitingFor: null,
    blocked: null,
    sessionId: null,
    startedAt: at,
    endedAt: null,
    startCommit: null,
    pendingDone: null,
    summary: null,
    failure: null,
    commit: null,
    nudged: false,
  };
}
