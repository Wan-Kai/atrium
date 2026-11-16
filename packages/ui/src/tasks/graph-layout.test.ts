import { describe, expect, it } from "vitest";
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph } from "./graph-layout";

const seq = (from: string, to: string) => ({ from, to, kind: "seq" as const });
const back = (from: string, to: string) => ({ from, to, kind: "back" as const });

/** The x of the lane a send-back path loops through. */
const laneOf = (path: string): string => /C([\d.]+) /.exec(path)?.[1] ?? "";

describe("layoutGraph (SPEC-0006, 界面 · 任务标签)", () => {
  it("puts each node on the row after everything it follows, so a chain is one node per row", () => {
    const layout = layoutGraph(["N1", "N2", "N3"], [seq("N1", "N2"), seq("N2", "N3")]);

    expect(layout.nodes.map(({ id, layer }) => [id, layer])).toStrictEqual([
      ["N1", 0],
      ["N2", 1],
      ["N3", 2],
    ]);
    const ys = layout.nodes.map((node) => node.y);
    expect(ys[1]! - ys[0]!).toBeGreaterThan(NODE_HEIGHT);
  });

  it("puts a fan-out side by side on one row and joins them on the next, the join below the longest path", () => {
    const layout = layoutGraph(
      ["A", "B", "C", "D", "E"],
      [seq("A", "B"), seq("A", "C"), seq("B", "D"), seq("C", "D"), seq("A", "E"), seq("E", "D")],
    );
    const at = (id: string) => layout.nodes.find((node) => node.id === id)!;

    expect(at("B").layer).toBe(1);
    expect(at("C").layer).toBe(1);
    expect(at("E").layer).toBe(1);
    expect(at("D").layer).toBe(2);
    expect(at("B").y).toBe(at("C").y);
    expect(new Set([at("B").x, at("C").x, at("E").x]).size).toBe(3);
    expect(at("B").x + NODE_WIDTH).toBeLessThan(at("C").x);
  });

  it("centres a narrower row under the widest one", () => {
    const layout = layoutGraph(["A", "B", "C", "D"], [seq("A", "B"), seq("A", "C"), seq("B", "D"), seq("C", "D")]);
    const at = (id: string) => layout.nodes.find((node) => node.id === id)!;

    expect(at("A").x + NODE_WIDTH / 2).toBeCloseTo((at("B").x + at("C").x + NODE_WIDTH) / 2);
    expect(at("D").x).toBe(at("A").x);
  });

  it("orders a row by where its nodes' predecessors are, so edges do not cross for no reason", () => {
    const layout = layoutGraph(["A", "B", "C", "D"], [seq("A", "D"), seq("B", "C")]);
    const at = (id: string) => layout.nodes.find((node) => node.id === id)!;

    expect(at("A").x).toBeLessThan(at("B").x);
    expect(at("D").x).toBeLessThan(at("C").x);
  });

  it("draws an in-order edge from the bottom of one node to the top of the next", () => {
    const layout = layoutGraph(["N1", "N2"], [seq("N1", "N2")]);
    const [one, two] = layout.nodes;

    expect(layout.edges[0]?.path.startsWith(`M${one!.x + NODE_WIDTH / 2} ${one!.y + NODE_HEIGHT} `)).toBe(true);
    expect(layout.edges[0]?.path.endsWith(`${two!.x + NODE_WIDTH / 2} ${two!.y}`)).toBe(true);
    expect(layout.edges[0]?.label).toBeNull();
  });

  it("loops a send-back through the left margin, each in a lane of its own, and makes room for it", () => {
    const plain = layoutGraph(["A", "B", "H"], [seq("A", "B"), seq("B", "H")]);
    const looped = layoutGraph(["A", "B", "H"], [seq("A", "B"), seq("B", "H"), back("H", "A"), back("H", "B")]);
    const [first, second] = looped.edges.filter((edge) => edge.kind === "back");

    expect(looped.width).toBeGreaterThan(plain.width);
    expect(first?.label).not.toBeNull();
    expect(laneOf(first!.path)).not.toBe(laneOf(second!.path));
    expect(Math.min(...looped.nodes.map((node) => node.x))).toBeGreaterThan(40);
  });

  it("ignores edges to nodes it does not have, and ends on a cycle", () => {
    const layout = layoutGraph(["A", "B"], [seq("A", "B"), seq("B", "A"), seq("A", "ghost")]);

    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges.map((edge) => `${edge.from}${edge.to}`)).toStrictEqual(["AB", "BA"]);
  });

  it("lays out the largest graph, twenty nodes, quickly", () => {
    const ids = Array.from({ length: 20 }, (_, index) => `N${index + 1}`);
    const edges = ids.slice(1).map((id, index) => seq(ids[Math.floor(index / 2)]!, id));
    const started = performance.now();
    for (let round = 0; round < 200; round++) layoutGraph(ids, edges);

    expect((performance.now() - started) / 200).toBeLessThan(2);
  });
});
