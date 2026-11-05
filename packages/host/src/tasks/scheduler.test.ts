import { describe, expect, it } from "vitest";
import { backUses, step } from "./scheduler";
import { Sim, agent, edges, human, kinds, newTask, runOf } from "./test-support";
import type { Action, TaskEventInput } from "./types";

/** Starts a task and returns the sim after `started`. */
function started(sim: Sim): Sim {
  sim.send({ type: "started" });
  return sim;
}

/** The node's `node_done` followed by the end of its turn. */
function finish(sim: Sim, node: string, attempt = 1, summary = `${node} summary`): readonly Action[] {
  sim.send({ type: "node_done_pending", node, attempt, ok: true, summary });
  return sim.send({ type: "node_settled", node, attempt });
}

/** Sends a node event for attempt 1. */
function nodeEvent(type: "node_held" | "node_stopped" | "node_resumed" | "node_done_void", node: string, attempt = 1) {
  return { type, node, attempt } as TaskEventInput;
}

describe("step: designing and starting", () => {
  it("makes a proposed graph take effect at once while designing, and starts nothing", () => {
    const sim = new Sim(newTask([agent("N1")], []));
    const actions = sim.send({
      type: "graph_proposed",
      author: "agent",
      note: "v2",
      nodes: [agent("N1"), agent("N2")],
      edges: edges(["N1", "N2"]),
    });
    expect(actions).toStrictEqual([]);
    expect(sim.task.graphs.map((g) => g.version)).toStrictEqual([1, 2]);
    expect(sim.task.activeGraph).toBe(2);
    expect(sim.task.pendingGraph).toBeNull();
    expect(sim.status()).toBe("designing");
  });

  it("starts the first node on `started` and approves the graph", () => {
    const sim = new Sim(newTask([agent("N1"), agent("N2")], edges(["N1", "N2"])));
    const actions = sim.send({ type: "started" });
    expect(actions).toStrictEqual([
      { kind: "start_node", node: "N1", attempt: 1 },
      { kind: "progress_line", line: { id: "1.0", kind: "node_started", node: "N1" } },
    ]);
    expect(sim.task.startedAt).toBe(1000);
    expect(sim.task.graphs[0]?.approvedAt).toBe(1000);
    expect(sim.states()).toBe("N1=running N2=pending");
    expect(sim.status()).toBe("running");
    expect(sim.task.runs[0]).toMatchObject({ node: "N1", attempt: 1, graph: 1, state: "running", startedAt: 1000 });
  });

  it("ignores `started` twice, and `started` with no graph", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    expect(sim.send({ type: "started" })).toStrictEqual([]);
    const empty = newTask([], []);
    empty.activeGraph = 0;
    empty.graphs = [];
    expect(step(empty, { type: "started", seq: 1, at: 1 }).task).toBe(empty);
  });

  it("locks a worktree that already exists when the task starts", () => {
    const sim = new Sim(newTask([agent("N1", "work")], [], { workspaceState: "ready", ownsWorkspace: false }));
    expect(kinds(sim.send({ type: "started" }))).toStrictEqual(["lock_workspace", "start_node:N1"]);
  });

  it("starts nodes with no upstream together and waits for all upstream of a join", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], edges(["N1", "N3"], ["N2", "N3"]))));
    expect(sim.states()).toBe("N1=running N2=running N3=pending");
    expect(kinds(finish(sim, "N1"))).toStrictEqual([]);
    expect(sim.state("N3")).toBe("pending");
    expect(kinds(finish(sim, "N2"))).toStrictEqual(["start_node:N3"]);
  });

  it("records the session and start commit once", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "ses_a", startCommit: "c1" });
    sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "ses_b", startCommit: "c2" });
    expect(sim.task.runs[0]).toMatchObject({ sessionId: "ses_a", startCommit: "c1" });
  });

  it("ends the task when every end node passed: unlocks and asks to archive a worktree the task made", () => {
    const sim = started(
      new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], edges(["N1", "N3"]), { workspaceState: "ready" })),
    );
    finish(sim, "N1");
    expect(sim.status()).toBe("running");
    expect(kinds(finish(sim, "N3"))).toStrictEqual([]);
    expect(kinds(finish(sim, "N2"))).toStrictEqual(["unlock_workspace", "ask_archive"]);
    expect(sim.status()).toBe("done");
    expect(sim.task.endedAt).not.toBeNull();
  });

  it("only unlocks a worktree the task did not make", () => {
    const sim = started(new Sim(newTask([agent("N1")], [], { workspaceState: "ready", ownsWorkspace: false })));
    expect(kinds(finish(sim, "N1"))).toStrictEqual(["unlock_workspace"]);
  });

  it("takes no more events once done", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    finish(sim, "N1");
    const before = sim.task;
    expect(sim.send({ type: "paused" })).toStrictEqual([]);
    expect(sim.send({ type: "cancelled" })).toStrictEqual([]);
    expect(sim.task).toBe(before);
  });

  it("still records the commit of a writing end node after the task is done, and nothing else", () => {
    const sim = started(new Sim(newTask([agent("N1", "work")], [], { workspaceState: "ready" })));
    expect(kinds(finish(sim, "N1"))).toStrictEqual(["commit_node:N1", "unlock_workspace", "ask_archive"]);
    expect(sim.status()).toBe("done");
    expect(sim.send({ type: "committed", node: "N1", attempt: 1, commit: "deadbeef" })).toStrictEqual([]);
    expect(sim.task.runs[0]?.commit).toBe("deadbeef");
    expect(sim.status()).toBe("done");
    const after = sim.task;
    expect(sim.send({ type: "committed", node: "N1", attempt: 1, commit: "deadbeef" })).toStrictEqual([]);
    expect(sim.task).toBe(after);
    expect(sim.send({ type: "paused" })).toStrictEqual([]);
    expect(sim.task).toBe(after);
  });

  it("drops a commit that arrives after the task was cancelled", () => {
    const sim = started(new Sim(newTask([agent("N1", "work")], [], { workspaceState: "ready" })));
    finish(sim, "N1");
    const cancelled = { ...sim.task, cancelled: true };
    const result = step(cancelled, { type: "committed", node: "N1", attempt: 1, commit: "x", seq: 99, at: 1 });
    expect(result.task).toBe(cancelled);
  });
});

