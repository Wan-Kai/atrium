import { CommandError, PendingReview, type ReviewRecord } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import type { ReviewFacts, TaskReviewPorts } from "./task-reviews";
import { createTaskReviewProvider, needsWorktreeFacts, recordOf, recordText, reviewsOf } from "./task-reviews";
import { withRunChanges } from "../../test/review-support";
import { Sim, agent, edges, human, need, newTask } from "./test-support";
import type { Task } from "./types";

const PROJECT = "prj_0123456789abcdef";
const WORKSPACE = "wks_0123456789abcdef";
const NO_FACTS: ReviewFacts = { worktree: null, changes: null };
const CLEAN = { name: "export", merged: false, dirty: false, commits: 2 };

/** A started task with a worktree whose first node passed, so the human node `H` waits. */
function waitingHuman(extra: { merge?: boolean; back?: boolean } = {}): Sim {
  const sim = new Sim({
    ...newTask(
      [agent("N1", "explore"), human("H", extra.merge === true ? { merge: true } : {})],
      [...edges(["N1", "H"]), ...(extra.back === false ? [] : edges(["H", "N1", "back"]))],
      { workspaceState: "ready" },
    ),
    projectId: PROJECT,
    workspaceId: WORKSPACE,
  });
  sim.send({ type: "started" });
  sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "ses_1", startCommit: "abc" });
  sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "Explored it." });
  sim.send({ type: "node_settled", node: "N1", attempt: 1 });
  return sim;
}

/** The reviews of a task, validated against the protocol. */
function reviews(task: Task, facts: ReviewFacts = NO_FACTS): PendingReview[] {
  return reviewsOf(task, facts).map((one) => PendingReview.parse(one));
}

