import { MAX_NODES, activeGraphOf, downstreamOf, latestRun, reachableFrom, seqEdges, stateOf } from "./graph";
import type { GraphEdge, GraphNode, GraphVersion, NodeId, Task } from "./types";

/**
 * What a graph can be refused for (SPEC-0006, "改图"). The first one found goes to the caller as
 * the parameter of `task_graph_invalid`, except `no_project_for_work`, which has its own error code.
 */
export type GraphProblemCode =
  // Structure
  | "too_many_nodes"
  | "duplicate_node_id"
  | "unknown_node"
  | "seq_cycle"
  | "back_edge_not_from_human"
  | "back_edge_not_to_upstream"
  | "no_source"
  | "no_sink"
  // Fields
  | "agent_missing_job"
  | "agent_missing_done"
  | "agent_missing_role"
  | "human_has_agent_field"
  | "merge_not_on_human"
  | "merge_has_seq_out"
  | "merge_without_worktree"
  // Tasks outside any project, and read-only schedule rules
  | "no_project_for_work"
  | "readonly_rule_has_work"
  // After the task has started
  | "node_removed"
  | "node_changed"
  | "locked_in_edge_changed";

/** One reason a graph is refused. */
export interface GraphProblem {
  readonly code: GraphProblemCode;
  readonly node?: NodeId;
}

/** What the rules need to know about the task a graph is for. */
export interface GraphContext {
  /** The task does not belong to a project (SPEC-0006, "不属于项目的任务"). */
  readonly projectless: boolean;
  /** The task is a schedule rule that runs read-only in the local directory. */
  readonly localReadonly: boolean;
  /** The task already started: its runs lock part of the graph. Leave out while designing. */
  readonly started?: Task;
}

/**
 * Serialises a value with its keys sorted, so two equal nodes compare equal whatever their key order.
 *
 * @remarks
 * Nodes come from different sources (the agent's tool call, `task.json`); their key order is not
 * stable.
 *
 * @sideEffects none
 * @param value - A JSON value.
 * @returns Its canonical text.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Whether the sequential edges contain a cycle.
 *
 * @remarks
 * Kahn's algorithm: whatever cannot be taken off is on a cycle or behind one.
 *
 * @sideEffects none
 * @param nodes - The nodes.
 * @param edges - The edges; only `seq` ones count.
 * @returns Whether there is a cycle.
 */
function hasSeqCycle(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): boolean {
  const seq = edges.filter((edge) => edge.kind === "seq");
  const remaining = new Map(nodes.map((node) => [node.id, seq.filter((edge) => edge.to === node.id).length]));
  const free = nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);
  let taken = 0;
  for (let id = free.pop(); id !== undefined; id = free.pop()) {
    taken += 1;
    for (const edge of seq) {
      if (edge.from !== id) continue;
      const left = (remaining.get(edge.to) ?? 0) - 1;
      remaining.set(edge.to, left);
      if (left === 0) free.push(edge.to);
    }
  }
  return taken < nodes.length;
}

/**
 * The structural rules: ids, edges, cycles, ends and size.
 *
 * @remarks
 * SPEC-0006, "改图 · 结构". Sources and sinks count sequential edges only, since a back edge points at
 * the graph's first nodes and leaves its last one.
 *
 * @sideEffects none
 * @param graph - The proposed graph.
 * @returns The problems, in rule order.
 */
function structureProblems(graph: Pick<GraphVersion, "nodes" | "edges">): GraphProblem[] {
  const problems: GraphProblem[] = [];
  if (graph.nodes.length > MAX_NODES) problems.push({ code: "too_many_nodes" });
  const ids = new Set<NodeId>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) problems.push({ code: "duplicate_node_id", node: node.id });
    ids.add(node.id);
  }
  for (const edge of graph.edges) {
    for (const end of [edge.from, edge.to]) if (!ids.has(end)) problems.push({ code: "unknown_node", node: end });
  }
  if (problems.some((problem) => problem.code === "unknown_node")) return problems;
  if (hasSeqCycle(graph.nodes, graph.edges)) problems.push({ code: "seq_cycle" });
  for (const edge of graph.edges) {
    if (edge.kind !== "back") continue;
    if (graph.nodes.find((node) => node.id === edge.from)?.kind !== "human") {
      problems.push({ code: "back_edge_not_from_human", node: edge.from });
    } else if (edge.from === edge.to || !reachableFrom(graph, edge.to).has(edge.from)) {
      problems.push({ code: "back_edge_not_to_upstream", node: edge.from });
    }
  }
  const seq = seqEdges(graph);
  if (!graph.nodes.some((node) => !seq.some((edge) => edge.to === node.id))) problems.push({ code: "no_source" });
  if (!graph.nodes.some((node) => !seq.some((edge) => edge.from === node.id))) problems.push({ code: "no_sink" });
  return problems;
}

/**
 * The field rules of one node.
 *
 * @remarks
 * SPEC-0006, "改图 · 字段". An agent node needs what the contract is built from; a human node has
 * none of the agent-only fields; `merge` is for the last human node of a task that has a worktree.
 *
 * @sideEffects none
 * @param node - The node.
 * @param graph - Its graph.
 * @param worktree - Whether the task can have a worktree.
 * @returns The problems.
 */
