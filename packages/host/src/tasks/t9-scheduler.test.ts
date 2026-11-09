import { describe, expect, it } from "vitest";
import { Sim, agent, edges, kinds, newTask, runOf } from "./test-support";
import { TaskEvent } from "./types";

/** A task of two explore nodes in a row, started. */
function started(): Sim {
  const sim = new Sim(newTask([agent("N1"), agent("N2")], edges(["N1", "N2"])));
  sim.send({ type: "started" });
  return sim;
}

/** What a node writes when it asks for a graph change. */
const REQUEST = { reason: "A check step is missing.", suggestion: "Add N3 after N2." };

describe("a graph change the node asked for is kept on its run (SPEC-0006, T9)", () => {
  it("keeps the reason and suggestion the event carries, and clears them when the wait ends", () => {
    const sim = started();

    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change", request: REQUEST });

    expect(runOf(sim.task, "N1", 1).graphRequest).toStrictEqual(REQUEST);
    sim.send({
      type: "graph_proposed",
      author: "agent",
      note: "v2",
      nodes: [agent("N1"), agent("N2")],
      edges: edges(["N1", "N2"]),
    });
    sim.send({ type: "graph_rejected" });
    expect(runOf(sim.task, "N1", 1).state).toBe("running");
    expect(runOf(sim.task, "N1", 1).graphRequest).toBeUndefined();
  });

  it("clears them when the node fails while it waits", () => {
    const sim = started();
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change", request: REQUEST });

    sim.send({ type: "node_failed", node: "N1", attempt: 1, reason: "crashed" });

    expect(runOf(sim.task, "N1", 1).graphRequest).toBeUndefined();
  });

  it("keeps nothing for a question, or for a graph change without the text", () => {
    const sim = started();
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
    expect(runOf(sim.task, "N1", 1).graphRequest).toBeUndefined();
    sim.send({ type: "node_resumed", node: "N1", attempt: 1 });

    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change" });

    expect(runOf(sim.task, "N1", 1).graphRequest).toBeUndefined();
    // Not a key with nothing in it either: the snapshot would carry it.
    expect("graphRequest" in runOf(sim.task, "N1", 1)).toBe(false);
  });

  it("keeps a node_done that is pending while the node waits for an answer, and drops it for a graph change", () => {
    const asking = started();
    asking.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "kept" });
    asking.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
    const changing = started();
    changing.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "dropped" });
    changing.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change", request: REQUEST });

    expect(runOf(asking.task, "N1", 1).pendingDone).toStrictEqual({ ok: true, summary: "kept" });
    expect(runOf(changing.task, "N1", 1).pendingDone).toBeNull();
  });

  it("is part of the event's shape, so it reaches events.jsonl", () => {
    const event = {
      seq: 3,
      at: 1,
      type: "node_waiting",
      node: "N1",
      attempt: 1,
      waitingFor: "graph_change",
      request: REQUEST,
    };

    expect(TaskEvent.parse(event)).toStrictEqual(event);
    expect(() => TaskEvent.parse({ ...event, request: { reason: "only" } })).toThrow("suggestion");
  });
});

describe("host_restarted wakes the task conversation again for a graph change nobody proposed yet", () => {
  it("wakes once when there is no pending graph, and not when one is waiting for the user", () => {
    const sim = started();
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change", request: REQUEST });

    expect(kinds(sim.send({ type: "host_restarted" }))).toStrictEqual(["wake_task_conversation"]);

    sim.send({
      type: "graph_proposed",
      author: "agent",
      note: "v2",
      nodes: [agent("N1"), agent("N2"), agent("N3")],
      edges: edges(["N1", "N2"], ["N2", "N3"]),
    });
    expect(kinds(sim.send({ type: "host_restarted" }))).toStrictEqual([]);
    expect(runOf(sim.task, "N1", 1)).toMatchObject({ state: "waiting", waitingFor: "graph_change" });
  });
});
