import { describe, expect, it } from "vitest";
import { diffGraphs, previousGraph } from "./graph-diff";
import { agent, edges, human, newTask } from "./test-support";
import type { GraphVersion, Task } from "./types";

/** A graph version. */
function version(
  number: number,
  nodes: GraphVersion["nodes"],
  graphEdges: GraphVersion["edges"],
  approvedAt: number | null,
): GraphVersion {
  return { version: number, nodes, edges: graphEdges, author: "agent", note: "", createdAt: number, approvedAt };
}

describe("what one graph version changed against another (T8a)", () => {
  it("names the nodes added, removed and changed, in the order of the graphs", () => {
    const from = version(
      1,
      [agent("N1"), agent("N2"), agent("N3"), agent("N4")],
      edges(["N1", "N2"], ["N2", "N3"], ["N3", "N4"]),
      1,
    );
    const to = version(
      2,
      [agent("N1"), agent("N2", "explore", { job: "do it better" }), agent("N3"), agent("N5")],
      edges(["N1", "N2"], ["N2", "N3"], ["N3", "N5"]),
      null,
    );

    expect(diffGraphs(from, to)).toStrictEqual({ from: 1, added: ["N5"], removed: ["N4"], changed: ["N2", "N3"] });
  });

  it("calls a node changed by any field, an edge into or out of it, or the kind of an edge", () => {
    const base = version(1, [agent("N1"), agent("N2"), human("H")], edges(["N1", "N2"], ["N2", "H"]), 1);
    const changed = (to: GraphVersion) => diffGraphs(base, to).changed;
    const same = () => version(2, [agent("N1"), agent("N2"), human("H")], edges(["N1", "N2"], ["N2", "H"]), null);

    expect(changed(same())).toStrictEqual([]);
    expect(changed({ ...same(), nodes: [agent("N1", "work"), agent("N2"), human("H")] })).toStrictEqual(["N1"]);
    expect(
      changed({ ...same(), nodes: [agent("N1"), agent("N2", "explore", { name: "renamed" }), human("H")] }),
    ).toStrictEqual(["N2"]);
    expect(
      changed({ ...same(), nodes: [agent("N1"), agent("N2", "explore", { place: "readonly" }), human("H")] }),
    ).toStrictEqual(["N2"]);
    expect(changed({ ...same(), nodes: [agent("N1"), agent("N2"), human("H", { merge: true })] })).toStrictEqual(["H"]);
    expect(
      changed({
        ...same(),
        nodes: [agent("N1"), agent("N2", "explore", { model: { providerId: "p", modelId: "m" } }), human("H")],
      }),
    ).toStrictEqual(["N2"]);
    // An edge added between two nodes marks both ends; one of another kind does too.
    expect(changed({ ...same(), edges: edges(["N1", "N2"], ["N2", "H"], ["N1", "H"]) })).toStrictEqual(["N1", "H"]);
    expect(changed({ ...same(), edges: edges(["N1", "N2"], ["N2", "H"], ["H", "N1", "back"]) })).toStrictEqual([
      "N1",
      "H",
    ]);
  });

  it("does not take the order of a node's inputs, or of the edges, for a change", () => {
    const from = version(
      1,
      [agent("N1"), agent("N2"), agent("N3", "explore", { inputs: ["N1", "N2"] })],
      edges(["N1", "N3"], ["N2", "N3"]),
      1,
    );
    const to = version(
      2,
      [agent("N1"), agent("N2"), agent("N3", "explore", { inputs: ["N2", "N1"] })],
      edges(["N2", "N3"], ["N1", "N3"]),
      null,
    );

    expect(diffGraphs(from, to).changed).toStrictEqual([]);
    const without = version(2, [agent("N1"), agent("N2"), agent("N3")], edges(["N1", "N3"], ["N2", "N3"]), null);
    expect(diffGraphs(from, without).changed).toStrictEqual(["N3"]);
  });
});

/** A task with the versions given. */
function taskOf(versions: GraphVersion[], startedAt: number | null): Task {
  return { ...newTask([], []), graphs: versions, startedAt };
}

/** A one-node version. */
const v = (number: number, approvedAt: number | null) => version(number, [agent("N1")], [], approvedAt);

describe("the version that was in force before another (T8a)", () => {
  it("is the one before while the task is being designed", () => {
    const task = taskOf([v(1, null), v(2, null), v(3, null)], null);

    expect(previousGraph(task, 3)?.version).toBe(2);
    expect(previousGraph(task, 2)?.version).toBe(1);
    expect(previousGraph(task, 1)).toBeUndefined();
  });

  it("is the latest approved one after the start, skipping what was refused or replaced and the designs before", () => {
    // v1 and v2 were designs (v2 approved by the start), v3 was refused, v4 replaced v3's place and was approved.
    const task = taskOf([v(1, null), v(2, 10), v(3, null), v(4, 30), v(5, null)], 10);

    expect(previousGraph(task, 5)?.version).toBe(4);
    expect(previousGraph(task, 4)?.version).toBe(2);
    expect(previousGraph(task, 2)).toBeUndefined();
  });
});
