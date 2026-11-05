import { describe, expect, it } from "vitest";
import { type GraphContext, type GraphProblemCode, validateGraph } from "./graph-validator";
import { Sim, agent, edges, human, newTask } from "./test-support";
import type { GraphEdge, GraphNode, Task } from "./types";

const project: GraphContext = { projectless: false, localReadonly: false };

/** The problem codes of a graph. */
function codes(nodes: GraphNode[], graphEdges: GraphEdge[], context: GraphContext = project): GraphProblemCode[] {
  return validateGraph({ nodes, edges: graphEdges }, context).map((problem) => problem.code);
}

/** `count` agent nodes with no edges. */
function manyNodes(count: number): GraphNode[] {
  return Array.from({ length: count }, (_, i) => agent(`N${i + 1}`));
}

/** A running task on N1 -> N2, N1 passed, N2 running. */
function runningTask(): Task {
  const sim = new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], edges(["N1", "N2"], ["N2", "N3"])));
  sim.send({ type: "started" });
  sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "s" });
  sim.send({ type: "node_settled", node: "N1", attempt: 1 });
  return sim.task;
}

describe("validateGraph: structure", () => {
  it("accepts a plain chain", () => {
    expect(codes([agent("N1"), agent("N2")], edges(["N1", "N2"]))).toStrictEqual([]);
  });

  it("accepts 20 nodes and refuses 21", () => {
    expect(codes(manyNodes(20), [])).toStrictEqual([]);
    expect(codes(manyNodes(21), [])).toStrictEqual(["too_many_nodes"]);
  });

  it("refuses a repeated node id", () => {
    expect(codes([agent("N1"), agent("N1")], [])).toStrictEqual(["duplicate_node_id"]);
  });

  it("refuses an edge to a node that is not there, from either end", () => {
    expect(codes([agent("N1")], edges(["N1", "N2"]))).toStrictEqual(["unknown_node"]);
    expect(codes([agent("N1")], edges(["N0", "N1"]))).toStrictEqual(["unknown_node"]);
  });

  it("refuses a cycle of sequential edges, a self-loop included", () => {
    expect(codes([agent("N1"), agent("N2"), agent("N3")], edges(["N1", "N2"], ["N2", "N3"], ["N3", "N1"]))).toContain(
      "seq_cycle",
    );
    expect(codes([agent("N1"), agent("N2")], edges(["N1", "N2"], ["N2", "N2"]))).toContain("seq_cycle");
  });

  it("accepts a diamond", () => {
    const nodes = [agent("N1"), agent("N2"), agent("N3"), agent("N4")];
    expect(codes(nodes, edges(["N1", "N2"], ["N1", "N3"], ["N2", "N4"], ["N3", "N4"]))).toStrictEqual([]);
  });

  it("accepts a back edge from a human node to an ancestor, and the human node still counts as an end", () => {
    const nodes = [agent("N1"), agent("N2"), human("H1")];
    expect(codes(nodes, edges(["N1", "N2"], ["N2", "H1"], ["H1", "N1", "back"], ["H1", "N2", "back"]))).toStrictEqual(
      [],
    );
  });

  it("refuses a back edge from an agent node", () => {
    expect(codes([agent("N1"), agent("N2")], edges(["N1", "N2"], ["N2", "N1", "back"]))).toStrictEqual([
      "back_edge_not_from_human",
    ]);
  });

  it("refuses a back edge to a node that is not an ancestor, or to itself", () => {
    const nodes = [agent("N1"), agent("N2"), human("H1")];
    expect(codes(nodes, edges(["N1", "H1"], ["H1", "N2", "back"]))).toStrictEqual(["back_edge_not_to_upstream"]);
    expect(codes(nodes, edges(["N1", "H1"], ["H1", "H1", "back"]))).toStrictEqual(["back_edge_not_to_upstream"]);
    expect(codes([agent("N1"), human("H1")], edges(["H1", "N1"], ["H1", "N1", "back"]))).toContain(
      "back_edge_not_to_upstream",
    );
  });

  it("refuses a graph with no node to start from, or none to end at", () => {
    expect(codes([], [])).toStrictEqual(["no_source", "no_sink"]);
  });
});

