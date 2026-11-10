import type { GraphEdge, GraphNode, GraphVersion, NodeId, NodePlace, NodeRun, NodeState, Task } from "./types";

/** How many times a send-back may use the same back edge (SPEC-0006, "打回"). */
export const BACK_LIMIT = 2;

/** How many agent nodes of one task may run at once (SPEC-0006, "调度器"). */
export const NODE_SLOTS = 6;

/** The most conflicting files a blocked merge keeps on its node, for the user to see. */
export const MAX_CONFLICT_FILES = 50;

/** The most nodes a graph may have (SPEC-0006, "改图"). */
export const MAX_NODES = 20;

/**
 * The graph version in force.
 *
 * @remarks
 * `activeGraph` is 0 until a graph has been proposed.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The version, or `undefined` before any graph.
 */
export function activeGraphOf(task: Task): GraphVersion | undefined {
  return task.graphs.find((graph) => graph.version === task.activeGraph);
}

/**
 * The sequential edges of a graph.
 *
 * @remarks
 * Readiness, ordering, reach and "no out-edge" all follow sequential edges only; a back edge never
 * makes a node wait for another.
 *
 * @sideEffects none
 * @param graph - The graph.
 * @returns Its `seq` edges.
 */
export function seqEdges(graph: Pick<GraphVersion, "edges">): GraphEdge[] {
  return graph.edges.filter((edge) => edge.kind === "seq");
}

/**
 * The nodes a node waits for.
 *
 * @remarks
 * "所有顺序入边的上游" (SPEC-0006, "调度器" 3).
 *
 * @sideEffects none
 * @param graph - The graph.
 * @param node - The node.
 * @returns The sources of its sequential in-edges.
 */
export function upstreamOf(graph: Pick<GraphVersion, "edges">, node: NodeId): NodeId[] {
  return seqEdges(graph)
    .filter((edge) => edge.to === node)
    .map((edge) => edge.from);
}

/**
 * The nodes that wait for a node.
 *
 * @remarks
 * Used to reset what a send-back reaches.
 *
 * @sideEffects none
 * @param graph - The graph.
 * @param node - The node.
 * @returns The targets of its sequential out-edges.
 */
export function downstreamOf(graph: Pick<GraphVersion, "edges">, node: NodeId): NodeId[] {
  return seqEdges(graph)
    .filter((edge) => edge.from === node)
    .map((edge) => edge.to);
}

/**
 * The nodes in an order where every node comes after all it waits for.
 *
 * @remarks
 * Kahn's algorithm, taking nodes in their listed order when several are free, so the order is the
 * same every time. A cycle, which the validator refuses, leaves its nodes at the end in listed order
 * rather than dropping them.
 *
 * @sideEffects none
 * @param graph - The graph.
 * @returns The node ids.
 */
export function topologicalOrder(graph: Pick<GraphVersion, "nodes" | "edges">): NodeId[] {
  const edges = seqEdges(graph);
  const remaining = new Map(graph.nodes.map((node) => [node.id, edges.filter((e) => e.to === node.id).length]));
  const order: NodeId[] = [];
  const placed = new Set<NodeId>();
  for (;;) {
    const next = graph.nodes.find((node) => !placed.has(node.id) && remaining.get(node.id) === 0);
    if (next === undefined) break;
    placed.add(next.id);
    order.push(next.id);
    for (const edge of edges) if (edge.from === next.id) remaining.set(edge.to, (remaining.get(edge.to) ?? 0) - 1);
  }
  for (const node of graph.nodes) if (!placed.has(node.id)) order.push(node.id);
  return order;
}

/**
 * Every node reachable from a node along sequential edges, itself included.
 *
 * @remarks
 * A send-back resets this whole set, side branches too (SPEC-0006, "打回").
 *
 * @sideEffects none
 * @param graph - The graph.
 * @param start - The node to start from.
 * @returns The reachable ids.
 */
export function reachableFrom(graph: Pick<GraphVersion, "edges">, start: NodeId): Set<NodeId> {
  const reached = new Set<NodeId>([start]);
  const queue = [start];
  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    for (const next of downstreamOf(graph, node)) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

/**
 * The nodes with no sequential out-edge.
 *
 * @remarks
 * The task is done when all of these have passed. Back edges do not count: the closing human node
 * usually has one and must still be an end.
 *
 * @sideEffects none
 * @param graph - The graph.
 * @returns The ids, in listed order.
 */
export function sinksOf(graph: Pick<GraphVersion, "nodes" | "edges">): NodeId[] {
  const edges = seqEdges(graph);
  return graph.nodes.filter((node) => !edges.some((edge) => edge.from === node.id)).map((node) => node.id);
}

/**
 * The latest run of a node: the one with the highest attempt, the last of them if several.
 *
 * @remarks
 * A voided run is still the latest (it only stands for "pending"); skipping it would bring an older
 * passed attempt back to life.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node.
 * @returns The run, or `undefined` if the node never had one.
 */
export function latestRun(task: Task, node: NodeId): NodeRun | undefined {
  let latest: NodeRun | undefined;
  for (const run of task.runs) {
    if (run.node === node && (latest === undefined || run.attempt >= latest.attempt)) latest = run;
  }
  return latest;
}

/**
 * The run of a node at an attempt: the last such run.
 *
 * @remarks
 * Events name the attempt they are about; a voided run and its replacement share one.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node.
 * @param attempt - The attempt.
 * @returns The run, or `undefined`.
 */
export function runAt(task: Task, node: NodeId, attempt: number): NodeRun | undefined {
  return task.runs.findLast((run) => run.node === node && run.attempt === attempt);
}

/**
 * A node's current state: its latest run's, or `pending`.
 *
 * @remarks
 * SPEC-0006, "节点的当前状态从哪里来". A voided run reads as `pending`.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node.
 * @returns The state.
 */
export function stateOf(task: Task, node: NodeId): NodeState {
  const run = latestRun(task, node);
  if (run === undefined || run.void === true) return "pending";
  return run.state;
}

/**
 * The latest run of a node when it counts, that is, not voided.
 *
 * @remarks
 * Most handlers only act on a run that is live.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node.
 * @returns The run, or `undefined` when there is none or it is voided.
 */
export function liveRun(task: Task, node: NodeId): NodeRun | undefined {
  const run = latestRun(task, node);
  return run === undefined || run.void === true ? undefined : run;
}

/**
 * Where an agent node works: its `place`, or by role.
 *
 * @remarks
 * `work` and `check` default to the task's worktree, the others to read-only (SPEC-0006, "数据").
 *
 * @sideEffects none
 * @param node - The node.
 * @returns The place.
 */
export function placeOf(node: GraphNode): NodePlace {
  if (node.place !== undefined) return node.place;
  return node.role === "work" || node.role === "check" ? "workspace" : "readonly";
}

/**
 * The nodes of the graph in force, with their latest states.
 *
 * @remarks
 * Task status and the scheduler read nodes through this, so a node of an old version never counts.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns Each node with its state; empty before any graph.
 */
export function nodeStates(task: Task): { readonly node: GraphNode; readonly state: NodeState }[] {
  const graph = activeGraphOf(task);
  if (graph === undefined) return [];
  return graph.nodes.map((node) => ({ node, state: stateOf(task, node.id) }));
}
