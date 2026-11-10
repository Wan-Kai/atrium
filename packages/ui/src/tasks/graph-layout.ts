import type { TaskEdge } from "@atrium/protocol";

/** A node's box, and the gaps between boxes, in pixels. */
export const NODE_WIDTH = 144;
export const NODE_HEIGHT = 62;
const GAP_X = 18;
const GAP_Y = 34;
/** The margin around the graph, and the room on the left a send-back edge loops through. */
const PAD = 16;
const LANE = 30;

/** Where a node is drawn, from the graph's top-left corner. */
interface PlacedNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** The row it is on: 0 for the first nodes. */
  readonly layer: number;
}

/** An edge with the SVG path that draws it. */
interface PlacedEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "seq" | "back";
  readonly path: string;
  /** Where a send-back's label sits. */
  readonly label: { readonly x: number; readonly y: number } | null;
}

/** The graph's layout. */
export interface GraphLayout {
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly PlacedEdge[];
  readonly width: number;
  readonly height: number;
}

/**
 * Puts each node on a row: after everything it waits for.
 *
 * @remarks
 * Longest path from the first nodes along the in-order edges; send-back edges do not count, they go the other
 * way. A cycle, which a valid graph does not have, is cut where it closes, so a layout always ends.
 *
 * @sideEffects none
 * @param ids - The nodes, in graph order.
 * @param edges - The graph's edges.
 * @returns The row of each node.
 */
function layersOf(ids: readonly string[], edges: readonly TaskEdge[]): Map<string, number> {
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const seq = edges.filter((edge) => edge.kind === "seq" && layer.has(edge.from) && layer.has(edge.to));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const { from, to } of seq) {
      const wanted = (layer.get(from) ?? 0) + 1;
      if (wanted > (layer.get(to) ?? 0) && wanted < ids.length) {
        layer.set(to, wanted);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return layer;
}

/**
 * Where a node would stand in its row to sit under what it follows: the average column of its predecessors.
 *
 * @remarks
 * A node that follows nothing placed keeps its place in the graph's order, so the sort is stable for it.
 *
 * @sideEffects none
 * @param id - The node.
 * @param ids - The nodes, in graph order.
 * @param edges - The graph's edges.
 * @param column - The column of each node of the rows above.
 * @returns The average.
 */
function meanColumn(
  id: string,
  ids: readonly string[],
  edges: readonly TaskEdge[],
  column: ReadonlyMap<string, number>,
): number {
  const known = edges
    .filter((edge) => edge.kind === "seq" && edge.to === id)
    .map((edge) => column.get(edge.from))
    .filter((value): value is number => value !== undefined);
  return known.length === 0 ? ids.indexOf(id) : known.reduce((sum, value) => sum + value, 0) / known.length;
}

/**
 * Lays a task's graph out, top to bottom (设计稿第 4、5 屏).
 *
 * @remarks
 * Rows by `layersOf`; within a row the nodes keep graph order, then are ordered once by the average place of what
 * they follow, so edges cross less. Rows are centred. An in-order edge leaves the middle of a node's bottom and
 * enters the middle of the next's top as a soft curve; a send-back edge leaves a human node's left side, loops
 * through the margin on the left, and enters the left side of the node it sends back to, each in a lane of its
 * own. Pure and linear in nodes and edges, so twenty nodes lay out in microseconds.
 *
 * @sideEffects none
 * @param ids - The nodes' ids, in graph order.
 * @param edges - The graph's edges.
 * @returns The layout.
 */
export function layoutGraph(ids: readonly string[], edges: readonly TaskEdge[]): GraphLayout {
  const layer = layersOf(ids, edges);
  const rows: string[][] = [];
  for (const id of ids) (rows[layer.get(id) ?? 0] ??= []).push(id);
  const column = new Map<string, number>();
  rows.forEach((row, index) => {
    if (index > 0) {
      row.sort(
        (a, b) =>
          meanColumn(a, ids, edges, column) - meanColumn(b, ids, edges, column) || ids.indexOf(a) - ids.indexOf(b),
      );
    }
    row.forEach((id, at) => column.set(id, at));
  });
  const backs = edges.filter((edge) => edge.kind === "back" && layer.has(edge.from) && layer.has(edge.to));
  const left = PAD + (backs.length > 0 ? LANE + 8 * (backs.length - 1) : 0);
  const widest = Math.max(1, ...rows.map((row) => row?.length ?? 0));
  const span = widest * NODE_WIDTH + (widest - 1) * GAP_X;
  const placed = new Map<string, PlacedNode>();
  rows.forEach((row, index) => {
    const width = row.length * NODE_WIDTH + (row.length - 1) * GAP_X;
    row.forEach((id, at) =>
      placed.set(id, {
        id,
        layer: index,
        x: left + (span - width) / 2 + at * (NODE_WIDTH + GAP_X),
        y: PAD + index * (NODE_HEIGHT + GAP_Y),
      }),
    );
  });
  const placedEdges: PlacedEdge[] = [];
  let lane = 0;
  for (const edge of edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (edge.kind === "seq") {
      const x1 = from.x + NODE_WIDTH / 2;
      const y1 = from.y + NODE_HEIGHT;
      const x2 = to.x + NODE_WIDTH / 2;
      const y2 = to.y;
      const bend = Math.max(12, (y2 - y1) / 2);
      placedEdges.push({
        ...edge,
        path: `M${x1} ${y1} C${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`,
        label: null,
      });
    } else {
      const out = PAD + LANE - 8 * lane;
      lane += 1;
      const y1 = from.y + NODE_HEIGHT / 2;
      const y2 = to.y + NODE_HEIGHT / 2;
      placedEdges.push({
        ...edge,
        path: `M${from.x} ${y1} C${out} ${y1}, ${out} ${y2}, ${to.x} ${y2}`,
        label: { x: out - 4, y: (y1 + y2) / 2 },
      });
    }
  }
  return {
    nodes: [...placed.values()],
    edges: placedEdges,
    width: left + span + PAD,
    height: PAD * 2 + rows.length * NODE_HEIGHT + Math.max(0, rows.length - 1) * GAP_Y,
  };
}
