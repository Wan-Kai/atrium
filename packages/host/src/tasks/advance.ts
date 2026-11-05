import { type Draft, emit, freshRun, notify, progress } from "./draft";
import { NODE_SLOTS, activeGraphOf, latestRun, liveRun, placeOf, stateOf, topologicalOrder, upstreamOf } from "./graph";
import { deriveStatus } from "./status";
import { RESUME_HELD } from "./texts";
import type { GraphNode, GraphVersion } from "./types";

/**
 * Ends the task: records when, unlocks its worktree and asks whether to archive it.
 *
 * @remarks
 * Runs once, for `done` and for `cancelled` (SPEC-0006, "加锁", "归档"). The lock was taken at the
 * start; a worktree the task did not make is only unlocked, never offered for archiving.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 */
export function endTask(draft: Draft): void {
  const { task } = draft;
  if (task.endedAt !== null) return;
  task.endedAt = draft.event.at;
  if (task.workspaceState !== "ready") return;
  emit(draft, { kind: "unlock_workspace" });
  if (task.ownsWorkspace) emit(draft, { kind: "ask_archive" });
}

/**
 * The agent nodes occupying the task's slots: running or waiting.
 *
 * @remarks
 * SPEC-0006 counts nodes "running"; a node waiting on a question goes back to running when
 * answered, with no chance to refuse, so waiting nodes keep their slot.
 *
 * @sideEffects none
 * @param draft - The step.
 * @param graph - The graph in force.
 * @returns The agent nodes that are running or waiting.
 */
function busyAgents(draft: Draft, graph: GraphVersion): GraphNode[] {
  return graph.nodes.filter((node) => {
    const state = stateOf(draft.task, node.id);
    return node.kind === "agent" && (state === "running" || state === "waiting");
  });
}

/**
 * Starts one ready agent node if the worktree, exclusivity and slot rules let it.
 *
 * @remarks
 * SPEC-0006, "调度器" 5. A `work` node needs the worktree to itself; any other node keeps out of a
 * worktree where a `work` node is busy. The check is on every busy agent node, not only those known
 * to be in the worktree: a read-only node that began before the worktree existed ran elsewhere, but
 * the run does not record where, so the safe reading is to count it.
 *
 * @sideEffects Changes the draft's task (the node's run, `workspaceState`) and actions.
 * @param draft - The step.
 * @param graph - The graph in force.
 * @param node - A ready agent node.
 */
function tryStart(draft: Draft, graph: GraphVersion, node: GraphNode): void {
  const { task } = draft;
  const wantsWorkspace = placeOf(node) === "workspace";
  if (wantsWorkspace && task.workspaceState !== "ready") {
    if (task.workspaceState === "none") {
      task.workspaceState = "creating";
      emit(draft, { kind: "ensure_workspace" });
    }
    return;
  }
  const busy = busyAgents(draft, graph).filter((other) => other.id !== node.id);
  if (wantsWorkspace || task.workspaceState === "ready") {
    if (node.role === "work" ? busy.length > 0 : busy.some((other) => other.role === "work")) return;
  }
  if (busy.length >= NODE_SLOTS) return;
  const existing = liveRun(task, node.id);
  const at = draft.event.at;
  let attempt: number;
  if (existing !== undefined) {
    attempt = existing.attempt;
    existing.state = "running";
    existing.startedAt = at;
    existing.graph = graph.version;
  } else {
    attempt = latestRun(task, node.id)?.attempt ?? 1;
    task.runs.push(freshRun(task, node.id, attempt, "running", at));
  }
  emit(draft, { kind: "start_node", node: node.id, attempt });
  progress(draft, "node_started", node.id);
}

/**
 * Opens a human node that is ready: it waits for the user.
 *
 * @remarks
 * SPEC-0006, "调度器" 4. A human node has no session; its run goes straight to `waiting`.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param node - A ready human node.
 */
function openHuman(draft: Draft, node: GraphNode): void {
  const { task } = draft;
  const existing = liveRun(task, node.id);
  const run = existing ?? freshRun(task, node.id, latestRun(task, node.id)?.attempt ?? 1, "waiting", draft.event.at);
  run.state = "waiting";
  run.waitingFor = "human";
  run.graph = activeGraphOf(task)?.version ?? run.graph;
  if (existing === undefined) task.runs.push(run);
  notify(draft, { kind: "human", node: node.id });
  progress(draft, "node_waiting", node.id);
}

/**
 * Moves the task forward as far as its rules allow, after an event has been applied.
 *
 * @remarks
 * SPEC-0006, "调度器 · 每次 step 在应用完事件后都做一遍推进": ends a finished task; does nothing for a
 * task that is cancelled, still designing or stopped; otherwise resumes held nodes, opens ready human
 * nodes and starts ready agent nodes in topological order, each decision seeing the ones before it.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 */
export function advance(draft: Draft): void {
  const { task } = draft;
  const status = deriveStatus(task);
  if (status === "done") {
    endTask(draft);
    return;
  }
  const graph = activeGraphOf(task);
  if (graph === undefined || (status !== "running" && status !== "waiting")) return;
  const order = topologicalOrder(graph);
  for (const id of order) {
    const run = liveRun(task, id);
    if (run?.state !== "held") continue;
    run.state = "running";
    emit(draft, { kind: "resume_node", node: id, text: RESUME_HELD });
  }
  for (const id of order) {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (node === undefined || stateOf(task, id) !== "pending") continue;
    if (!upstreamOf(graph, id).every((upstream) => stateOf(task, upstream) === "passed")) continue;
    if (node.kind === "human") openHuman(draft, node);
    else tryStart(draft, graph, node);
  }
}