describe("the reviews of a task (ADR-0017, T8a)", () => {
  it("asks nothing of a task that is being designed, or that waits for nothing", () => {
    const designing = newTask([human("H")], []);
    const quiet = new Sim({ ...newTask([agent("N1")], []), projectId: PROJECT });
    quiet.send({ type: "started" });

    expect(reviews(designing)).toStrictEqual([]);
    expect(reviews(quiet.task)).toStrictEqual([]);
  });

  it("asks for a verdict on a waiting human node, naming the nodes it can go back to and the uses left", () => {
    const sim = waitingHuman();
    sim.send({ type: "human_sent_back", node: "H", to: "N1", reason: "r" });
    sim.send({ type: "node_started", node: "N1", attempt: 2, sessionId: "ses_2", startCommit: "abc" });
    sim.send({ type: "node_done_pending", node: "N1", attempt: 2, ok: true, summary: "Second try." });
    sim.send({ type: "node_settled", node: "N1", attempt: 2 });

    const [review] = reviews(sim.task);

    expect(review).toStrictEqual({
      id: "tsk_1:human:H:2",
      openedAt: need(sim.task.runs.findLast((run) => run.node === "H")).startedAt,
      source: { kind: "gate", gate: "task_human" },
      subject: { code: "task_human_node", params: { taskId: "tsk_1", node: "H", merge: false } },
      evidence: [{ kind: "summary", by: { kind: "node", node: "N1" }, text: "Second try." }],
      problem: null,
      actions: [
        { id: "pass", reason: "none", targets: [], recommended: true },
        { id: "send_back", reason: "required", targets: [{ id: "N1", remaining: 1 }], recommended: false },
      ],
    });
  });

  it("offers no send-back where the node has no back edge, and none to an edge used up", () => {
    const without = reviews(waitingHuman({ back: false }).task);
    expect(without[0]?.actions.map((action) => action.id)).toStrictEqual(["pass"]);

    const sim = waitingHuman();
    for (const attempt of [2, 3]) {
      sim.send({ type: "human_sent_back", node: "H", to: "N1", reason: "r" });
      sim.send({ type: "node_started", node: "N1", attempt, sessionId: `ses_${String(attempt)}`, startCommit: "abc" });
      sim.send({ type: "node_done_pending", node: "N1", attempt, ok: true, summary: "Again." });
      sim.send({ type: "node_settled", node: "N1", attempt });
    }
    expect(reviews(sim.task)[0]?.actions[1]?.targets).toStrictEqual([{ id: "N1", remaining: 0 }]);
  });

  it("puts the worktree's facts and changes before the upstream summaries, and grades a dirty tree a warning", () => {
    const sim = waitingHuman();
    const changes = { files: 3, added: 10, removed: 2 };

    const clean = reviews(sim.task, { worktree: CLEAN, changes })[0];
    const dirty = reviews(sim.task, { worktree: { ...CLEAN, dirty: true, commits: 0 }, changes })[0];

    expect(clean?.evidence).toStrictEqual([
      {
        kind: "facts",
        facts: [
          { code: "worktree_clean", params: { name: "export" }, status: "ok" },
          { code: "commits_ahead", params: { count: 2 }, status: "ok" },
        ],
      },
      { kind: "changes", workspaceId: WORKSPACE, ...changes },
      { kind: "summary", by: { kind: "node", node: "N1" }, text: "Explored it." },
    ]);
    expect(clean?.actions[0]).toMatchObject({ id: "pass", recommended: true });
    expect(dirty?.evidence[0]).toStrictEqual({
      kind: "facts",
      facts: [
        { code: "worktree_dirty", params: { name: "export" }, status: "warn" },
        { code: "commits_ahead", params: { count: 0 }, status: "warn" },
      ],
    });
    expect(dirty?.actions[0]).toMatchObject({ id: "pass", recommended: false });
    // Changes are shown only for a worktree the task has.
    expect(
      reviews({ ...sim.task, workspaceId: null }, { worktree: null, changes })[0]?.evidence.map((one) => one.kind),
    ).toStrictEqual(["summary"]);
  });

  it("lists only the back edges of its own node, and hands over the latest summary of each direct upstream node", () => {
    const sim = new Sim({
      ...newTask(
        [agent("A"), agent("B"), agent("C"), human("H"), human("H2")],
        [...edges(["A", "H"], ["B", "H"], ["C", "H2"], ["H", "A", "back"], ["H2", "C", "back"], ["H2", "B", "back"])],
        { workspaceState: "ready" },
      ),
      projectId: PROJECT,
      workspaceId: WORKSPACE,
    });
    sim.send({ type: "started" });
    for (const [node, attempt, summary] of [
      ["A", 1, "A first"],
      ["B", 1, "B only"],
      ["C", 1, "C only"],
    ] as const) {
      sim.send({ type: "node_started", node, attempt, sessionId: `ses_${node}`, startCommit: "abc" });
      sim.send({ type: "node_done_pending", node, attempt, ok: true, summary });
      sim.send({ type: "node_settled", node, attempt });
    }
    // A is sent back once and hands over again; H waits for the second time.
    sim.send({ type: "human_sent_back", node: "H", to: "A", reason: "r" });
    sim.send({ type: "node_started", node: "A", attempt: 2, sessionId: "ses_A2", startCommit: "abc" });
    sim.send({ type: "node_done_pending", node: "A", attempt: 2, ok: true, summary: "A second" });
    sim.send({ type: "node_settled", node: "A", attempt: 2 });

    const all = reviews(sim.task);
    const first = all.find((one) => one.id === "tsk_1:human:H:2");
    const second = all.find((one) => one.id === "tsk_1:human:H2:1");

    expect(all).toHaveLength(2);
    expect(first?.actions[1]?.targets).toStrictEqual([{ id: "A", remaining: 1 }]);
    expect(first?.evidence).toStrictEqual([
      { kind: "summary", by: { kind: "node", node: "A" }, text: "A second" },
      { kind: "summary", by: { kind: "node", node: "B" }, text: "B only" },
    ]);
    expect(second?.actions[1]?.targets).toStrictEqual([
      { id: "C", remaining: 2 },
      { id: "B", remaining: 2 },
    ]);
    expect(second?.evidence).toStrictEqual([{ kind: "summary", by: { kind: "node", node: "C" }, text: "C only" }]);
  });

  it("gives no hand-over for an upstream node that handed none, and names a merge block it has no reason for", () => {
    const sim = waitingHuman({ merge: true });
    const bare = withRunChanges(sim.task, "N1", { summary: null });
    const blocked = withRunChanges(sim.task, "H", { waitingFor: "merge_blocked", blocked: null });

    expect(reviews(bare)[0]?.evidence).toStrictEqual([]);
    expect(reviews(blocked)[0]?.problem).toStrictEqual({ code: "merge_blocked", params: {} });
  });

  it("shows a merge that was held back as a problem on the same card, with retry in place of pass", () => {
    const sim = waitingHuman({ merge: true });
    sim.send({ type: "human_passed", node: "H" });
    sim.send({ type: "merge_blocked", node: "H", reason: "merge_conflict", files: ["a.txt", "b.txt"] });

    const [review] = reviews(sim.task);

    expect(review).toMatchObject({
      id: "tsk_1:human:H:1",
      subject: { params: { merge: true } },
      problem: { code: "merge_conflict", params: {}, files: ["a.txt", "b.txt"] },
    });
    expect(review?.actions.map((action) => action.id)).toStrictEqual(["retry", "send_back"]);

    const dirty = new Sim(need(waitingHuman({ merge: true }).task));
    dirty.send({ type: "human_passed", node: "H" });
    dirty.send({ type: "merge_blocked", node: "H", reason: "merge_main_dirty" });
    expect(reviews(dirty.task)[0]?.problem).toStrictEqual({ code: "merge_main_dirty", params: {} });
  });

  it("asks nothing for a human node whose merge is under way, one a graph change voided, or a task that ended", () => {
    const merging = waitingHuman({ merge: true });
    merging.send({ type: "human_passed", node: "H" });
    const voided = withRunChanges(waitingHuman().task, "H", { void: true });
    const ended = { ...waitingHuman().task, endedAt: 99_000 };

    expect(reviews(merging.task)).toStrictEqual([]);
    expect(reviews(voided)).toStrictEqual([]);
    expect(reviews(ended)).toStrictEqual([]);
  });

  it("asks for a verdict on a graph change, with the difference and what the agent said", () => {
    const sim = waitingHuman();
    sim.send({
      type: "graph_proposed",
      author: "agent",
      note: "Look twice",
      nodes: [agent("N1", "explore"), human("H"), human("H2")],
      edges: edges(["N1", "H"], ["H", "H2"], ["H", "N1", "back"]),
    });

    const graph = reviews(sim.task).find((one) => one.id === "tsk_1:graph:v2");

    expect(graph).toStrictEqual({
      id: "tsk_1:graph:v2",
      openedAt: need(sim.task.graphs[1]).createdAt,
      source: { kind: "gate", gate: "task_graph" },
      subject: { code: "task_graph_change", params: { taskId: "tsk_1", version: 2 } },
      evidence: [
        { kind: "graph_diff", from: 1, to: 2, added: ["H2"], removed: [], changed: ["H"] },
        { kind: "summary", by: { kind: "agent" }, text: "Look twice" },
      ],
      problem: null,
      actions: [
        { id: "approve", reason: "none", targets: [], recommended: true },
        { id: "reject", reason: "optional", targets: [], recommended: false },
      ],
    });
    // No note, no summary; and a task that has not started takes its graph at once, so nothing waits.
    sim.send({ type: "graph_rejected" });
    sim.send({ type: "graph_proposed", author: "agent", note: "", nodes: [human("H")], edges: [] });
    expect(
      reviews(sim.task)
        .find((one) => one.id === "tsk_1:graph:v3")
        ?.evidence.map((one) => one.kind),
    ).toStrictEqual(["graph_diff"]);
    expect(reviews({ ...newTask([human("H")], []), pendingGraph: 1 })).toStrictEqual([]);
  });

  it("asks the archive question only while it is open, recommending archive for a merged clean tree", () => {
    const ended = { ...waitingHuman().task, endedAt: 77_000, archive: "asked" as const };
    const merged = { name: "export", merged: true, dirty: false, commits: 1 };

    const unmerged = reviews(ended, { worktree: CLEAN, changes: null })[0];
    const safe = reviews(ended, { worktree: merged, changes: { files: 1, added: 2, removed: 0 } })[0];
    const dirty = reviews(ended, { worktree: { ...merged, dirty: true }, changes: null })[0];
    const unknown = reviews(ended, { worktree: { ...merged, merged: null }, changes: null })[0];

    expect(unmerged).toMatchObject({
      id: "tsk_1:archive",
      openedAt: 77_000,
      source: { kind: "gate", gate: "task_archive" },
      subject: { code: "task_archive", params: { taskId: "tsk_1" } },
      problem: null,
      actions: [
        { id: "archive", recommended: false },
        { id: "keep", recommended: true },
      ],
    });
    expect(unmerged?.evidence[0]).toStrictEqual({
      kind: "facts",
      facts: [
        { code: "worktree_not_merged", params: { name: "export" }, status: "warn" },
        { code: "worktree_clean", params: { name: "export" }, status: "ok" },
        { code: "commits_ahead", params: { count: 2 }, status: "ok" },
      ],
    });
    expect(safe?.actions.map((action) => [action.id, action.recommended])).toStrictEqual([
      ["archive", true],
      ["keep", false],
    ]);
    expect(safe?.evidence.map((one) => one.kind)).toStrictEqual(["facts", "changes"]);
    expect(dirty?.evidence[0]).toMatchObject({
      facts: [
        { code: "worktree_merged", params: { name: "export" }, status: "ok" },
        { code: "worktree_dirty", status: "danger" },
        {},
      ],
    });
    expect(dirty?.actions[0]?.recommended).toBe(false);
    expect(unknown?.evidence[0]).toMatchObject({
      facts: [{ code: "worktree_merge_unknown", params: { name: "export" }, status: "warn" }, {}, {}],
    });
    // Without facts it is still asked, and kept by default.
    expect(reviews(ended)[0]?.evidence).toStrictEqual([]);
    expect(reviews(ended)[0]?.actions[1]?.recommended).toBe(true);
    // Answered, or not yet ended, it is no review.
    expect(reviews({ ...ended, archive: "kept" })).toStrictEqual([]);
    expect(reviews({ ...ended, archive: "archived" })).toStrictEqual([]);
    const quiet = { ...newTask([agent("N1")], []), archive: "asked" as const, startedAt: 1 };
    expect(reviews({ ...quiet, endedAt: null })).toStrictEqual([]);
    expect(reviews({ ...quiet, endedAt: 5 })).toHaveLength(1);
  });

  it("lists the reviews oldest first and says when the worktree's facts are worth working out", () => {
    const sim = waitingHuman();
    sim.send({
      type: "graph_proposed",
      author: "agent",
      note: "",
      nodes: [agent("N1", "explore"), human("H")],
      edges: edges(["N1", "H"]),
    });

    const both = reviews(sim.task);

    expect(both.map((one) => one.id)).toStrictEqual(
      both.toSorted((a, b) => a.openedAt - b.openedAt).map((one) => one.id),
    );
    expect(both).toHaveLength(2);
    expect(needsWorktreeFacts(sim.task)).toBe(true);
    expect(needsWorktreeFacts({ ...sim.task, archive: "asked" })).toBe(true);
    // The archive question alone is enough; without a waiting node or an open question there is nothing to show.
    const quiet = { ...newTask([agent("N1")], []), startedAt: 1 };
    expect(needsWorktreeFacts({ ...quiet, archive: "asked" })).toBe(true);
    expect(needsWorktreeFacts({ ...quiet, archive: "kept" })).toBe(false);
    expect(needsWorktreeFacts(quiet)).toBe(false);
  });
});

