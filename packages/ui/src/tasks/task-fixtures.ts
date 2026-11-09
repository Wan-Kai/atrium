import type { TaskNode, TaskSummary, TaskView } from "@atrium/protocol";

/** The time the fixtures treat as now: 2026-11-06 12:00 UTC. */
export const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

/** One minute and one day, in milliseconds. */
export const MINUTE = 60_000;
export const DAY = 86_400_000;

/**
 * Refuses a task row the host could never send.
 *
 * @remarks
 * T8 review fix 1: a fixture said `running` with `paused`, which the host never sends (`deriveStatus` makes a paused
 * task `stopped`), so a test passed on a state the app never sees. The states the host rules out are thrown here.
 *
 * @sideEffects none
 * @param row - The row.
 * @returns The row.
 * @throws {Error} For a paused task that is not `stopped`, a designing one that has started, or a started one
 * that is designing.
 */
function hostPossible<T extends TaskSummary>(row: T): T {
  if (row.paused && row.status !== "stopped") throw new Error(`impossible task: ${row.status} but paused`);
  if (row.status === "designing" && row.startedAt !== null) throw new Error("impossible task: designing but started");
  return row;
}

/**
 * A task row for tests; every field can be set, the rest is a running task with nothing to say.
 *
 * @remarks
 * Shared by the tests of the task area, not by the app.
 *
 * @sideEffects none
 * @param id - The task's id after `tsk_`.
 * @param changes - The fields to set.
 * @returns The row.
 */
export function summary(id: string, changes: Partial<TaskSummary> = {}): TaskSummary {
  return hostPossible({
    id: `tsk_${id}`,
    name: `任务 ${id}`,
    status: "running",
    projectId: null,
    workspaceId: null,
    paused: false,
    createdAt: NOW - DAY,
    startedAt: NOW - DAY,
    endedAt: null,
    attention: null,
    archive: null,
    current: null,
    activeAt: NOW - MINUTE,
    scheduled: false,
    // A task being designed has not started.
    ...(changes.status === "designing" ? { startedAt: null } : {}),
    ...changes,
  });
}

/**
 * A node for tests: a pending agent node unless set otherwise.
 *
 * @remarks
 * Shared by the tests of the task area, not by the app.
 *
 * @sideEffects none
 * @param id - The node's id.
 * @param changes - The fields to set.
 * @returns The node.
 */
export function node(id: string, changes: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    name: `节点 ${id}`,
    kind: "agent",
    job: `${id} 要做的事`,
    done: [`${id} 做完的样子`],
    role: "work",
    place: "workspace",
    model: null,
    state: "pending",
    attempt: 0,
    waitingFor: null,
    blocked: null,
    failure: null,
    summary: null,
    sessionId: null,
    sendBack: [],
    ...changes,
  };
}

/**
 * A whole task for tests, with the nodes and edges given.
 *
 * @remarks
 * Shared by the tests of the task area, not by the app.
 *
 * @sideEffects none
 * @param id - The task's id after `tsk_`.
 * @param nodes - The graph's nodes.
 * @param edges - The graph's edges, as `[from, to]` pairs, or `[from, to, "back"]`.
 * @param changes - Row fields to set.
 * @returns The task.
 */
export function view(
  id: string,
  nodes: readonly TaskNode[],
  edges: readonly (readonly [string, string] | readonly [string, string, "seq" | "back"])[] = [],
  changes: Partial<TaskView> = {},
): TaskView {
  return hostPossible({
    ...summary(id, changes),
    taskSessionId: `ses_${id}`,
    model: { providerId: "anthropic", modelId: "opus-5.5", thinking: "high" },
    sourceSessionId: `src_${id}`,
    graphVersion: 1,
    pendingGraph: false,
    pending: null,
    graphDiff: null,
    requirements: { goal: "", decisions: [], constraints: [], nonGoals: [], openQuestions: [], acceptance: [] },
    reviews: [],
    nodes: [...nodes],
    edges: edges.map(([from, to, kind]) => ({ from, to, kind: kind ?? "seq" })),
    archiveFacts: null,
    followed: false,
    scheduleDraft: null,
    ...changes,
  });
}