function fieldProblems(node: GraphNode, graph: Pick<GraphVersion, "edges">, worktree: boolean): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const at = { node: node.id };
  if (node.kind === "agent") {
    if (node.job.trim() === "") problems.push({ code: "agent_missing_job", ...at });
    if (node.done.length === 0 || node.done.some((line) => line.trim() === "")) {
      problems.push({ code: "agent_missing_done", ...at });
    }
    if (node.role === undefined) problems.push({ code: "agent_missing_role", ...at });
  } else if (node.role !== undefined || node.model !== undefined || node.place !== undefined) {
    problems.push({ code: "human_has_agent_field", ...at });
  }
  if (node.merge === true) {
    if (node.kind !== "human") problems.push({ code: "merge_not_on_human", ...at });
    else if (downstreamOf(graph, node.id).length > 0) problems.push({ code: "merge_has_seq_out", ...at });
    else if (!worktree) problems.push({ code: "merge_without_worktree", ...at });
  }
  return problems;
}

/**
 * The rules for a task outside any project and for a read-only schedule rule.
 *
 * @remarks
 * SPEC-0006, "改图 · 不属于项目的任务" and "定时": no `work` or `check`, nothing placed in a worktree;
 * a read-only rule has no `work` node.
 *
 * @sideEffects none
 * @param nodes - The nodes.
 * @param context - The task's kind.
 * @returns The problems.
 */
function placeProblems(nodes: readonly GraphNode[], context: GraphContext): GraphProblem[] {
  const problems: GraphProblem[] = [];
  for (const node of nodes) {
    if (node.kind !== "agent") continue;
    if (context.projectless && (node.role === "work" || node.role === "check" || node.place === "workspace")) {
      problems.push({ code: "no_project_for_work", node: node.id });
    }
    if (context.localReadonly && node.role === "work") problems.push({ code: "readonly_rule_has_work", node: node.id });
  }
  return problems;
}

/**
 * The in-edges of a node as a comparable set.
 *
 * @remarks
 * Both kinds count: a back edge into a node is as much a change to it.
 *
 * @sideEffects none
 * @param graph - The graph.
 * @param node - The node.
 * @returns Sorted `from>kind` strings.
 */
function inEdgesOf(graph: Pick<GraphVersion, "edges">, node: NodeId): string[] {
  return graph.edges
    .filter((edge) => edge.to === node)
    .map((edge) => `${edge.from}>${edge.kind}`)
    .toSorted();
}

/**
 * The rules for a graph changed after the task started.
 *
 * @remarks
 * SPEC-0006, "改图 · 启动后": a node with a run stays and keeps its fields; the in-edges of a node
 * that is running, waiting, held or stopped stay as they are. Two additions, both to keep the status
 * honest: a passed node's in-edges are locked too (a new unfinished upstream would leave a "passed"
 * node behind it), and a waiting human node's are not (the merge-conflict flow adds a node in front of
 * it; the approval then voids that human run).
 *
 * @sideEffects none
 * @param graph - The proposed graph.
 * @param task - The task, with its runs and the graph in force.
 * @returns The problems.
 */
function startedProblems(graph: Pick<GraphVersion, "nodes" | "edges">, task: Task): GraphProblem[] {
  const current = activeGraphOf(task);
  if (current === undefined) return [];
  const problems: GraphProblem[] = [];
  for (const old of current.nodes) {
    if (latestRun(task, old.id) === undefined) continue;
    const next = graph.nodes.find((node) => node.id === old.id);
    if (next === undefined) {
      problems.push({ code: "node_removed", node: old.id });
      continue;
    }
    if (canonical(next) !== canonical(old)) problems.push({ code: "node_changed", node: old.id });
    const state = stateOf(task, old.id);
    const waitingHuman = state === "waiting" && old.kind === "human" && latestRun(task, old.id)?.merging !== true;
    const locked = state === "running" || state === "held" || state === "stopped" || state === "passed";
    if (
      (locked || (state === "waiting" && !waitingHuman)) &&
      inEdgesOf(graph, old.id).join() !== inEdgesOf(current, old.id).join()
    ) {
      problems.push({ code: "locked_in_edge_changed", node: old.id });
    }
  }
  return problems;
}

/**
 * Checks a graph against every rule of SPEC-0006, "改图".
 *
 * @remarks
 * Pure, and used twice: when the agent proposes a graph (the tool returns the problems so the agent
 * fixes them) and when the user confirms the start. Returns all problems, not only the first, so a
 * test can see each rule fire; the caller reports the first.
 *
 * @sideEffects none
 * @param graph - The nodes and edges to check.
 * @param context - Whether the task has a project, whether it is a read-only rule, and, once started, the task.
 * @returns The problems; empty when the graph is acceptable.
 */
export function validateGraph(graph: Pick<GraphVersion, "nodes" | "edges">, context: GraphContext): GraphProblem[] {
  const structure = structureProblems(graph);
  if (structure.some((problem) => problem.code === "unknown_node" || problem.code === "duplicate_node_id")) {
    return structure;
  }
  const worktree = !context.projectless && !context.localReadonly;
  return [
    ...structure,
    ...graph.nodes.flatMap((node) => fieldProblems(node, graph, worktree)),
    ...placeProblems(graph.nodes, context),
    ...(context.started === undefined ? [] : startedProblems(graph, context.started)),
  ];
}