describe("validateGraph: fields", () => {
  it("refuses an agent node without a job, without done lines or with an empty one, and without a role", () => {
    expect(codes([agent("N1", "explore", { job: "  " })], [])).toStrictEqual(["agent_missing_job"]);
    expect(codes([agent("N1", "explore", { done: [] })], [])).toStrictEqual(["agent_missing_done"]);
    expect(codes([agent("N1", "explore", { done: ["ok", " "] })], [])).toStrictEqual(["agent_missing_done"]);
    const { role: _role, ...noRole } = agent("N1");
    expect(codes([noRole], [])).toStrictEqual(["agent_missing_role"]);
  });

  it("accepts a human node with none of the agent fields, and refuses one with any", () => {
    expect(codes([agent("N1"), human("H1")], edges(["N1", "H1"]))).toStrictEqual([]);
    for (const extra of [
      { role: "work" },
      { model: { providerId: "p", modelId: "m" } },
      { place: "readonly" },
    ] as const) {
      expect(codes([agent("N1"), human("H1", extra)], edges(["N1", "H1"]))).toStrictEqual(["human_has_agent_field"]);
    }
  });

  it("accepts `merge` on the last human node of a task with a worktree", () => {
    expect(codes([agent("N1"), human("H1", { merge: true })], edges(["N1", "H1"]))).toStrictEqual([]);
  });

  it("refuses `merge` on an agent node, on a human node with an out-edge, and without a worktree", () => {
    expect(codes([agent("N1", "explore", { merge: true })], [])).toStrictEqual(["merge_not_on_human"]);
    expect(codes([human("H1", { merge: true }), agent("N2")], edges(["H1", "N2"]))).toStrictEqual([
      "merge_has_seq_out",
    ]);
    const nodes = [agent("N1"), human("H1", { merge: true })];
    expect(codes(nodes, edges(["N1", "H1"]), { projectless: true, localReadonly: false })).toContain(
      "merge_without_worktree",
    );
    expect(codes(nodes, edges(["N1", "H1"]), { projectless: false, localReadonly: true })).toStrictEqual([
      "merge_without_worktree",
    ]);
  });

  it("accepts a human node with a back edge and `merge`", () => {
    const nodes = [agent("N1"), human("H1", { merge: true })];
    expect(codes(nodes, edges(["N1", "H1"], ["H1", "N1", "back"]))).toStrictEqual([]);
  });
});

describe("validateGraph: tasks outside a project and read-only rules", () => {
  const projectless: GraphContext = { projectless: true, localReadonly: false };

  it("accepts read-only roles for a task outside any project", () => {
    expect(
      codes(
        [agent("N1", "explore"), agent("N2", "advise"), human("H1")],
        edges(["N1", "N2"], ["N2", "H1"]),
        projectless,
      ),
    ).toStrictEqual([]);
  });

  it("refuses work, check and a worktree place for a task outside any project", () => {
    expect(codes([agent("N1", "work")], [], projectless)).toStrictEqual(["no_project_for_work"]);
    expect(codes([agent("N1", "check")], [], projectless)).toStrictEqual(["no_project_for_work"]);
    expect(codes([agent("N1", "explore", { place: "workspace" })], [], projectless)).toStrictEqual([
      "no_project_for_work",
    ]);
  });

  it("refuses a work node in a read-only schedule rule, and lets check through", () => {
    const readonlyRule: GraphContext = { projectless: false, localReadonly: true };
    expect(codes([agent("N1", "work")], [], readonlyRule)).toStrictEqual(["readonly_rule_has_work"]);
    expect(codes([agent("N1", "check")], [], readonlyRule)).toStrictEqual([]);
  });
});

