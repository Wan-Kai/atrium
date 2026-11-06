import {
  TASK_TEXT_LIMIT,
  type PendingReview,
  type TaskArchiveFacts,
  type TaskAttention,
  type TaskCurrentNode,
  type TaskNode,
  type TaskNodeState,
  type TaskPendingGraph,
  type TaskGraphDiff,
  type TaskSummary,
  type TaskView,
} from "@atrium/protocol";
import { diffGraphs, previousGraph } from "./graph-diff";
import { activeGraphOf, latestRun, stateOf } from "./graph";
import { backUses } from "./scheduler";
import { deriveStatus } from "./status";
import type { GraphNode, Task } from "./types";

/**
 * Cuts a text the model wrote to the longest one the protocol carries.
 *
 * @remarks
 * A job, done line, summary or reason longer than the limit is cut, not refused: the board shows the start.
 *
 * @sideEffects none
 * @param text - The text.
 * @returns The text, cut if it was longer.
 */
function clip(text: string): string {
  return text.length > TASK_TEXT_LIMIT ? text.slice(0, TASK_TEXT_LIMIT) : text;
}

/** The longest goal the view carries; the task conversation's tool already takes no more (SPEC-0006, "T6 定下的细节"). */
const REQUIREMENT_GOAL_CHARS = 8000;

/**
 * What the user is wanted for, the most urgent first.
 *
 * @remarks
 * A failed node, then a merge that is blocked, a human node, a question, a graph change; looked at in the graph
 * in force. T5's choice for the list's marker (SPEC-0006, "T5 定下的细节"); the list's groups come from `status`.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The first that applies, or `null`.
 */
function attentionOf(task: Task): TaskAttention | null {
  const nodes = activeGraphOf(task)?.nodes ?? [];
  const runs = nodes.map((node) => latestRun(task, node.id));
  if (runs.some((run) => run?.state === "failed")) return "failed";
  const waiting = runs.filter((run) => run?.state === "waiting" && run.void !== true);
  if (waiting.some((run) => run?.waitingFor === "merge_blocked")) return "merge_blocked";
  if (waiting.some((run) => run?.waitingFor === "human")) return "human";
  if (waiting.some((run) => run?.waitingFor === "question")) return "question";
  if (waiting.some((run) => run?.waitingFor === "graph_change")) return "graph_change";
  return null;
}

/**
 * A task as one row of the list.
 *
 * @remarks
 * Pure; the host sends codes and states, never words (coding-standards.md).
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The row.
 */
export function summaryOf(task: Task): TaskSummary {
  return {
    id: task.id,
    name: task.name,
    status: deriveStatus(task),
    projectId: task.projectId,
    workspaceId: task.workspaceId,
    paused: task.paused,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    attention: attentionOf(task),
    archive: task.archive ?? null,
    current: currentOf(task),
    activeAt: activeAtOf(task),
    scheduled: task.origin.kind === "schedule",
  };
}

/** How urgently a node's state names the task's place in the list, the lowest number first. */
const PLACE_RANK: Readonly<Partial<Record<TaskNodeState, number>>> = { failed: 0, stopped: 1, waiting: 2, running: 3 };

/**
 * The node a task row names: the most pressing of the graph in force.
 *
 * @remarks
 * A failed node, then a stopped, a waiting, a running one, the first in graph order among equals; `null` while
 * none of them is (not started, all passed, or no graph). A node voided by a graph change does not count.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The node, or `null`.
 */
function currentOf(task: Task): TaskCurrentNode | null {
  let best: { readonly rank: number; readonly node: TaskCurrentNode } | null = null;
  for (const node of activeGraphOf(task)?.nodes ?? []) {
    const state = stateOf(task, node.id);
    const rank = PLACE_RANK[state];
    if (rank !== undefined && (best === null || rank < best.rank))
      best = { rank, node: { id: node.id, name: node.name, state } };
  }
  return best?.node ?? null;
}

/**
 * When something last happened in the task: a node began or ended, else the task started or was made.
 *
 * @remarks
 * The row's "最后活动". The task's own events are in `events.jsonl`; the runs carry the times that matter to
 * the user, and reading them costs nothing more.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The time, in epoch milliseconds.
 */
function activeAtOf(task: Task): number {
  return task.runs.reduce(
    (latest, run) => Math.max(latest, run.startedAt, run.endedAt ?? 0),
    task.endedAt ?? task.startedAt ?? task.createdAt,
  );
}

/**
 * One node as the board shows it.
 *
 * @remarks
 * Its state and run come from its latest run; the summary is the latest one that was given, so a node that was
 * sent back still shows what it handed over last time. A human node carries its back edges and how often each
 * was used, for the UI to grey an option at the limit.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node.
 * @param backs - The back edges of the graph.
 * @returns The node's view.
 */