/** A task whose human node `H` waits behind `count` upstream nodes that each handed something over. */
function manyUpstream(count: number): Sim {
  const names = Array.from({ length: count }, (_, index) => `N${String(index + 1)}`);
  const sim = new Sim({
    ...newTask(
      [...names.map((name) => agent(name, "explore")), human("H")],
      names.map((name) => edges([name, "H"])[0]!),
      {
        workspaceState: "ready",
      },
    ),
    projectId: PROJECT,
    workspaceId: WORKSPACE,
  });
  sim.send({ type: "started" });
  for (const name of names) {
    sim.send({ type: "node_started", node: name, attempt: 1, sessionId: `ses_${name}`, startCommit: "abc" });
    sim.send({ type: "node_done_pending", node: name, attempt: 1, ok: true, summary: `Done ${name}.` });
    sim.send({ type: "node_settled", node: name, attempt: 1 });
  }
  return sim;
}

/** The nodes whose hand-overs a review quotes, in the order it quotes them. */
function quotedNodes(review: PendingReview | undefined): string[] {
  return (review?.evidence ?? []).flatMap((one) =>
    one.kind === "summary" && one.by.kind === "node" ? [one.by.node] : [],
  );
}

describe("what the protocol takes of the reviews of one task (T8 review fix 4)", () => {
  it("gives at most eight evidence items for a node with many upstream nodes, the host's measurements first", () => {
    const sim = manyUpstream(12);
    const changes = { files: 3, added: 10, removed: 2 };

    const [review] = reviews(sim.task, { worktree: CLEAN, changes });

    expect(review?.evidence).toHaveLength(8);
    expect(review?.evidence.map((one) => one.kind)).toStrictEqual([
      "facts",
      "changes",
      ...Array<string>(6).fill("summary"),
    ]);
    // The summaries kept are the first upstream nodes in graph order.
    expect(quotedNodes(review)).toStrictEqual(["N1", "N2", "N3", "N4", "N5", "N6"]);
    // Without a worktree there is room for eight summaries.
    expect(reviews(sim.task)[0]?.evidence).toHaveLength(8);
  });

  it("gives at most sixteen reviews, oldest first, when more human nodes wait", () => {
    const nodes = Array.from({ length: 20 }, (_, index) => human(`H${String(index + 1)}`));
    const sim = new Sim({ ...newTask(nodes, [], { workspaceState: "ready" }), projectId: PROJECT });
    sim.send({ type: "started" });

    const found = reviewsOf(sim.task, NO_FACTS);

    expect(found).toHaveLength(16);
    expect(found.map((one) => one.id)).toStrictEqual(
      sim.task.runs
        .toSorted((a, b) => a.startedAt - b.startedAt)
        .slice(0, 16)
        .map((run) => `tsk_1:human:${run.node}:1`),
    );
    expect(found.map((one) => PendingReview.parse(one).id)).toHaveLength(16);
  });
});