describe("validateGraph: after the task started", () => {
  it("accepts a change that only touches nodes with no run", () => {
    const task = runningTask();
    const nodes = [agent("N1"), agent("N2"), agent("N4"), agent("N3", "explore", { job: "changed" })];
    expect(codes(nodes, edges(["N1", "N2"], ["N2", "N4"], ["N4", "N3"]), { ...project, started: task })).toStrictEqual(
      [],
    );
  });

  it("refuses removing a node that has a run, and changing its fields", () => {
    const task = runningTask();
    expect(codes([agent("N1"), agent("N3")], edges(["N1", "N3"]), { ...project, started: task })).toStrictEqual([
      "node_removed",
    ]);
    const changed = [agent("N1", "explore", { job: "other" }), agent("N2"), agent("N3")];
    expect(codes(changed, edges(["N1", "N2"], ["N2", "N3"]), { ...project, started: task })).toStrictEqual([
      "node_changed",
    ]);
  });

  it("is not fooled by the order of a node's keys", () => {
    const task = runningTask();
    const reordered: GraphNode = {
      role: "explore",
      done: ["N1 done"],
      job: "do N1",
      kind: "agent",
      name: "node N1",
      id: "N1",
    };
    expect(
      codes([reordered, agent("N2"), agent("N3")], edges(["N1", "N2"], ["N2", "N3"]), { ...project, started: task }),
    ).toStrictEqual([]);
  });

  it("refuses changing the in-edges of a running node", () => {
    const task = runningTask();
    const next = codes(
      [agent("N1"), agent("N2"), agent("N3"), agent("N4")],
      edges(["N1", "N2"], ["N4", "N2"], ["N2", "N3"]),
      {
        ...project,
        started: task,
      },
    );
    expect(next).toStrictEqual(["locked_in_edge_changed"]);
  });

  it("refuses changing the in-edges of a held, stopped, waiting or passed node", () => {
    for (const setup of [
      (sim: Sim) => sim.send({ type: "node_held", node: "N2", attempt: 1 }),
      (sim: Sim) => sim.send({ type: "node_stopped", node: "N2", attempt: 1 }),
      (sim: Sim) => sim.send({ type: "node_waiting", node: "N2", attempt: 1, waitingFor: "question" }),
      (sim: Sim) => sim.send({ type: "paused" }),
    ]) {
      const sim = new Sim(runningTask());
      setup(sim);
      const next = codes(
        [agent("N1"), agent("N2"), agent("N3"), agent("N4")],
        edges(["N1", "N2"], ["N4", "N2"], ["N2", "N3"]),
        {
          ...project,
          started: sim.task,
        },
      );
      expect(next).toContain("locked_in_edge_changed");
    }
    // N1 passed: a new upstream for it is refused too.
    const passed = codes(
      [agent("N1"), agent("N2"), agent("N3"), agent("N0")],
      edges(["N0", "N1"], ["N1", "N2"], ["N2", "N3"]),
      {
        ...project,
        started: runningTask(),
      },
    );
    expect(passed).toStrictEqual(["locked_in_edge_changed"]);
  });

  it("lets a node with no run get new in-edges, and a node with a run get new out-edges", () => {
    const task = runningTask();
    const next = codes(
      [agent("N1"), agent("N2"), agent("N3"), agent("N4")],
      edges(["N1", "N2"], ["N2", "N3"], ["N1", "N4"], ["N4", "N3"]),
      {
        ...project,
        started: task,
      },
    );
    expect(next).toStrictEqual([]);
  });

  it("lets a waiting human node gain an upstream (the merge-conflict flow), but not one that is merging", () => {
    const sim = new Sim(
      newTask([agent("N1"), human("H1", { merge: true })], edges(["N1", "H1"]), { workspaceState: "ready" }),
    );
    sim.send({ type: "started" });
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "s" });
    sim.send({ type: "node_settled", node: "N1", attempt: 1 });
    const nodes = [agent("N1"), agent("N2", "work"), human("H1", { merge: true })];
    const withNew = edges(["N1", "N2"], ["N2", "H1"]);
    expect(codes(nodes, withNew, { ...project, started: sim.task })).toStrictEqual([]);
    sim.send({ type: "human_passed", node: "H1" });
    expect(codes(nodes, withNew, { ...project, started: sim.task })).toStrictEqual(["locked_in_edge_changed"]);
  });

  it("checks nothing against runs while the task is still designing", () => {
    expect(codes([agent("N9")], [], project)).toStrictEqual([]);
  });

  it("reports the node a problem is about", () => {
    const problems = validateGraph({ nodes: [agent("N1", "explore", { job: "" })], edges: [] }, project);
    expect(problems).toStrictEqual([{ code: "agent_missing_job", node: "N1" }]);
  });
});