describe("step: a node's turn ends", () => {
  it("passes a node on its pending `node_done` and keeps the summary", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2")], edges(["N1", "N2"]))));
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "did it" });
    expect(sim.state("N1")).toBe("running");
    const actions = sim.send({ type: "node_settled", node: "N1", attempt: 1 });
    expect(kinds(actions)).toStrictEqual(["start_node:N2"]);
    expect(sim.task.runs[0]).toMatchObject({ state: "passed", summary: "did it", endedAt: 2000 + 1000 });
  });

  it("commits a writing node before the next node starts, and not a read-only one", () => {
    const sim = started(
      new Sim(newTask([agent("N1", "work"), agent("N2", "check")], edges(["N1", "N2"]), { workspaceState: "ready" })),
    );
    expect(kinds(finish(sim, "N1"))).toStrictEqual(["commit_node:N1", "start_node:N2"]);
    expect(sim.all().find((a) => a.kind === "commit_node")).toStrictEqual({
      kind: "commit_node",
      node: "N1",
      attempt: 1,
    });
    sim.send({ type: "committed", node: "N1", attempt: 1, commit: "deadbeef" });
    expect(sim.task.runs[0]?.commit).toBe("deadbeef");
    expect(kinds(finish(sim, "N2"))).toStrictEqual(["unlock_workspace", "ask_archive"]);
  });

  it("reminds a node that ended without `node_done` once, then fails it with no_done", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    expect(sim.send({ type: "node_settled", node: "N1", attempt: 1 })).toStrictEqual([
      { kind: "nudge_node", node: "N1" },
    ]);
    expect(sim.task.runs[0]?.nudged).toBe(true);
    expect(sim.state("N1")).toBe("running");
    const failed = sim.send({ type: "node_settled", node: "N1", attempt: 1 });
    expect(failed).toStrictEqual([
      { kind: "notify", attention: { kind: "failed", node: "N1", reason: "no_done" } },
      { kind: "progress_line", line: { id: "3.0", kind: "node_failed", node: "N1" } },
    ]);
    expect(sim.task.runs[0]).toMatchObject({ state: "failed", failure: "no_done" });
    expect(sim.status()).toBe("stopped");
  });

  it("forgets a `node_done` that was voided, so the node is reminded", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "x" });
    sim.send(nodeEvent("node_done_void", "N1"));
    expect(sim.task.runs[0]?.pendingDone).toBeNull();
    expect(kinds(sim.send({ type: "node_settled", node: "N1", attempt: 1 }))).toStrictEqual(["nudge_node:N1"]);
  });

  it("uses the last pending `node_done`", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: false, reason: "no" });
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "yes" });
    sim.send({ type: "node_settled", node: "N1", attempt: 1 });
    expect(sim.state("N1")).toBe("passed");
  });

  it("fails a node whose `node_done` gave up", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: false, reason: "cannot" });
    sim.send({ type: "node_settled", node: "N1", attempt: 1 });
    expect(sim.task.runs[0]).toMatchObject({ state: "failed", failure: "gave_up" });
  });

  it("ignores events about a run that is not the live one", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    for (const attempt of [2, 3]) {
      expect(sim.send({ type: "node_settled", node: "N1", attempt })).toStrictEqual([]);
      expect(sim.send({ type: "node_failed", node: "N1", attempt, reason: "crashed" })).toStrictEqual([]);
    }
    expect(sim.send({ type: "node_settled", node: "N9", attempt: 1 })).toStrictEqual([]);
    expect(sim.state("N1")).toBe("running");
  });

  it("ignores a settle for a node that is not running", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2")], edges(["N1", "N2"]))));
    expect(sim.send({ type: "node_settled", node: "N2", attempt: 1 })).toStrictEqual([]);
    finish(sim, "N1");
    expect(sim.send({ type: "node_settled", node: "N1", attempt: 1 })).toStrictEqual([]);
    expect(sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "late" })).toStrictEqual(
      [],
    );
    expect(sim.send(nodeEvent("node_done_void", "N1"))).toStrictEqual([]);
  });
});

