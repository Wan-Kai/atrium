import { describe, expect, it } from "vitest";
import { step } from "./scheduler";
import { Sim, agent, kinds, deepFreeze, edges, human, newTask } from "./test-support";
import type { TaskEventInput } from "./types";

/** Starts a task. */
function started(sim: Sim): Sim {
  sim.send({ type: "started" });
  return sim;
}

/** A node's `node_done` followed by the end of its turn. */
function finish(sim: Sim, node: string, attempt = 1): readonly unknown[] {
  sim.send({ type: "node_done_pending", node, attempt, ok: true, summary: "s" });
  return sim.send({ type: "node_settled", node, attempt });
}

/** A node event for attempt 1. */
function nodeEvent(type: "node_held" | "node_stopped" | "node_resumed", node: string): TaskEventInput {
  return { type, node, attempt: 1 };
}

describe("step: the task's worktree", () => {
  it("asks for the worktree once, keeps the node pending, and starts it when the worktree is there", () => {
    const sim = new Sim(newTask([agent("N1", "work")], []));
    expect(sim.send({ type: "started" })).toStrictEqual([{ kind: "ensure_workspace" }]);
    expect(sim.task.workspaceState).toBe("creating");
    expect(sim.state("N1")).toBe("pending");
    expect(sim.status()).toBe("running");
    expect(sim.send({ type: "workspace_creating" })).toStrictEqual([]);
    expect(sim.send({ type: "paused" })).toStrictEqual([]);
    expect(sim.send({ type: "resumed" })).toStrictEqual([]);
    const created = sim.send({ type: "workspace_created", workspaceId: "wsp_9", baseCommit: "c0ffee" });
    expect(kinds(created)).toStrictEqual(["lock_workspace", "start_node:N1"]);
    expect(created).toContainEqual({ kind: "progress_line", line: { id: "5.0", kind: "workspace_ready" } });
    expect(sim.task).toMatchObject({ workspaceState: "ready", workspaceId: "wsp_9", baseCommit: "c0ffee" });
    expect(sim.send({ type: "workspace_created", workspaceId: "wsp_x", baseCommit: "other" })).toStrictEqual([]);
    expect(sim.task.workspaceId).toBe("wsp_9");
  });

  it("asks for the worktree once even when several nodes need it", () => {
    const sim = new Sim(newTask([agent("N1", "work"), agent("N2", "check")], []));
    expect(sim.send({ type: "started" })).toStrictEqual([{ kind: "ensure_workspace" }]);
  });

  it("lets a read-only node begin in the source directory while the worktree is being made", () => {
    const sim = new Sim(newTask([agent("N1", "work"), agent("N2", "explore")], []));
    expect(kinds(sim.send({ type: "started" }))).toStrictEqual(["ensure_workspace", "start_node:N2"]);
  });

  it("does not ask for a worktree for a read-only node, even one placed read-only by hand", () => {
    const sim = new Sim(newTask([agent("N1", "work", { place: "readonly" })], []));
    expect(kinds(sim.send({ type: "started" }))).toStrictEqual(["start_node:N1"]);
    const inWorktree = new Sim(newTask([agent("N1", "explore", { place: "workspace" })], []));
    expect(kinds(inWorktree.send({ type: "started" }))).toStrictEqual(["ensure_workspace"]);
  });

  it("fails the nodes that waited for a worktree that could not be made, and a rerun asks again", () => {
    const sim = new Sim(newTask([agent("N1", "work"), agent("N2", "check"), agent("N3", "explore")], []));
    sim.send({ type: "started" });
    const failed = sim.send({ type: "workspace_failed" });
    expect(failed.filter((a) => a.kind === "notify")).toStrictEqual([
      { kind: "notify", attention: { kind: "failed", node: "N1", reason: "workspace" } },
      { kind: "notify", attention: { kind: "failed", node: "N2", reason: "workspace" } },
    ]);
    expect(kinds(failed)).toStrictEqual(["stop_node:N3"]);
    expect(sim.task.workspaceState).toBe("none");
    expect(sim.states()).toBe("N1=failed N2=failed N3=running");
    expect(sim.task.runs.find((r) => r.node === "N1")).toMatchObject({ failure: "workspace", sessionId: null });
    expect(sim.status()).toBe("stopped");
    expect(sim.send({ type: "workspace_failed" })).toStrictEqual([]);

    // N2 is still failed, so the task is stopped and nothing is asked for yet.
    expect(sim.send({ type: "rerun_requested", node: "N1" })).toStrictEqual([]);
    expect(sim.states()).toBe("N1=pending N2=failed N3=running");
    expect(sim.send({ type: "rerun_requested", node: "N2" })).toStrictEqual([{ kind: "ensure_workspace" }]);
    expect(sim.states()).toBe("N1=pending N2=pending N3=running");
    expect(sim.task.workspaceState).toBe("creating");
  });

  it("starts the node in the same attempt once a worktree arrives after a workspace failure", () => {
    const sim = new Sim(newTask([agent("N1", "work")], []));
    sim.send({ type: "started" });
    sim.send({ type: "workspace_failed" });
    sim.send({ type: "rerun_requested", node: "N1" });
    const created = sim.send({ type: "workspace_created", workspaceId: "w", baseCommit: "c" });
    expect(created).toContainEqual({ kind: "start_node", node: "N1", attempt: 1 });
    expect(sim.task.runs).toHaveLength(1);
  });

  it("ignores a worktree failure nobody waited for", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    expect(sim.send({ type: "workspace_failed" })).toStrictEqual([]);
  });

  it("forgets a worktree failure when no ready node needs it any more", () => {
    const sim = new Sim(
      newTask([agent("N0"), agent("N1", "work"), human("H1")], edges(["N0", "N1"], ["N1", "H1"], ["H1", "N0", "back"])),
    );
    sim.send({ type: "started" });
    expect(sim.task.workspaceState).toBe("none");
    finish(sim, "N0");
    expect(sim.task.workspaceState).toBe("creating");
    sim.send({ type: "human_passed", node: "H1" });
    expect(sim.send({ type: "workspace_failed" })).not.toStrictEqual([]);
  });
});

