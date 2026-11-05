import {
  TASK_TEXT_LIMIT,
  type TaskArchiveFacts,
  type TaskAttention,
  type TaskNode,
  type TaskSummary,
  type TaskView,
} from "@atrium/protocol";
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
  };
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
 * A task as the board shows it: the graph in force and its nodes.
 *
 * @remarks
 * The archive facts are not part of the task; the caller works them out (git) while the question is open and
 * passes them in.
 *
 * @sideEffects none
 * @param task - The task.
 * @param archiveFacts - The facts of the archive question, or `null`.
 * @returns The view.
 */
export function viewOf(task: Task, archiveFacts: TaskArchiveFacts | null): TaskView {
  const graph = activeGraphOf(task);
  const backs = (graph?.edges ?? []).filter((edge) => edge.kind === "back");
  return {
    ...summaryOf(task),
    taskSessionId: task.taskSessionId,
    graphVersion: task.activeGraph,
    pendingGraph: task.pendingGraph !== null,
    nodes: (graph?.nodes ?? []).map((node) => nodeView(task, node, backs)),
    edges: (graph?.edges ?? []).map(({ from, to, kind }) => ({ from, to, kind })),
    archiveFacts,
  };
}