describe("step: failure, hold and rerun", () => {
  it("holds the running siblings when a node fails, starts nothing, and a rerun lets them go on", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], edges(["N1", "N3"]))));
    sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "ses_1", startCommit: null });
    const failure = sim.send({ type: "node_failed", node: "N1", attempt: 1, reason: "crashed" });
    expect(kinds(failure)).toStrictEqual(["stop_node:N2"]);
    expect(failure).toContainEqual({ kind: "stop_node", node: "N2", when: "after_turn" });
    expect(failure).toContainEqual({ kind: "notify", attention: { kind: "failed", node: "N1", reason: "crashed" } });
    expect(sim.status()).toBe("stopped");
    expect(sim.send(nodeEvent("node_held", "N2"))).toStrictEqual([]);
    expect(sim.states()).toBe("N1=failed N2=held N3=pending");

    const rerun = sim.send({ type: "rerun_requested", node: "N1" });
    expect(rerun).toStrictEqual([
      { kind: "resume_node", node: "N1", text: "上次失败的原因：crashed，接着做" },
      { kind: "resume_node", node: "N2", text: "刚才任务暂停了，接着做" },
    ]);
    expect(sim.states()).toBe("N1=running N2=running N3=pending");
    expect(sim.task.runs[0]).toMatchObject({ attempt: 1, failure: null, endedAt: null });
    expect(sim.status()).toBe("running");
  });

  it("does not stop a sibling twice, and does not stop one that is waiting", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], [])));
    sim.send({ type: "node_waiting", node: "N2", attempt: 1, waitingFor: "question" });
    const actions = sim.send({ type: "node_failed", node: "N1", attempt: 1, reason: "model_error" });
    expect(actions.filter((a) => a.kind === "stop_node")).toStrictEqual([
      { kind: "stop_node", node: "N3", when: "after_turn" },
    ]);
  });

  it("deals with a third node failing while one runs and one waits (SPEC interleaving)", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], [])));
    sim.send({ type: "node_waiting", node: "N2", attempt: 1, waitingFor: "question" });
    sim.send({ type: "node_started", node: "N3", attempt: 1, sessionId: "ses_3", startCommit: null });
    const failure = sim.send({ type: "node_failed", node: "N3", attempt: 1, reason: "crashed" });
    expect(kinds(failure)).toStrictEqual(["stop_node:N1"]);
    expect(sim.status()).toBe("stopped");
    sim.send(nodeEvent("node_held", "N1"));
    // The user answers the question while the task is stopped: the node finishes its turn, then holds.
    expect(sim.send(nodeEvent("node_resumed", "N2"))).toStrictEqual([
      { kind: "stop_node", node: "N2", when: "after_turn" },
    ]);
    expect(sim.state("N2")).toBe("running");
    sim.send(nodeEvent("node_held", "N2"));
    expect(kinds(sim.send({ type: "rerun_requested", node: "N3" }))).toStrictEqual([
      "resume_node:N3",
      "resume_node:N1",
      "resume_node:N2",
    ]);
  });

  it("fails each kind of reason from running, waiting, held and stopped, but not from the other states", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2"), agent("N3"), agent("N4"), agent("N5")], [])));
    sim.send({ type: "node_waiting", node: "N2", attempt: 1, waitingFor: "graph_change" });
    sim.send(nodeEvent("node_stopped", "N3"));
    sim.send(nodeEvent("node_held", "N4"));
    for (const node of ["N1", "N2", "N3", "N4"]) {
      sim.send({ type: "node_failed", node, attempt: 1, reason: "crashed" });
      expect(sim.state(node)).toBe("failed");
    }
    expect(sim.send({ type: "node_failed", node: "N1", attempt: 1, reason: "model_error" })).toStrictEqual([]);
    expect(sim.task.runs.find((r) => r.node === "N1")?.failure).toBe("crashed");
  });

  it("does not fail a human node or a node waiting for a person", () => {
    const sim = started(new Sim(newTask([agent("N1"), human("H1")], edges(["N1", "H1"]))));
    finish(sim, "N1");
    expect(sim.state("H1")).toBe("waiting");
    expect(sim.send({ type: "node_failed", node: "H1", attempt: 1, reason: "crashed" })).toStrictEqual([]);
  });

  it("reruns a node that gave up, telling it why, with the same attempt and session", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "ses_1", startCommit: null });
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: false, reason: "r" });
    sim.send({ type: "node_settled", node: "N1", attempt: 1 });
    expect(sim.send({ type: "rerun_requested", node: "N1" })).toStrictEqual([
      { kind: "resume_node", node: "N1", text: "上次失败的原因：gave_up，接着做" },
    ]);
    expect(sim.task.runs).toHaveLength(1);
    expect(sim.task.runs[0]).toMatchObject({ state: "running", sessionId: "ses_1", pendingDone: null, nudged: false });
  });

  it("does not rerun a node that has not failed, nor while paused", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2")], [])));
    expect(sim.send({ type: "rerun_requested", node: "N1" })).toStrictEqual([]);
    sim.send({ type: "node_failed", node: "N1", attempt: 1, reason: "crashed" });
    sim.send({ type: "paused" });
    expect(sim.send({ type: "rerun_requested", node: "N1" })).toStrictEqual([]);
    expect(sim.state("N1")).toBe("failed");
  });

  it("forgives the reminder on a rerun", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    sim.send({ type: "node_settled", node: "N1", attempt: 1 });
    sim.send({ type: "node_settled", node: "N1", attempt: 1 });
    sim.send({ type: "rerun_requested", node: "N1" });
    expect(sim.send({ type: "node_settled", node: "N1", attempt: 1 })).toStrictEqual([
      { kind: "nudge_node", node: "N1" },
    ]);
  });
});

