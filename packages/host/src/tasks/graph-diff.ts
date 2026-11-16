import type { GraphVersion, Task } from "./types";

/** Which nodes one graph version added, removed and changed against another (SPEC-0006, "T8a 定下的细节"). */
export interface GraphDiff {
  /** The version compared with. */
  readonly from: number;
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

/**
 * The version that was in force before a version took over.
 *
 * @remarks
 * Versions are only ever added, so the history is read from them. While the task is being designed every
 * version was in force in its turn, so it is the one before. After it started, a version was in force only if it
 * was approved (the one `started` approved, or one `graph_approved` did); a version the user refused or another
 * replaced never was, and the designs before the start are not "the version before" for what comes after.
 *
 * @sideEffects none
 * @param task - The task.
 * @param version - The version whose predecessor is wanted.
 * @returns The predecessor, or `undefined` for the first one.
 */
export function previousGraph(task: Task, version: number): GraphVersion | undefined {
  const earlier = task.graphs.filter((graph) => graph.version < version);
  if (task.startedAt === null) return earlier.at(-1);
  return earlier.findLast((graph) => graph.approvedAt !== null);
}

/**
 * The node fields a change to which makes a node "changed".
 *
 * @remarks
 * The whole of the node as the plan states it. `inputs` is a list the model wrote in any order, so it is sorted.
 *
 * @sideEffects none
 * @param node - The node.
 * @returns A string that is the same for nodes that read the same.
 */
function fingerprint(node: GraphVersion["nodes"][number]): string {
  return JSON.stringify({ ...node, inputs: node.inputs === undefined ? undefined : node.inputs.toSorted() });
}

/**
 * The edges that touch a node, as strings that are the same for the same edges.
 *
 * @remarks
 * A node whose neighbours changed is changed for the plan, even if its own fields did not.
 *
 * @sideEffects none
 * @param graph - The graph.
 * @param node - The node.
 * @returns The sorted edges into and out of it.
 */
function edgesAt(graph: GraphVersion, node: string): string {
  return graph.edges
    .filter((edge) => edge.from === node || edge.to === node)
    .map((edge) => `${edge.from}>${edge.to}:${edge.kind}`)
    .toSorted()
    .join(",");
}

/**
 * What a graph version added, removed and changed against another.
 *
 * @remarks
 * A node is added when only `to` has it, removed when only `from` has it, changed when both have it and a field
 * or an edge into or out of it differs. T8b draws the changed ones with a dashed blue frame and the added ones
 * with "新", and the card for a graph waiting for approval lists them.
 *
 * @sideEffects none
 * @param from - The version compared with.
 * @param to - The version.
 * @returns The three lists, in the order of the nodes in the graphs.
 */
export function diffGraphs(from: GraphVersion, to: GraphVersion): GraphDiff {
  const before = new Map(from.nodes.map((node) => [node.id, node]));
  const after = new Map(to.nodes.map((node) => [node.id, node]));
  return {
    from: from.version,
    added: to.nodes.filter((node) => !before.has(node.id)).map((node) => node.id),
    removed: from.nodes.filter((node) => !after.has(node.id)).map((node) => node.id),
    changed: to.nodes
      .filter((node) => {
        const old = before.get(node.id);
        return (
          old !== undefined &&
          (fingerprint(old) !== fingerprint(node) || edgesAt(from, node.id) !== edgesAt(to, node.id))
        );
      })
      .map((node) => node.id),
  };
}
