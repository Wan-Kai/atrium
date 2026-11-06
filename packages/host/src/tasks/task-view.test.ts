import {
  TASK_BACK_LIMIT,
  TASK_CONFLICT_FILES_LIMIT,
  TASK_TEXT_LIMIT,
  TaskFailureReason,
  TaskMergeBlockReason,
  TaskNodeState,
  type TaskStatus as ProtocolStatus,
  TaskView,
  TaskWaitingFor,
} from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { BACK_LIMIT, MAX_CONFLICT_FILES } from "./graph";
import { Sim, agent, edges, human, newTask } from "./test-support";
import { summaryOf, viewOf } from "./task-view";
import { FailureReason, MergeBlockReason, type NodeRun, NodeState, type TaskStatus } from "./types";

/** `true` only when the two types are the same. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
// A change to either side's list of statuses fails to compile here.
const sameStatuses: Same<TaskStatus, ProtocolStatus> = true;

const PROJECT = "prj_0123456789abcdef";
const WORKSPACE = "wks_0123456789abcdef";

/** A started task with a worktree, ids the protocol accepts. */
function startedSim(nodes: Parameters<typeof newTask>[0], graphEdges: Parameters<typeof newTask>[1]): Sim {
  const sim = new Sim({
    ...newTask(nodes, graphEdges, { workspaceState: "ready" }),
    projectId: PROJECT,
    workspaceId: WORKSPACE,
  });
  sim.send({ type: "started" });
  return sim;
}

/** A run of a node in a state, with the times given. */
const runOf = (node: string, state: NodeRun["state"], startedAt: number, endedAt: number | null): NodeRun => ({
  node,
  attempt: 1,
  graph: 1,
  state,
  waitingFor: null,
  blocked: null,
  sessionId: null,
  startedAt,
  endedAt,
  startCommit: null,
  pendingDone: null,
  summary: null,
  failure: null,
  commit: null,
  nudged: false,
});

