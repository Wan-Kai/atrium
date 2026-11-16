import { activeGraphOf, nodeStates, sinksOf, stateOf } from "./graph";
import type { Task, TaskStatus } from "./types";

/**
 * The task's status, from its nodes and flags.
 *
 * @remarks
 * SPEC-0006, "任务", in that priority: cancelled, designing, stopped, waiting, running, done.
 * The table there has no row for a started task whose nodes are all `pending`, which happens while the
 * first worktree is being made or every slot is taken; such a task is `running`.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The status.
 */
export function deriveStatus(task: Task): TaskStatus {
  if (task.cancelled) return "cancelled";
  const graph = activeGraphOf(task);
  if (graph === undefined || graph.approvedAt === null) return "designing";
  const states = nodeStates(task).map((entry) => entry.state);
  if (task.paused || states.includes("failed") || states.includes("stopped")) return "stopped";
  if (states.includes("waiting")) return "waiting";
  if (states.includes("running") || states.includes("held")) return "running";
  if (sinksOf(graph).every((node) => stateOf(task, node) === "passed")) return "done";
  return "running";
}

/**
 * Whether something other than the user's own stop holds the task back: it is paused or a node failed.
 *
 * @remarks
 * These are the two causes of `held` (SPEC-0006, "节点"). A node the user stopped by hand does not
 * hold its siblings.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns Whether it is held back.
 */
export function isHeldBack(task: Task): boolean {
  return task.paused || nodeStates(task).some((entry) => entry.state === "failed");
}