describe("step: pause, resume and stopping by hand", () => {
  it("pauses: running nodes stop after the turn, then are held, and nothing starts; resume lets them go on", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], edges(["N1", "N3"]))));
    expect(sim.send({ type: "paused" })).toStrictEqual([
      { kind: "stop_node", node: "N1", when: "after_turn" },
      { kind: "stop_node", node: "N2", when: "after_turn" },
    ]);
    expect(sim.status()).toBe("stopped");
    expect(sim.send({ type: "paused" })).toStrictEqual([]);
    sim.send(nodeEvent("node_held", "N1"));
    sim.send(nodeEvent("node_held", "N2"));
    expect(sim.status()).toBe("stopped");
    expect(sim.send({ type: "resumed" })).toStrictEqual([
      { kind: "resume_node", node: "N1", text: "刚才任务暂停了，接着做" },
      { kind: "resume_node", node: "N2", text: "刚才任务暂停了，接着做" },
    ]);
    expect(sim.status()).toBe("running");
    expect(sim.send({ type: "resumed" })).toStrictEqual([]);
  });

  it("starts no node while paused even when one finishes its turn with `node_done`", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2")], edges(["N1", "N2"]))));
    sim.send({ type: "paused" });
    expect(kinds(finish(sim, "N1"))).toStrictEqual([]);
    expect(sim.state("N2")).toBe("pending");
    expect(kinds(sim.send({ type: "resumed" }))).toStrictEqual(["start_node:N2"]);
  });

  it("cannot pause a task that is still designing", () => {
    const sim = new Sim(newTask([agent("N1")], []));
    expect(sim.send({ type: "paused" })).toStrictEqual([]);
    expect(sim.task.paused).toBe(false);
  });

  it("makes a node the user stopped hold the task, but not its siblings, and not resume with the task", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], edges(["N1", "N3"]))));
    expect(sim.send(nodeEvent("node_stopped", "N1"))).toStrictEqual([]);
    expect(sim.status()).toBe("stopped");
    expect(sim.state("N2")).toBe("running");
    sim.send({ type: "paused" });
    sim.send(nodeEvent("node_held", "N2"));
    // The task is still stopped by N1, so resuming it does not let N2 go on yet.
    expect(sim.send({ type: "resumed" })).toStrictEqual([]);
    expect(sim.states()).toBe("N1=stopped N2=held N3=pending");
    expect(kinds(sim.send(nodeEvent("node_resumed", "N1")))).toStrictEqual(["resume_node:N2"]);
    expect(sim.status()).toBe("running");
    expect(kinds(finish(sim, "N1"))).toStrictEqual(["start_node:N3"]);
  });

  it("lets a node the user stopped be stopped while it waits for a question", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
    sim.send(nodeEvent("node_stopped", "N1"));
    expect(sim.state("N1")).toBe("stopped");
    expect(sim.task.runs[0]?.waitingFor).toBeNull();
  });

  it("does not stop a node waiting for a graph change, nor hold one that is not running", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2")], edges(["N1", "N2"]))));
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change" });
    expect(sim.send(nodeEvent("node_stopped", "N1"))).toStrictEqual([]);
    expect(sim.send(nodeEvent("node_held", "N1"))).toStrictEqual([]);
    expect(sim.send(nodeEvent("node_held", "N2"))).toStrictEqual([]);
    expect(sim.state("N1")).toBe("waiting");
  });
});