describe("what the board is told (SPEC-0006, T5)", () => {
  it("has the protocol's enums and limits the same as the host's", () => {
    expect(sameStatuses).toBe(true);
    expect(TaskNodeState.options).toStrictEqual(NodeState.options);
    expect(TaskFailureReason.options).toStrictEqual(FailureReason.options);
    expect(TaskMergeBlockReason.options).toStrictEqual(MergeBlockReason.options);
    expect(TaskWaitingFor.options).toStrictEqual(["question", "graph_change", "human", "merge_blocked"]);
    expect(TASK_BACK_LIMIT).toBe(BACK_LIMIT);
    expect(TASK_CONFLICT_FILES_LIMIT).toBe(MAX_CONFLICT_FILES);
  });

  it("shows a task and each node by its latest run, in the shape the protocol accepts", () => {
    const sim = startedSim([agent("N1", "work"), human("H", { merge: true })], edges(["N1", "H"], ["H", "N1", "back"]));
    sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "ses_1", startCommit: "abc" });
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "Wrote it." });
    sim.send({ type: "node_settled", node: "N1", attempt: 1 });
    sim.send({ type: "committed", node: "N1", attempt: 1, commit: "def" });

    const view = TaskView.parse(viewOf(sim.task, null));

    expect(view).toMatchObject({ id: "tsk_1", status: "waiting", attention: "human", archive: null, graphVersion: 1 });
    expect(view.nodes.map((node) => [node.id, node.state, node.attempt, node.summary, node.sessionId])).toStrictEqual([
      ["N1", "passed", 1, "Wrote it.", "ses_1"],
      ["H", "waiting", 1, null, null],
    ]);
    expect(view.nodes[1]).toMatchObject({
      kind: "human",
      merge: true,
      waitingFor: "human",
      sendBack: [{ to: "N1", uses: 0 }],
    });
    expect(view.edges).toStrictEqual([
      { from: "N1", to: "H", kind: "seq" },
      { from: "H", to: "N1", kind: "back" },
    ]);
  });

  it("shows a node that has not begun with attempt 0, and keeps the last summary of a node that was sent back", () => {
    const sim = startedSim([agent("N1", "work"), human("H")], edges(["N1", "H"], ["H", "N1", "back"]));
    sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "ses_1", startCommit: "abc" });
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "First try." });
    sim.send({ type: "node_settled", node: "N1", attempt: 1 });
    sim.send({ type: "committed", node: "N1", attempt: 1, commit: "def" });
    sim.send({ type: "human_sent_back", node: "H", to: "N1", reason: "Again, please." });

    const view = viewOf(sim.task, null);

    const first = view.nodes.find((node) => node.id === "N1");
    expect(first).toMatchObject({
      state: "running",
      attempt: 2,
      summary: "First try.",
      backFrom: { node: "H", reason: "Again, please." },
    });
    expect(view.nodes.find((node) => node.id === "H")).toMatchObject({
      state: "pending",
      attempt: 2,
      sendBack: [{ to: "N1", uses: 1 }],
    });
    // Its second try hands over something else, which replaces the first.
    sim.send({ type: "node_started", node: "N1", attempt: 2, sessionId: "ses_2", startCommit: "def" });
    sim.send({ type: "node_done_pending", node: "N1", attempt: 2, ok: true, summary: "Second try." });
    sim.send({ type: "node_settled", node: "N1", attempt: 2 });
    sim.send({ type: "committed", node: "N1", attempt: 2, commit: "ghi" });
    expect(viewOf(sim.task, null).nodes.find((node) => node.id === "N1")?.summary).toBe("Second try.");
    const fresh = viewOf(startedSim([agent("N1"), agent("N2")], edges(["N1", "N2"])).task, null);
    expect(fresh.nodes.find((node) => node.id === "N2")).toMatchObject({ state: "pending", attempt: 0, summary: null });
  });

  it("marks what the user is wanted for, the most urgent first", () => {
    const failed = startedSim([agent("N1"), human("H")], edges(["N1", "H"]));
    failed.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s", startCommit: null });
    failed.send({ type: "node_failed", node: "N1", attempt: 1, reason: "gave_up" });
    expect(summaryOf(failed.task)).toMatchObject({ status: "stopped", attention: "failed" });

    const asking = startedSim([agent("N1")], []);
    asking.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s", startCommit: null });
    asking.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
    expect(summaryOf(asking.task).attention).toBe("question");
    const changing = startedSim([agent("N1")], []);
    changing.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s", startCommit: null });
    changing.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change" });
    expect(summaryOf(changing.task).attention).toBe("graph_change");

    const blocked = startedSim([human("H", { merge: true })], []);
    expect(summaryOf(blocked.task).attention).toBe("human");
    blocked.send({ type: "human_passed", node: "H" });
    blocked.send({ type: "merge_blocked", node: "H", reason: "merge_conflict", files: ["a.txt"] });
    expect(summaryOf(blocked.task).attention).toBe("merge_blocked");
    expect(viewOf(blocked.task, null).nodes[0]).toMatchObject({
      waitingFor: "merge_blocked",
      blocked: "merge_conflict",
      blockedFiles: ["a.txt"],
    });

    const quiet = startedSim([agent("N1")], []);
    expect(summaryOf(quiet.task).attention).toBeNull();
  });

  it("carries the archive question and its facts, and cuts texts the protocol would refuse", () => {
    const sim = startedSim(
      [agent("N1", "explore", { job: "j".repeat(TASK_TEXT_LIMIT + 5), done: ["d".repeat(TASK_TEXT_LIMIT + 1)] })],
      [],
    );
    sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s", startCommit: null });
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "s".repeat(TASK_TEXT_LIMIT + 9) });
    sim.send({ type: "node_settled", node: "N1", attempt: 1 });
    const facts = { name: "export", merged: true, dirty: false, commits: 2 };

    const view = viewOf(sim.task, facts);

    expect(TaskView.parse(view)).toMatchObject({ archive: "asked", archiveFacts: facts, status: "done" });
    expect(view.nodes[0]?.job).toHaveLength(TASK_TEXT_LIMIT);
    expect(view.nodes[0]?.done[0]).toHaveLength(TASK_TEXT_LIMIT);
    expect(view.nodes[0]?.summary).toHaveLength(TASK_TEXT_LIMIT);
  });

  it("shows a task with no graph yet as designing with no nodes", () => {
    const task = { ...newTask([], []), activeGraph: 0, graphs: [], projectId: null, workspaceId: null };

    expect(TaskView.parse(viewOf(task, null))).toMatchObject({
      status: "designing",
      nodes: [],
      edges: [],
      graphVersion: 0,
    });
  });

  describe("what the task area adds (SPEC-0006, T7)", () => {
    it("names the node a row is at: a failed one before a stopped one before a waiting one before a running one, the first in the graph among equals", () => {
      const nodes = [agent("N1"), agent("N2"), agent("N3"), agent("N4"), agent("N5")];
      const base = { ...newTask(nodes, []), startedAt: 1 };
      const started = { ...base, graphs: base.graphs.map((graph) => ({ ...graph, approvedAt: 1 })) };
      const named = (runs: NodeRun[]) => summaryOf({ ...started, runs }).current;

      expect(named([runOf("N1", "running", 1, null), runOf("N2", "running", 1, null)])).toStrictEqual({
        id: "N1",
        name: "node N1",
        state: "running",
      });
      expect(named([runOf("N1", "running", 1, null), runOf("N3", "waiting", 1, null)])?.id).toBe("N3");
      expect(named([runOf("N3", "waiting", 1, null), runOf("N4", "stopped", 1, null)])?.id).toBe("N4");
      expect(
        named([runOf("N1", "running", 1, null), runOf("N4", "stopped", 1, null), runOf("N5", "failed", 1, 2)])?.id,
      ).toBe("N5");
      expect(named([runOf("N1", "passed", 1, 2)])).toBeNull();
      expect(named([])).toBeNull();
    });

    it("dates the row by the latest start or end of a node, else when the task began or was made", () => {
      const base = { ...newTask([agent("N1")], []), createdAt: 100 };

      expect(summaryOf(base).activeAt).toBe(100);
      expect(summaryOf({ ...base, startedAt: 200 }).activeAt).toBe(200);
      expect(summaryOf({ ...base, startedAt: 200, endedAt: 900 }).activeAt).toBe(900);
      expect(
        summaryOf({
          ...base,
          startedAt: 200,
          runs: [runOf("N1", "passed", 300, 700), runOf("N1", "running", 500, null)],
        }).activeAt,
      ).toBe(700);
    });

    it("says whether a schedule made the task, and gives the task's model, the conversation it was made from and each node's own model", () => {
      const chat = newTask([agent("N1"), { ...agent("N2"), model: { providerId: "x", modelId: "y" } }], []);
      const scheduled = { ...chat, origin: { kind: "schedule" as const, ruleId: "r1", firedAt: 5 } };

      expect(summaryOf(chat).scheduled).toBe(false);
      expect(summaryOf(scheduled).scheduled).toBe(true);
      const view = TaskView.parse(viewOf({ ...chat, projectId: PROJECT, workspaceId: WORKSPACE }, null));
      expect(view.model).toStrictEqual({ providerId: "p", modelId: "m", thinking: "off" });
      expect(view.sourceSessionId).toBe("ses_src");
      expect(view.nodes.map((node) => node.model)).toStrictEqual([null, { providerId: "x", modelId: "y" }]);
      expect(TaskView.parse(viewOf({ ...scheduled, projectId: null }, null)).sourceSessionId).toBeNull();
    });
  });
});