describe("what a verdict leaves in the conversation (ADR-0017, decision 2)", () => {
  const record: ReviewRecord = {
    source: { kind: "gate", gate: "task_human" },
    subject: { code: "task_human_node", params: { taskId: "tsk_1", node: "H", merge: false } },
    evidence: [{ kind: "summary", by: { kind: "node", node: "N1" }, text: "x".repeat(9000) }],
    verdict: { action: "send_back", target: "N1", reason: "look again" },
  };

  it("tells the model the gate, the parameters, the verdict and the user's reason", () => {
    expect(recordText(record)).toBe(
      "Atrium review: the user decided task_human_node taskId=tsk_1 node=H merge=false: send_back N1. The user's reason: look again",
    );
    expect(recordText({ ...record, verdict: { action: "pass" } })).toBe(
      "Atrium review: the user decided task_human_node taskId=tsk_1 node=H merge=false: pass.",
    );
    expect(recordText({ ...record, subject: { text: "Push?" }, verdict: { action: "yes" } })).toBe(
      "Atrium review: the user decided request: yes.",
    );
    expect(recordText({ ...record, verdict: { action: "pass", reason: "r".repeat(5000) } })).toContain(
      `The user's reason: ${"r".repeat(4000)}`,
    );
    expect(recordText({ ...record, verdict: { action: "pass", reason: "r".repeat(5000) } })).not.toContain(
      "r".repeat(4001),
    );
  });

  it("keeps the review as it was, with the verdict, and cuts a long text others wrote", () => {
    const review = need(reviews(waitingHuman().task)[0]);
    const long = { ...review, evidence: [{ kind: "summary", by: { kind: "agent" }, text: "y".repeat(9000) } as const] };

    const kept = recordOf(long, { action: "pass" });

    expect(kept).toStrictEqual({
      source: review.source,
      subject: review.subject,
      evidence: [{ kind: "summary", by: { kind: "agent" }, text: "y".repeat(8000) }],
      verdict: { action: "pass" },
    });
    expect(recordOf(review, { action: "pass" }).evidence).toStrictEqual(review.evidence);
  });
});