describe("step: a work node has its worktree to itself", () => {
  it("runs two ready work nodes one after the other", () => {
    const sim = started(new Sim(newTask([agent("N1", "work"), agent("N2", "work")], [], { workspaceState: "ready" })));
    expect(sim.states()).toBe("N1=running N2=pending");
    expect(kinds(finish(sim, "N1") as never)).toStrictEqual(["commit_node:N1", "start_node:N2"]);
  });

  it("keeps a check node out while a work node runs, and lets two check nodes run together", () => {
    const sim = started(
      new Sim(
        newTask([agent("N1", "work"), agent("N2", "check"), agent("N3", "check")], [], { workspaceState: "ready" }),
      ),
    );
    expect(sim.states()).toBe("N1=running N2=pending N3=pending");
    const next = finish(sim, "N1");
    expect(kinds(next as never)).toStrictEqual(["commit_node:N1", "start_node:N2", "start_node:N3"]);
  });

  it("keeps a work node out while another node runs or waits in the worktree", () => {
    const sim = started(
      new Sim(newTask([agent("N1", "explore"), agent("N2", "work")], [], { workspaceState: "ready" })),
    );
    expect(sim.states()).toBe("N1=running N2=pending");
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
    expect(sim.send({ type: "paused" })).toStrictEqual([]);
    sim.send({ type: "resumed" });
    expect(sim.state("N2")).toBe("pending");
    sim.send(nodeEvent("node_resumed", "N1"));
    expect(kinds(finish(sim, "N1") as never)).toStrictEqual(["start_node:N2"]);
  });

  it("holds a work node for a waiting work node too", () => {
    const sim = started(new Sim(newTask([agent("N1", "work"), agent("N2", "work")], [], { workspaceState: "ready" })));
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change" });
    expect(sim.state("N2")).toBe("pending");
  });

  it("does not hold a work node for a human node waiting for the user", () => {
    const sim = started(
      new Sim(
        newTask([agent("N1"), human("H1"), agent("N2", "work")], edges(["N1", "H1"], ["N1", "N2"]), {
          workspaceState: "ready",
        }),
      ),
    );
    finish(sim, "N1");
    expect(sim.states()).toBe("N1=passed H1=waiting N2=running");
  });

  it("starts a work node after a read-only node that began elsewhere has finished", () => {
    const sim = started(new Sim(newTask([agent("N1", "explore"), agent("N2", "work")], [])));
    expect(sim.states()).toBe("N1=running N2=pending");
    expect(sim.task.workspaceState).toBe("creating");
    // The worktree is there, but N1 may be in it: the run does not say where it began.
    expect(kinds(sim.send({ type: "workspace_created", workspaceId: "w", baseCommit: "c" }))).toStrictEqual([
      "lock_workspace",
    ]);
    expect(sim.state("N2")).toBe("pending");
    expect(kinds(finish(sim, "N1") as never)).toStrictEqual(["start_node:N2"]);
  });
});