describe("step: questions, graph changes and the closing human node", () => {
  it("asks for attention when a node asks a question, and runs again when it is answered", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    const actions = sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
    expect(actions).toStrictEqual([
      { kind: "progress_line", line: { id: "2.0", kind: "node_waiting", node: "N1" } },
      { kind: "notify", attention: { kind: "question", node: "N1" } },
    ]);
    expect(sim.status()).toBe("waiting");
    expect(sim.send(nodeEvent("node_resumed", "N1"))).toStrictEqual([]);
    expect(sim.state("N1")).toBe("running");
    expect(sim.send(nodeEvent("node_resumed", "N1"))).toStrictEqual([]);
  });

  it("wakes the task conversation when a node asks for a graph change, and resumes it on approval", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2")], edges(["N1", "N2"]))));
    const asked = sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change" });
    expect(asked).toContainEqual({ kind: "wake_task_conversation", text: "N1 申请改图" });
    const proposed = sim.send({
      type: "graph_proposed",
      author: "agent",
      note: "add N3",
      nodes: [agent("N1"), agent("N2"), agent("N3")],
      edges: edges(["N1", "N2"], ["N1", "N3"]),
    });
    expect(proposed).toStrictEqual([{ kind: "notify", attention: { kind: "graph_approval" } }]);
    expect(sim.task.pendingGraph).toBe(2);
    expect(sim.task.activeGraph).toBe(1);
    expect(sim.state("N1")).toBe("waiting");
    const approved = sim.send({ type: "graph_approved" });
    expect(approved).toStrictEqual([{ kind: "resume_node", node: "N1", text: "图已改，下面是新的契约" }]);
    expect(sim.task.activeGraph).toBe(2);
    expect(sim.task.pendingGraph).toBeNull();
    expect(sim.task.graphs[1]?.approvedAt).toBe(4000);
    expect(sim.state("N1")).toBe("running");
    expect(sim.send({ type: "graph_approved" })).toStrictEqual([]);
  });

  it("resumes the node with the old graph when the change is refused", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change" });
    sim.send({ type: "graph_proposed", author: "agent", note: "", nodes: [agent("N1"), agent("N2")], edges: [] });
    expect(sim.send({ type: "graph_rejected" })).toStrictEqual([
      { kind: "resume_node", node: "N1", text: "不改图，按原来的做" },
    ]);
    expect(sim.task.pendingGraph).toBeNull();
    expect(sim.task.activeGraph).toBe(1);
    expect(sim.send({ type: "graph_rejected" })).toStrictEqual([]);
  });

  it("replaces a pending graph with a newer proposal", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    for (const note of ["a", "b"]) {
      sim.send({ type: "graph_proposed", author: "agent", note, nodes: [agent("N1"), agent("N2")], edges: [] });
    }
    expect(sim.task.pendingGraph).toBe(3);
    sim.send({ type: "graph_approved" });
    expect(sim.task.activeGraph).toBe(3);
  });

  it("approves a graph while a node is stopped by hand: the waiting node goes on, no new node starts (SPEC interleaving)", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], edges(["N1", "N3"]))));
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change" });
    sim.send(nodeEvent("node_stopped", "N2"));
    sim.send({
      type: "graph_proposed",
      author: "agent",
      note: "",
      nodes: [agent("N1"), agent("N2"), agent("N3"), agent("N4")],
      edges: edges(["N1", "N3"]),
    });
    const approved = sim.send({ type: "graph_approved" });
    expect(approved).toStrictEqual([{ kind: "resume_node", node: "N1", text: "图已改，下面是新的契约" }]);
    expect(sim.state("N4")).toBe("pending");
    expect(sim.status()).toBe("stopped");
  });

  it("leaves a node that waited for a graph change held when the task is held back", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2")], [])));
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change" });
    sim.send({ type: "paused" });
    sim.send({ type: "graph_proposed", author: "agent", note: "", nodes: [agent("N1"), agent("N2")], edges: [] });
    expect(sim.send({ type: "graph_approved" })).toStrictEqual([]);
    expect(sim.state("N1")).toBe("held");
    expect(kinds(sim.send({ type: "resumed" }))).toContain("resume_node:N1");
  });

  it("opens a human node when its upstream passed, then passes it", () => {
    const sim = started(new Sim(newTask([agent("N1"), human("H1")], edges(["N1", "H1"]))));
    const opened = finish(sim, "N1");
    expect(opened).toContainEqual({ kind: "notify", attention: { kind: "human", node: "H1" } });
    expect(sim.task.runs[1]).toMatchObject({
      node: "H1",
      attempt: 1,
      state: "waiting",
      waitingFor: "human",
      sessionId: null,
    });
    expect(sim.status()).toBe("waiting");
    sim.send({ type: "human_passed", node: "H1" });
    expect(sim.state("H1")).toBe("passed");
    expect(sim.status()).toBe("done");
    expect(sim.send({ type: "human_passed", node: "H1" })).toStrictEqual([]);
  });

  it("does not pass a node that is not a waiting human node", () => {
    const sim = started(new Sim(newTask([agent("N1"), human("H1")], edges(["N1", "H1"]))));
    expect(sim.send({ type: "human_passed", node: "N1" })).toStrictEqual([]);
    expect(sim.send({ type: "human_passed", node: "H1" })).toStrictEqual([]);
    expect(sim.send({ type: "human_passed", node: "nope" })).toStrictEqual([]);
  });

  it("merges when a closing human node with `merge` is passed; a second pass waits for the result", () => {
    const sim = started(
      new Sim(newTask([agent("N1"), human("H1", { merge: true })], edges(["N1", "H1"]), { workspaceState: "ready" })),
    );
    finish(sim, "N1");
    expect(sim.send({ type: "human_passed", node: "H1" })).toStrictEqual([{ kind: "merge", node: "H1" }]);
    expect(sim.task.runs[1]?.merging).toBe(true);
    expect(sim.send({ type: "human_passed", node: "H1" })).toStrictEqual([]);
    sim.send({ type: "merge_started", node: "H1" });
    expect(sim.state("H1")).toBe("waiting");
    const merged = sim.send({ type: "merged", node: "H1" });
    expect(kinds(merged)).toStrictEqual(["unlock_workspace", "ask_archive"]);
    expect(sim.task.runs[1]).not.toHaveProperty("merging");
    expect(sim.status()).toBe("done");
  });

  it("holds a blocked merge for the user and merges again on the next pass", () => {
    const sim = started(
      new Sim(newTask([agent("N1"), human("H1", { merge: true })], edges(["N1", "H1"]), { workspaceState: "ready" })),
    );
    finish(sim, "N1");
    sim.send({ type: "human_passed", node: "H1" });
    const blocked = sim.send({ type: "merge_blocked", node: "H1", reason: "merge_main_dirty" });
    expect(blocked).toStrictEqual([
      { kind: "notify", attention: { kind: "merge_blocked", node: "H1", reason: "merge_main_dirty" } },
    ]);
    expect(sim.task.runs[1]).toMatchObject({
      state: "waiting",
      waitingFor: "merge_blocked",
      blocked: "merge_main_dirty",
    });
    expect(sim.status()).toBe("waiting");
    expect(sim.send({ type: "merged", node: "H1" })).toStrictEqual([]);
    expect(sim.send({ type: "human_passed", node: "H1" })).toStrictEqual([{ kind: "merge", node: "H1" }]);
    expect(sim.task.runs[1]).toMatchObject({ waitingFor: "human", blocked: null, merging: true });
  });

  it("only merges for a node with `merge` when the task has a worktree; otherwise passing is passing", () => {
    const sim = started(new Sim(newTask([agent("N1"), human("H1", { merge: true })], edges(["N1", "H1"]))));
    finish(sim, "N1");
    expect(sim.send({ type: "human_passed", node: "H1" })).toStrictEqual([
      { kind: "progress_line", line: { id: "4.0", kind: "node_passed", node: "H1" } },
    ]);
    expect(sim.state("H1")).toBe("passed");
  });

  it("after a merge conflict, a graph change that puts a node in front of the human node voids its wait and reopens it later", () => {
    const sim = started(
      new Sim(newTask([agent("N1"), human("H1", { merge: true })], edges(["N1", "H1"]), { workspaceState: "ready" })),
    );
    finish(sim, "N1");
    sim.send({ type: "human_passed", node: "H1" });
    sim.send({ type: "merge_blocked", node: "H1", reason: "merge_conflict" });
    sim.send({
      type: "graph_proposed",
      author: "agent",
      note: "resolve conflict",
      nodes: [agent("N1"), agent("N2", "work"), human("H1", { merge: true })],
      edges: edges(["N1", "N2"], ["N2", "H1"]),
    });
    const approved = sim.send({ type: "graph_approved" });
    expect(kinds(approved)).toStrictEqual(["start_node:N2"]);
    expect(sim.state("H1")).toBe("pending");
    expect(sim.task.runs.find((r) => r.node === "H1")).toMatchObject({ state: "waiting", void: true });
    expect(sim.status()).toBe("running");
    const done = finish(sim, "N2");
    expect(kinds(done)).toStrictEqual(["commit_node:N2"]);
    expect(done).toContainEqual({ kind: "notify", attention: { kind: "human", node: "H1" } });
    expect(sim.state("H1")).toBe("waiting");
    const h1Runs = sim.task.runs.filter((r) => r.node === "H1");
    expect(h1Runs).toHaveLength(2);
    expect(h1Runs[1]).toMatchObject({ attempt: 1, state: "waiting", waitingFor: "human", blocked: null });
    expect(h1Runs[1]).not.toHaveProperty("void");
    expect(sim.send({ type: "human_passed", node: "H1" })).toStrictEqual([{ kind: "merge", node: "H1" }]);
  });

  it("does not void a human node that is merging when the graph changes", () => {
    const sim = started(
      new Sim(newTask([agent("N1"), human("H1", { merge: true })], edges(["N1", "H1"]), { workspaceState: "ready" })),
    );
    finish(sim, "N1");
    sim.send({ type: "human_passed", node: "H1" });
    sim.send({
      type: "graph_proposed",
      author: "agent",
      note: "",
      nodes: [agent("N1"), agent("N2", "work"), human("H1", { merge: true })],
      edges: edges(["N1", "N2"], ["N2", "H1"]),
    });
    sim.send({ type: "graph_approved" });
    expect(sim.task.runs.find((r) => r.node === "H1")).not.toHaveProperty("void");
  });
});