function nodeView(task: Task, node: GraphNode, backs: readonly { from: string; to: string }[]): TaskNode {
  const run = latestRun(task, node.id);
  const summary =
    task.runs.filter((one) => one.node === node.id && one.summary !== null).toSorted((a, b) => b.attempt - a.attempt)[0]
      ?.summary ?? null;
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    job: clip(node.job),
    done: node.done.map(clip),
    ...(node.role === undefined ? {} : { role: node.role }),
    ...(node.place === undefined ? {} : { place: node.place }),
    ...(node.merge === undefined ? {} : { merge: node.merge }),
    model: node.model === undefined ? null : node.model,
    state: stateOf(task, node.id),
    attempt: run?.attempt ?? 0,
    waitingFor: run?.state === "waiting" && run.void !== true ? run.waitingFor : null,
    blocked: run?.state === "waiting" ? run.blocked : null,
    ...(run?.blockedFiles === undefined || run.state !== "waiting" ? {} : { blockedFiles: run.blockedFiles }),
    failure: run?.state === "failed" ? run.failure : null,
    summary: summary === null ? null : clip(summary),
    sessionId: run?.sessionId ?? null,
    ...(run?.backFrom === undefined
      ? {}
      : { backFrom: { node: run.backFrom.node, reason: clip(run.backFrom.reason) } }),
    sendBack:
      node.kind === "human"
        ? backs
            .filter((edge) => edge.from === node.id)
            .map((edge) => ({ to: edge.to, uses: backUses(task, node.id, edge.to) }))
        : [],
  };
}

/**
 * What the graph in force changed against the version in force before it.
 *
 * @remarks
 * `null` for the first version. T8b frames the changed nodes with a dashed blue line and marks the added ones.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The difference, or `null`.
 */
function graphDiffOf(task: Task): TaskGraphDiff | null {
  const active = activeGraphOf(task);
  const before = active === undefined ? undefined : previousGraph(task, active.version);
  if (active === undefined || before === undefined) return null;
  return diffGraphs(before, active);
}

/**
 * The graph waiting for approval, whole, with what it changes against the one in force.
 *
 * @remarks
 * The card's "点开在图上看" draws it, and the board has only the graph in force otherwise.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The graph, or `null` when none waits.
 */
function pendingOf(task: Task): TaskPendingGraph | null {
  const pending = task.graphs.find((graph) => graph.version === task.pendingGraph);
  const active = activeGraphOf(task);
  if (pending === undefined || active === undefined) return null;
  return {
    version: pending.version,
    author: pending.author,
    note: clip(pending.note),
    nodes: pending.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      job: clip(node.job),
      done: node.done.map(clip),
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(node.place === undefined ? {} : { place: node.place }),
      ...(node.merge === undefined ? {} : { merge: node.merge }),
      model: node.model === undefined ? null : node.model,
    })),
    edges: pending.edges.map(({ from: start, to, kind }) => ({ from: start, to, kind })),
    diff: diffGraphs(active, pending),
  };
}

/**
 * A task as the board shows it: the graph in force and its nodes.
 *
 * @remarks
 * The archive facts are not part of the task; the caller works them out (git) while the question is open and
 * passes them in.
 *
 * @sideEffects none
 * @param task - The task.
 * @param archiveFacts - The facts of the archive question, or `null`.
 * @param followed - Whether the task is only followed (another process writes it); `false` for the host's own.
 * @param reviews - What waits for the user's verdict, worked out by the caller (it needs git); none for a followed task.
 * @returns The view.
 */
export function viewOf(
  task: Task,
  archiveFacts: TaskArchiveFacts | null,
  followed = false,
  reviews: readonly PendingReview[] = [],
): TaskView {
  const graph = activeGraphOf(task);
  const backs = (graph?.edges ?? []).filter((edge) => edge.kind === "back");
  return {
    ...summaryOf(task),
    taskSessionId: task.taskSessionId,
    model: task.model,
    // A followed task's source conversation is in the other process's home, so there is nothing to open.
    sourceSessionId: task.origin.kind === "chat" && !followed ? task.origin.sessionId : null,
    graphVersion: task.activeGraph,
    pendingGraph: task.pendingGraph !== null,
    pending: pendingOf(task),
    graphDiff: graphDiffOf(task),
    requirements: {
      goal: task.summary.goal.slice(0, REQUIREMENT_GOAL_CHARS),
      decisions: task.summary.decisions,
      constraints: task.summary.constraints,
      nonGoals: task.summary.nonGoals,
      openQuestions: task.summary.openQuestions,
      acceptance: task.summary.acceptance,
    },
    reviews: [...reviews],
    nodes: (graph?.nodes ?? []).map((node) => nodeView(task, node, backs)),
    edges: (graph?.edges ?? []).map(({ from, to, kind }) => ({ from, to, kind })),
    archiveFacts,
    followed,
  };
}