/**
 * A task service that holds one task and writes down what it was asked to carry out.
 *
 * @remarks
 * A hand-made service for the provider's tests: the provider is the unit, and the real service is covered by the
 * real-host tests. `afterAnswer` lets a test say what a business command does to the task.
 */
class FakeService {
  task: Task | undefined;
  readonly calls: string[] = [];
  readonly recorded: string[] = [];
  readonly events: string[] = [];
  afterAnswer: (() => void) | null = null;

  /**
   * Starts with a task.
   *
   * @remarks
   * Test support.
   *
   * @sideEffects none
   * @param task - The task it holds, or none.
   */
  constructor(task: Task | undefined) {
    this.task = task;
  }

  view = async () => {
    if (this.task === undefined) throw new CommandError("task_not_found");
    return { reviews: reviewsOf(this.task, NO_FACTS) } as Awaited<ReturnType<TaskReviewPorts["service"]["view"]>>;
  };
  approveGraph = async (id: string, reviewed?: { version: number; reviewId: string }) =>
    void this.calls.push(`approve ${id} v${String(reviewed?.version)} ${reviewed?.reviewId ?? ""}`);
  rejectGraph = async (id: string, reviewed?: { version: number; reviewId: string }) =>
    void this.calls.push(`reject ${id} v${String(reviewed?.version)} ${reviewed?.reviewId ?? ""}`);
  answerHuman = async (id: string, node: string, answer: unknown) => {
    this.calls.push(`human ${id} ${node} ${JSON.stringify(answer)}`);
    this.afterAnswer?.();
  };
  answerArchive = async (id: string, answer: string) => void this.calls.push(`archive ${id} ${answer}`);
  held = () => (this.task === undefined ? [] : [this.task]);
  recordReview = (id: string, line: { id: string }) => void this.recorded.push(`${id} ${line.id}`);
  onEvent = (listener: (task: Task, event: never, actions: readonly []) => void) => {
    this.events.push("subscribed");
    listener({ taskSessionId: "ses_task" } as Task, {} as never, []);
    return () => void this.events.push("unsubscribed");
  };
}