/** N1 -> N2 -> H1 and N1 -> N3, with H1 able to send back to N1 or N2. */
function review(): Sim {
  const sim = started(
    new Sim(
      newTask(
        [agent("N1"), agent("N2"), agent("N3"), agent("N4"), human("H1")],
        edges(["N1", "N2"], ["N1", "N3"], ["N2", "H1"], ["H1", "N4"], ["H1", "N1", "back"], ["H1", "N2", "back"]),
      ),
    ),
  );
  finish(sim, "N1");
  finish(sim, "N2");
  return sim;
}

describe("step: send-back", () => {
  it("resets everything reachable from the target, side branches included, and starts the target afresh", () => {
    const sim = review();
    sim.send({ type: "node_started", node: "N3", attempt: 1, sessionId: "ses_3", startCommit: null });
    expect(sim.states()).toBe("N1=passed N2=passed N3=running N4=pending H1=waiting");
    const actions = sim.send({ type: "human_sent_back", node: "H1", to: "N1", reason: "redo it" });
    expect(actions.filter((a) => a.kind !== "progress_line")).toStrictEqual([
      { kind: "stop_node", node: "N3", when: "now" },
      { kind: "start_node", node: "N1", attempt: 2 },
    ]);
    expect(sim.states()).toBe("N1=running N2=pending N3=pending N4=pending H1=pending");
    const attempts = ["N1", "N2", "N3", "H1"].map((n) => `${n}:${sim.attempt(n)}`);
    expect(attempts).toStrictEqual(["N1:2", "N2:2", "N3:2", "H1:2"]);
    expect(runOf(sim.task, "N1", 2).backFrom).toStrictEqual({
      node: "H1",
      reason: "redo it",
    });
    expect(runOf(sim.task, "N2", 2)).not.toHaveProperty("backFrom");
    expect(runOf(sim.task, "N1", 2)).toMatchObject({ sessionId: null });
  });

  it("leaves a node that is not reachable from the target alone", () => {
    const sim = review();
    sim.send({ type: "human_sent_back", node: "H1", to: "N2", reason: "r" });
    expect(sim.states()).toBe("N1=passed N2=running N3=running N4=pending H1=pending");
    expect(sim.attempt("N1")).toBe(1);
    expect(sim.attempt("N3")).toBe(1);
  });

  it("does not bump nodes that never started, or that were already pending", () => {
    const sim = started(
      new Sim(
        newTask([agent("N1"), agent("N2"), human("H1")], edges(["N1", "H1"], ["N1", "N2"], ["H1", "N1", "back"]), {
          workspaceState: "ready",
        }),
      ),
    );
    finish(sim, "N1");
    sim.send({ type: "human_sent_back", node: "H1", to: "N1", reason: "r" });
    sim.send({ type: "paused" });
    sim.send({ type: "resumed" });
    expect(sim.attempt("N2")).toBe(2);
    expect(sim.task.runs.filter((r) => r.node === "N2")).toHaveLength(2);
  });

  it("stops a reset node that is running, waiting with a session, or held, and no one else", () => {
    const sim = review();
    sim.send({ type: "node_started", node: "N3", attempt: 1, sessionId: "ses_3", startCommit: null });
    sim.send({ type: "node_waiting", node: "N3", attempt: 1, waitingFor: "question" });
    const actions = sim.send({ type: "human_sent_back", node: "H1", to: "N1", reason: "r" });
    expect(actions.filter((a) => a.kind === "stop_node")).toStrictEqual([
      { kind: "stop_node", node: "N3", when: "now" },
    ]);
  });

  it("ignores events from the session of a run that was reset", () => {
    const sim = review();
    sim.send({ type: "human_sent_back", node: "H1", to: "N1", reason: "r" });
    expect(sim.send({ type: "node_settled", node: "N3", attempt: 1 })).toStrictEqual([]);
    expect(sim.send({ type: "node_failed", node: "N3", attempt: 1, reason: "crashed" })).toStrictEqual([]);
    expect(sim.state("N3")).toBe("pending");
  });

  it("allows each back edge twice and ignores the third (SPEC: at most 2)", () => {
    const sim = review();
    for (let round = 1; round <= 2; round += 1) {
      expect(backUses(sim.task, "H1", "N2")).toBe(round - 1);
      sim.send({ type: "human_sent_back", node: "H1", to: "N2", reason: `r${round}` });
      finish(sim, "N2", round + 1);
      finish(sim, "N3", round);
    }
    expect(backUses(sim.task, "H1", "N2")).toBe(2);
    expect(sim.state("H1")).toBe("waiting");
    const before = sim.task;
    expect(sim.send({ type: "human_sent_back", node: "H1", to: "N2", reason: "third" })).toStrictEqual([]);
    expect(sim.task).toBe(before);
    // The other edge has its own count.
    expect(backUses(sim.task, "H1", "N1")).toBe(0);
    expect(sim.send({ type: "human_sent_back", node: "H1", to: "N1", reason: "other edge" })).not.toStrictEqual([]);
  });

  it("ignores a send-back along an edge that does not exist, from a node not waiting, or while merging", () => {
    const sim = review();
    expect(sim.send({ type: "human_sent_back", node: "H1", to: "N3", reason: "r" })).toStrictEqual([]);
    expect(sim.send({ type: "human_sent_back", node: "N2", to: "N1", reason: "r" })).toStrictEqual([]);
    const merging = started(
      new Sim(
        newTask([agent("N1"), human("H1", { merge: true })], edges(["N1", "H1"], ["H1", "N1", "back"]), {
          workspaceState: "ready",
        }),
      ),
    );
    finish(merging, "N1");
    merging.send({ type: "human_passed", node: "H1" });
    expect(merging.send({ type: "human_sent_back", node: "H1", to: "N1", reason: "r" })).toStrictEqual([]);
  });

  it("can send back from a merge that was blocked", () => {
    const sim = started(
      new Sim(
        newTask([agent("N1"), human("H1", { merge: true })], edges(["N1", "H1"], ["H1", "N1", "back"]), {
          workspaceState: "ready",
        }),
      ),
    );
    finish(sim, "N1");
    sim.send({ type: "human_passed", node: "H1" });
    sim.send({ type: "merge_blocked", node: "H1", reason: "merge_main_not_trunk" });
    expect(kinds(sim.send({ type: "human_sent_back", node: "H1", to: "N1", reason: "r" }))).toStrictEqual([
      "start_node:N1",
    ]);
  });

  it("resets a failed side branch so the task is no longer stopped", () => {
    const sim = review();
    sim.send({ type: "node_failed", node: "N3", attempt: 1, reason: "crashed" });
    expect(sim.status()).toBe("stopped");
    sim.send({ type: "human_sent_back", node: "H1", to: "N1", reason: "r" });
    expect(sim.status()).toBe("running");
  });
});