describe("step: slots", () => {
  it("runs at most six agent nodes of a task at once, and the seventh when one finishes", () => {
    const nodes = Array.from({ length: 8 }, (_, index) => agent(`N${index + 1}`));
    const sim = started(new Sim(newTask(nodes, [])));
    expect(sim.states()).toBe(
      "N1=running N2=running N3=running N4=running N5=running N6=running N7=pending N8=pending",
    );
    expect(kinds(finish(sim, "N3") as never)).toStrictEqual(["start_node:N7"]);
  });

  it("keeps the slot of a node that waits for a question", () => {
    const nodes = Array.from({ length: 7 }, (_, index) => agent(`N${index + 1}`));
    const sim = started(new Sim(newTask(nodes, [])));
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
    expect(sim.state("N7")).toBe("pending");
    sim.send(nodeEvent("node_resumed", "N1"));
    expect(sim.states()).toContain("N7=pending");
  });

  it("counts a human node as no agent", () => {
    const nodes = [...Array.from({ length: 5 }, (_, index) => agent(`N${index + 1}`)), human("H1"), agent("N6")];
    const sim = started(new Sim(newTask(nodes, [])));
    expect(sim.states()).toBe("N1=running N2=running N3=running N4=running N5=running H1=waiting N6=running");
  });
});

describe("step: cancel, abandon, restart and the rest", () => {
  it("cancels: stops running nodes at once, unlocks and asks to archive; later events do nothing", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2"), agent("N3")], [], { workspaceState: "ready" })));
    sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s1", startCommit: null });
    sim.send({ type: "node_started", node: "N2", attempt: 1, sessionId: "s2", startCommit: null });
    sim.send({ type: "node_waiting", node: "N2", attempt: 1, waitingFor: "question" });
    sim.send({ type: "node_waiting", node: "N3", attempt: 1, waitingFor: "graph_change" });
    const actions = sim.send({ type: "cancelled" });
    expect(actions).toStrictEqual([
      { kind: "stop_node", node: "N1", when: "now" },
      { kind: "stop_node", node: "N2", when: "now" },
      { kind: "unlock_workspace" },
      { kind: "ask_archive" },
    ]);
    expect(sim.status()).toBe("cancelled");
    expect(sim.task.endedAt).toBe(6000);
    expect(sim.send({ type: "cancelled" })).toStrictEqual([]);
    expect(sim.send({ type: "rerun_requested", node: "N1" })).toStrictEqual([]);
  });

  it("cancels a task that has no worktree without unlocking", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    expect(sim.send({ type: "cancelled" })).toStrictEqual([]);
    expect(sim.status()).toBe("cancelled");
  });

  it("cannot cancel a task still designing, but can abandon it", () => {
    const sim = new Sim(newTask([agent("N1")], []));
    expect(sim.send({ type: "cancelled" })).toStrictEqual([]);
    expect(sim.send({ type: "abandoned" })).toStrictEqual([]);
    expect(sim.status()).toBe("cancelled");
    expect(sim.task.endedAt).toBe(2000);
  });

  it("cannot abandon a task that started", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    expect(sim.send({ type: "abandoned" })).toStrictEqual([]);
    expect(sim.status()).toBe("running");
  });

  it("changes the name and the model, and ignores a change that changes nothing", () => {
    const sim = new Sim(newTask([agent("N1")], []));
    expect(sim.send({ type: "meta_changed", name: "new name" })).toStrictEqual([]);
    expect(sim.task.name).toBe("new name");
    const model = { providerId: "q", modelId: "n", thinking: "high" as const };
    sim.send({ type: "meta_changed", model });
    expect(sim.task.model).toStrictEqual(model);
    const before = sim.task;
    sim.send({ type: "meta_changed", name: "new name", model });
    expect(sim.task).toBe(before);
    sim.send({ type: "meta_changed" });
    expect(sim.task).toBe(before);
  });

  it("does not change the task or the input it was given", () => {
    const task = deepFreeze(newTask([agent("N1")], []));
    const event = { type: "started", seq: 1, at: 5 } as const;
    const result = step(task, event);
    expect(result.task).not.toBe(task);
    expect(task.startedAt).toBeNull();
    expect(step(task, event)).toStrictEqual(result);
  });

  it("returns the same task and no actions for an event that does not fit", () => {
    const task = newTask([agent("N1")], []);
    const result = step(task, { type: "human_passed", node: "N1", seq: 1, at: 5 });
    expect(result.task).toBe(task);
    expect(result.actions).toStrictEqual([]);
  });

  it("ignores acknowledgements and records the scheduler does not use", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    const before = sim.task;
    for (const input of [
      { type: "archive_asked" },
      { type: "archive_answered", answer: "keep" },
      { type: "merge_started", node: "N1" },
      { type: "workspace_creating" },
    ] as const) {
      expect(sim.send(input)).toStrictEqual([]);
    }
    expect(sim.task).toBe(before);
  });
});