/** The provider over a service, for the task `tsk_1` whose conversation is `ses_task`. */
function providerOver(service: FakeService) {
  return createTaskReviewProvider({
    service,
    taskOf: (sessionId) => (sessionId === "ses_task" ? "tsk_1" : undefined),
  });
}

describe("the provider of the task gates", () => {
  const signal = new AbortController().signal;

  it("finds the reviews of the task a session is the conversation of, and none for another session", async () => {
    const provider = providerOver(new FakeService(waitingHuman().task));

    expect((await provider.pending("ses_task", signal)).map((one) => one.id)).toStrictEqual(["tsk_1:human:H:1"]);
    expect(await provider.pending("ses_other", signal)).toStrictEqual([]);
  });

  it("counts no reviews for a task that was taken away meanwhile, and lets other failures be heard", async () => {
    expect(await providerOver(new FakeService(undefined)).pending("ses_task", signal)).toStrictEqual([]);

    const broken = new FakeService(undefined);
    broken.view = () => Promise.reject(new Error("disk"));
    await expect(providerOver(broken).pending("ses_task", signal)).rejects.toThrow("disk");
  });

  it("carries a verdict out through the business commands, and records it once the review is gone", async () => {
    const sim = waitingHuman();
    const service = new FakeService(sim.task);
    const provider = providerOver(service);
    const [waiting] = await provider.pending("ses_task", signal);
    // The command takes effect: the task moves on and nothing waits any more.
    service.afterAnswer = () => {
      service.task = { ...sim.task, endedAt: 1 };
    };

    await provider.decide("ses_task", need(waiting), { action: "send_back", target: "N1", reason: "again" }, signal);

    expect(service.calls).toStrictEqual(['human tsk_1 H {"kind":"send_back","backTo":"N1","reason":"again"}']);
    expect(service.recorded).toStrictEqual(["tsk_1 review:tsk_1:human:H:1"]);
  });

  it("does not record a verdict whose review is still there, as a merge held back again is", async () => {
    const service = new FakeService(waitingHuman().task);
    const provider = providerOver(service);
    const waiting = need((await provider.pending("ses_task", signal))[0]);

    await provider.decide("ses_task", waiting, { action: "pass" }, signal);

    expect(service.calls).toStrictEqual(['human tsk_1 H {"kind":"pass"}']);
    expect(service.recorded).toStrictEqual([]);
  });

  it("writes no record while the node is still merging, as when the host is closing under its merge (T8 review fix 12)", async () => {
    const sim = waitingHuman({ merge: true });
    const service = new FakeService(sim.task);
    const provider = providerOver(service);
    const waiting = need((await provider.pending("ses_task", signal))[0]);
    // The pass took effect and the merge began, but the host closed before it ended: the node is `merging`, which
    // asks nothing, so the review is gone although nothing was decided yet.
    service.afterAnswer = () => {
      service.task = withRunChanges(sim.task, "H", { merging: true });
    };

    await provider.decide("ses_task", waiting, { action: "pass" }, signal);

    expect(service.calls).toStrictEqual(['human tsk_1 H {"kind":"pass"}']);
    expect(service.recorded).toStrictEqual([]);
  });

  it("maps each gate's actions to its business command", async () => {
    const sim = waitingHuman();
    sim.send({
      type: "graph_proposed",
      author: "agent",
      note: "",
      nodes: [agent("N1", "explore"), human("H"), human("H2")],
      edges: edges(["N1", "H"], ["H", "H2"]),
    });
    const service = new FakeService(sim.task);
    const provider = providerOver(service);
    const pending = await provider.pending("ses_task", signal);
    const graph = need(pending.find((one) => one.id === "tsk_1:graph:v2"));
    const waiting = need(pending.find((one) => one.id === "tsk_1:human:H:1"));

    await provider.decide("ses_task", graph, { action: "approve" }, signal);
    await provider.decide("ses_task", graph, { action: "reject" }, signal);
    const question = { ...waiting, source: { kind: "gate", gate: "task_archive" } } as PendingReview;
    await provider.decide("ses_task", question, { action: "archive" }, signal);
    await provider.decide("ses_task", question, { action: "keep" }, signal);
    await provider.decide("ses_task", waiting, { action: "retry" }, signal);

    expect(service.calls).toStrictEqual([
      "approve tsk_1 v2 tsk_1:graph:v2",
      "reject tsk_1 v2 tsk_1:graph:v2",
      "archive tsk_1 archive",
      "archive tsk_1 keep",
      'human tsk_1 H {"kind":"pass"}',
    ]);
  });

  it("refuses to carry out a verdict for a session that has no task, and for an agent's review", async () => {
    const service = new FakeService(undefined);
    const provider = providerOver(service);
    const review = need(reviews(waitingHuman().task)[0]);

    await expect(provider.decide("ses_other", review, { action: "pass" }, signal)).rejects.toMatchObject({
      code: "review_closed",
      params: { reviewId: review.id },
    });
    await expect(
      provider.decide(
        "ses_task",
        { ...review, source: { kind: "agent", toolCallId: "c1" } },
        { action: "pass" },
        signal,
      ),
    ).rejects.toMatchObject({ code: "review_closed" });
    await expect(
      provider.decide("ses_task", { ...review, subject: { text: "no node" } }, { action: "pass" }, signal),
    ).rejects.toMatchObject({ code: "review_closed", params: { reviewId: review.id } });
    // A graph review that names no version cannot be checked against the one waiting: it is not carried out.
    await expect(
      provider.decide(
        "ses_task",
        { ...review, source: { kind: "gate", gate: "task_graph" }, subject: { code: "task_graph_change", params: {} } },
        { action: "approve" },
        signal,
      ),
    ).rejects.toMatchObject({ code: "review_closed", params: { reviewId: review.id } });
    expect(service.calls).toStrictEqual([]);
  });

  it("tells the hub which session a task event is about, and stops when told", () => {
    const service = new FakeService(undefined);
    const changed: string[] = [];

    const stop = providerOver(service).subscribe((sessionId) => changed.push(sessionId));
    stop();

    expect(changed).toStrictEqual(["ses_task"]);
    expect(service.events).toStrictEqual(["subscribed", "unsubscribed"]);
  });
});
