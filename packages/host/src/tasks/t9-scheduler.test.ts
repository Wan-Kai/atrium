import { describe, expect, it } from "vitest";
import { Sim, agent, edges, kinds, newTask, runOf } from "./test-support";
import { RESUME_HELD, RESUME_QUESTION_VOID, RESUME_RESTARTED } from "./texts";
import { type Action, NodeRun, TaskEvent } from "./types";

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

/** The texts of the `resume_node` actions among some actions. */
function resumeTexts(actions: readonly Action[]): string[] {
  return actions.flatMap((action) => (action.kind === "resume_node" ? [action.text] : []));
}

describe("host_restarted wakes the task conversation once (SPEC-0006, T9 / T10 审查后用户定)", () => {
  it("emits one wake for several nodes waiting for a graph change, not one for each", () => {
    const sim = new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], []));
    sim.send({ type: "started" });
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change", request: REQUEST });
    sim.send({ type: "node_waiting", node: "N2", attempt: 1, waitingFor: "graph_change", request: REQUEST });
    sim.send({ type: "node_waiting", node: "N3", attempt: 1, waitingFor: "graph_change", request: REQUEST });

    expect(kinds(sim.send({ type: "host_restarted" }))).toStrictEqual(["wake_task_conversation"]);
  });
});

/** Two nodes in parallel: N1 asking a question, N2 mid-turn; N2 then fails, so the task is held back. */
function heldBackByFailure(): Sim {
  const sim = new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], []));
  sim.send({ type: "started" });
  sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
  sim.send({ type: "node_failed", node: "N3", attempt: 1, reason: "crashed" });
  return sim;
}

describe("a task held back at the restart is told what happened when its nodes are really resumed (SPEC-0006, T9 / T10 审查后用户定)", () => {
  it("holds a running node and a node that was asking, sending nothing, and remembers per node what was cut off and what was voided", () => {
    const sim = heldBackByFailure();

    expect(resumeTexts(sim.send({ type: "host_restarted" }))).toStrictEqual([]);

    expect(runOf(sim.task, "N1", 1)).toMatchObject({ state: "held", afterRestart: { questionVoid: true } });
    expect(runOf(sim.task, "N2", 1)).toMatchObject({ state: "held", afterRestart: { cutOff: true } });
    expect("afterRestart" in runOf(sim.task, "N3", 1)).toBe(false);
  });

  it("sends the held line and those sentences when the node is really resumed, and only then", () => {
    const sim = new Sim(newTask([agent("N1"), agent("N2")], []));
    sim.send({ type: "started" });
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
    sim.send({ type: "paused" });
    sim.send({ type: "host_restarted" });
    // Still paused: nothing is sent, and nothing is forgotten.
    expect(resumeTexts(sim.send({ type: "host_restarted" }))).toStrictEqual([]);
    expect(runOf(sim.task, "N2", 1).afterRestart).toStrictEqual({ cutOff: true });
    expect(runOf(sim.task, "N1", 1).afterRestart).toStrictEqual({ questionVoid: true });

    const texts = resumeTexts(sim.send({ type: "resumed" }));

    expect(texts).toHaveLength(2);
    expect(texts).toContain(`${RESUME_HELD}\n${RESUME_QUESTION_VOID}`);
    expect(texts).toContain(`${RESUME_HELD}\n${RESUME_RESTARTED}`);
    expect("afterRestart" in runOf(sim.task, "N1", 1)).toBe(false);
    expect("afterRestart" in runOf(sim.task, "N2", 1)).toBe(false);
  });

  it("says both when a node that was running had a question void too, and plain RESUME_HELD for a node that was already held", () => {
    const sim = new Sim(newTask([agent("N1"), agent("N2")], []));
    sim.send({ type: "started" });
    sim.send({ type: "paused" });
    sim.send({ type: "node_held", node: "N2", attempt: 1 });
    sim.send({ type: "host_restarted" });
    // N1 was running when the host stopped; N2 was already held and is left as it was.
    expect(runOf(sim.task, "N1", 1)).toMatchObject({ state: "held", afterRestart: { cutOff: true } });
    expect("afterRestart" in runOf(sim.task, "N2", 1)).toBe(false);

    const texts = resumeTexts(sim.send({ type: "resumed" }));

    expect(texts.toSorted()).toStrictEqual([RESUME_HELD, `${RESUME_HELD}\n${RESUME_RESTARTED}`].toSorted());
  });

  it("is part of the run's shape, so it reaches the snapshot", () => {
    const sim = heldBackByFailure();
    sim.send({ type: "host_restarted" });
    expect(() => NodeRun.parse(runOf(sim.task, "N2", 1))).not.toThrow("expected array");
  });
});

describe("host_restarted leaves alone the nodes this process already spoke to (SPEC-0006, T9 / T10 审查后用户定)", () => {
  it("does not send the restart line to a running node in live, nor void the question of a node that is answered", () => {
    const sim = new Sim(newTask([agent("N1"), agent("N2")], []));
    sim.send({ type: "started" });

    const actions = sim.send({ type: "host_restarted", live: ["N1"] });

    expect(resumeTexts(actions)).toStrictEqual([RESUME_RESTARTED]);
    expect(actions.filter((action) => action.kind === "resume_node").map((action) => action.node)).toStrictEqual([
      "N2",
    ]);
  });

  it("does not hold a live node of a task that is held back, nor note anything on it", () => {
    const sim = new Sim(newTask([agent("N1"), agent("N2")], []));
    sim.send({ type: "started" });
    sim.send({ type: "paused" });

    sim.send({ type: "host_restarted", live: ["N1"] });

    expect(runOf(sim.task, "N1", 1)).toMatchObject({ state: "running" });
    expect("afterRestart" in runOf(sim.task, "N1", 1)).toBe(false);
    expect(runOf(sim.task, "N2", 1)).toMatchObject({ state: "held" });
  });

  it("takes the node list as part of the event's shape", () => {
    const event = { seq: 3, at: 1, type: "host_restarted", live: ["N1"] };
    expect(TaskEvent.parse(event)).toStrictEqual(event);
    expect(TaskEvent.parse({ seq: 3, at: 1, type: "host_restarted" })).toStrictEqual({
      seq: 3,
      at: 1,
      type: "host_restarted",
    });
    expect(() => TaskEvent.parse({ ...event, live: "N1" })).toThrow("expected array");
  });
});