describe("step: the host restarts", () => {
  it("tells a running node to look at what it did and go on", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "x" });
    expect(sim.send({ type: "host_restarted" })).toStrictEqual([
      {
        kind: "resume_node",
        node: "N1",
        text: "宿主重启了。先看一下你已经做了什么（会话记录和 worktree 的改动），再接着做；做完调用 node_done",
      },
    ]);
    expect(sim.state("N1")).toBe("running");
    expect(sim.task.runs[0]?.pendingDone).toBeNull();
  });

  it("holds a running node instead when the task is held back", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2")], [])));
    sim.send({ type: "node_failed", node: "N1", attempt: 1, reason: "crashed" });
    expect(sim.send({ type: "host_restarted" })).toStrictEqual([]);
    expect(sim.state("N2")).toBe("held");
    expect(kinds(sim.send({ type: "rerun_requested", node: "N1" }))).toStrictEqual(["resume_node:N2", "start_node:N1"]);
  });

  it("voids a question and lets the node ask again", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
    expect(sim.send({ type: "host_restarted" })).toStrictEqual([
      { kind: "resume_node", node: "N1", text: "刚才的问题作废了，需要的话再问" },
    ]);
    expect(sim.state("N1")).toBe("running");
  });

  it("wakes the task conversation again when a graph change was asked for but not proposed, and not when it was", () => {
    const sim = started(new Sim(newTask([agent("N1")], [])));
    sim.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change" });
    expect(sim.send({ type: "host_restarted" })).toStrictEqual([
      { kind: "wake_task_conversation", text: "N1 申请改图" },
    ]);
    sim.send({ type: "graph_proposed", author: "agent", note: "", nodes: [agent("N1")], edges: [] });
    expect(sim.send({ type: "host_restarted" })).toStrictEqual([]);
    expect(sim.state("N1")).toBe("waiting");
  });

  it("leaves human nodes, blocked merges and stopped nodes alone, and sends a merge in flight again", () => {
    const sim = started(
      new Sim(
        newTask(
          [agent("N1"), agent("N2"), human("H1"), human("H2", { merge: true })],
          edges(["N1", "H2"], ["N2", "H2"]),
          {
            workspaceState: "ready",
          },
        ),
      ),
    );
    sim.send(nodeEvent("node_stopped", "N2"));
    expect(sim.send({ type: "host_restarted" })).toStrictEqual([
      {
        kind: "resume_node",
        node: "N1",
        text: "宿主重启了。先看一下你已经做了什么（会话记录和 worktree 的改动），再接着做；做完调用 node_done",
      },
    ]);
    sim.send(nodeEvent("node_resumed", "N2"));
    finish(sim, "N1");
    finish(sim, "N2");
    sim.send({ type: "human_passed", node: "H2" });
    expect(sim.send({ type: "host_restarted" })).toStrictEqual([{ kind: "merge", node: "H2" }]);
    sim.send({ type: "merge_blocked", node: "H2", reason: "merge_conflict" });
    expect(sim.send({ type: "host_restarted" })).toStrictEqual([]);
    expect(sim.state("H1")).toBe("waiting");
  });

  it("resumes held nodes through the advance when the task is not held back", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2")], [])));
    sim.send({ type: "paused" });
    sim.send(nodeEvent("node_held", "N1"));
    sim.send(nodeEvent("node_held", "N2"));
    expect(sim.send({ type: "host_restarted" })).toStrictEqual([]);
    expect(kinds(sim.send({ type: "resumed" }))).toStrictEqual(["resume_node:N1", "resume_node:N2"]);
  });

  it("gives the same actions when the log is played again", () => {
    const sim = started(new Sim(newTask([agent("N1"), agent("N2")], edges(["N1", "N2"]))));
    finish(sim, "N1");
    const again = step(sim.task, { type: "host_restarted", seq: 99, at: 99_000 });
    expect(kinds(again.actions)).toStrictEqual(["resume_node:N2"]);
  });
});
