import type { AtriumClient } from "@atrium/client";
import { CommandError, type PendingReview, TaskView, type Verdict } from "@atrium/protocol";
import { present } from "@atrium/testkit";
import { GIT_SCENE_ENV } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  controlReviews,
  failedCode,
  latestRunOf,
  recordLines,
  reviewRecords,
  waitsAtAttempt,
} from "../../test/review-support";
import { TASK_NAME, type TaskHost, startTaskHost } from "../../test/task-harness";
import { agent, edges, human } from "./test-support";
import type { GraphEdge, GraphNode, Task } from "./types";

vi.setConfig({ testTimeout: 90_000 });

const say = (text: string) => ({ blocks: [{ type: "text" as const, text }] });
const call = (name: string, id: string, args: Record<string, unknown>) => ({
  blocks: [{ type: "toolCall" as const, id, name, arguments: args as Record<string, never> }],
});

/** The scripts of a work node that writes `out.txt`. */
const writing = [
  call("write", "w1", { path: "./out.txt", content: "from the task\n" }),
  call("node_done", "d1", { ok: true, summary: "Wrote out.txt." }),
];

/** What the task conversation says in the turns the tests start, after its design turn. */
const CHATTER = [say("Designing."), say("Noted."), say("Noted again."), say("And once more.")];

/**
 * Runs git in a directory and returns what it printed.
 *
 * @sideEffects Runs git.
 * @param cwd - The directory.
 * @param args - git's arguments.
 * @returns Its output, trimmed.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_SCENE_ENV, encoding: "utf8" }).trim();
}

/**
 * Makes a real task conversation and a started task on a graph.
 *
 * @remarks
 * The conversation is the one `/task` makes (a real pi on the faux model); the graph is recorded the way the
 * conversation's tool would. Human nodes need no pi of their own.
 *
 * @sideEffects Makes and starts a task in the harness's host.
 * @param harness - The host.
 * @param nodes - The graph's nodes.
 * @param graphEdges - Its edges.
 * @returns The task, as it is once started.
 */
async function startedTask(harness: TaskHost, nodes: GraphNode[], graphEdges: GraphEdge[]): Promise<Task> {
  await harness.discuss();
  const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
  await harness.until(taskId, (task) => task.taskSessionId !== "");
  await harness.send(taskId, { type: "meta_changed", name: TASK_NAME });
  await harness.send(taskId, { type: "graph_proposed", author: "agent", note: "first", nodes, edges: graphEdges });
  await harness.host.host.tasks.start(taskId);
  return harness.task(taskId);
}

/** What a rejected promise was rejected with, as its code and parameters. */
async function failure(work: Promise<unknown>): Promise<{ code: string; params: unknown }> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CommandError)) throw new Error(`expected a CommandError, got ${String(error)}`);
  return { code: error.code, params: error.params };
}

/** Waits until the task conversation's control carries exactly these review ids, and returns the reviews. */
async function seeReviews(client: AtriumClient, sessionId: string, ids: string[]): Promise<PendingReview[]> {
  await vi.waitFor(() => expect(controlReviews(client, sessionId).map((review) => review.id)).toStrictEqual(ids), {
    timeout: 30_000,
  });
  return controlReviews(client, sessionId);
}

/** The task as the board shows it, from the host. */
async function viewOf(harness: TaskHost, taskId: string): Promise<TaskView> {
  return TaskView.parse(await harness.host.host.tasks.view(taskId, new AbortController().signal));
}

describe("human node reviews, answered through answer_review (ADR-0017, T8a)", () => {
  it("shows the waiting node on the task conversation, passes it, and leaves a record the model reads", async () => {
    const harness = await startTaskHost({}, { design: CHATTER });
    const task = await startedTask(harness, [human("H1")], []);
    const { client } = harness;
    await client.watch([task.taskSessionId]);

    const [review] = await seeReviews(client, task.taskSessionId, [`${task.id}:human:H1:1`]);

    expect(review).toMatchObject({
      source: { kind: "gate", gate: "task_human" },
      subject: { code: "task_human_node", params: { taskId: task.id, node: "H1", merge: false } },
      problem: null,
      actions: [{ id: "pass", reason: "none", targets: [], recommended: true }],
    });
    expect(review?.openedAt).toBe(latestRunOf(task, "H1")?.startedAt);
    await client.answerReview(task.taskSessionId, `${task.id}:human:H1:1`, { action: "pass" });
    await harness.until(task.id, (now) => now.endedAt !== null);
    await seeReviews(client, task.taskSessionId, []);
    expect((await viewOf(harness, task.id)).reviews).toStrictEqual([]);

    // The record is a step on the conversation's rail, with the evidence as it was.
    await vi.waitFor(() => expect(recordLines(client, task.taskSessionId)).toStrictEqual(["task_human: pass"]));
    expect(reviewRecords(client, task.taskSessionId)[0]).toMatchObject({
      source: { kind: "gate", gate: "task_human" },
      subject: { code: "task_human_node", params: { node: "H1" } },
      verdict: { action: "pass" },
    });
    // And the model sees it on its next request.
    await client.prompt(task.taskSessionId, "what happened?");
    await vi.waitFor(async () => {
      const last = JSON.stringify((await harness.contexts()).at(-1)?.messages);
      expect(last).toContain("Atrium review: the user decided task_human_node");
      expect(last).toContain("node=H1");
    });
  });

  it("sends a node back with a target and a reason, counts the uses down, and refuses a third use of the edge", async () => {
    const harness = await startTaskHost({}, { design: CHATTER });
    const task = await startedTask(harness, [human("H1"), human("H2")], edges(["H1", "H2"], ["H2", "H1", "back"]));
    const { client } = harness;
    const sid = task.taskSessionId;
    await client.watch([sid]);
    await seeReviews(client, sid, [`${task.id}:human:H1:1`]);
    await client.answerReview(sid, `${task.id}:human:H1:1`, { action: "pass" });

    const [second] = await seeReviews(client, sid, [`${task.id}:human:H2:1`]);
    expect(second?.actions).toStrictEqual([
      { id: "pass", reason: "none", targets: [], recommended: true },
      { id: "send_back", reason: "required", targets: [{ id: "H1", remaining: 2 }], recommended: false },
    ]);

    await client.answerReview(sid, `${task.id}:human:H2:1`, {
      action: "send_back",
      target: "H1",
      reason: "look again",
    });
    const back = await harness.until(task.id, (now) => waitsAtAttempt(now, "H1", 2));
    expect(latestRunOf(back, "H1")?.backFrom).toStrictEqual({ node: "H2", reason: "look again" });
    await seeReviews(client, sid, [`${task.id}:human:H1:2`]);
    await client.answerReview(sid, `${task.id}:human:H1:2`, { action: "pass" });
    const [again] = await seeReviews(client, sid, [`${task.id}:human:H2:2`]);
    expect(again?.actions[1]?.targets).toStrictEqual([{ id: "H1", remaining: 1 }]);
    await client.answerReview(sid, `${task.id}:human:H2:2`, { action: "send_back", target: "H1", reason: "and again" });
    await seeReviews(client, sid, [`${task.id}:human:H1:3`]);
    await client.answerReview(sid, `${task.id}:human:H1:3`, { action: "pass" });
    const [last] = await seeReviews(client, sid, [`${task.id}:human:H2:3`]);
    expect(last?.actions[1]?.targets).toStrictEqual([{ id: "H1", remaining: 0 }]);

    // The exhausted edge is listed (so the card can grey it) and the host still refuses it.
    expect(
      await failure(
        client.answerReview(sid, `${task.id}:human:H2:3`, {
          action: "send_back",
          target: "H1",
          reason: "a third time",
        }),
      ),
    ).toStrictEqual({ code: "task_back_limit", params: undefined });
    expect(latestRunOf(harness.task(task.id), "H2")).toMatchObject({ state: "waiting", attempt: 3 });
    await vi.waitFor(() =>
      expect(recordLines(client, sid)).toStrictEqual([
        "task_human: pass",
        "task_human: send_back H1",
        "task_human: pass",
        "task_human: send_back H1",
        "task_human: pass",
      ]),
    );
    await client.answerReview(sid, `${task.id}:human:H2:3`, { action: "pass" });
    expect((await harness.until(task.id, (now) => now.endedAt !== null)).endedAt).not.toBeNull();
  });

  it("refuses a verdict that does not fit, a review that is gone, and a second verdict on the same review", async () => {
    const harness = await startTaskHost({}, { design: CHATTER });
    const task = await startedTask(harness, [human("H1"), human("H2")], edges(["H1", "H2"], ["H2", "H1", "back"]));
    const { client } = harness;
    const sid = task.taskSessionId;
    await client.watch([sid]);
    await seeReviews(client, sid, [`${task.id}:human:H1:1`]);
    await client.answerReview(sid, `${task.id}:human:H1:1`, { action: "pass" });
    const id = `${task.id}:human:H2:1`;
    await seeReviews(client, sid, [id]);
    const bad = async (verdict: Verdict) => (await failure(client.answerReview(sid, id, verdict))).params;

    expect(await bad({ action: "approve" })).toStrictEqual({ field: "action" });
    expect(await bad({ action: "send_back", reason: "why" })).toStrictEqual({ field: "target" });
    expect(await bad({ action: "send_back", target: "H9", reason: "why" })).toStrictEqual({ field: "target" });
    expect(await bad({ action: "send_back", target: "H1" })).toStrictEqual({ field: "reason" });
    expect(await bad({ action: "send_back", target: "H1", reason: "  " })).toStrictEqual({ field: "reason" });
    expect(await bad({ action: "pass", reason: "why" })).toStrictEqual({ field: "reason" });
    expect(await bad({ action: "pass", target: "H1" })).toStrictEqual({ field: "target" });
    expect(await failure(client.answerReview(sid, "tsk_nope:human:H2:1", { action: "pass" }))).toStrictEqual({
      code: "review_closed",
      params: { reviewId: "tsk_nope:human:H2:1" },
    });
    // Nothing of that was carried out.
    expect(latestRunOf(harness.task(task.id), "H2")?.state).toBe("waiting");

    // Two windows answer at once: one wins, the other is told the review is closed.
    const both = await Promise.allSettled([
      client.answerReview(sid, id, { action: "pass" }),
      client.answerReview(sid, id, { action: "send_back", target: "H1", reason: "no" }),
    ]);
    expect(both.map((one) => failedCode(one)).toSorted()).toStrictEqual(["", "review_closed"]);
  });

  it("keeps the reviews through a host restart, on the task and on the conversation once its pi runs", async () => {
    const harness = await startTaskHost({}, { design: CHATTER });
    const task = await startedTask(harness, [human("H1")], []);
    const id = `${task.id}:human:H1:1`;
    const before = (await viewOf(harness, task.id)).reviews;
    expect(before.map((review) => review.id)).toStrictEqual([id]);

    await harness.restart();

    // The host takes the task up by itself (T9); the reviews are worked out again from the files.
    await vi.waitFor(() => expect(harness.host.host.tasks.held().map((held) => held.id)).toStrictEqual([task.id]));
    expect((await viewOf(harness, task.id)).reviews).toStrictEqual(before);
    // The conversation's pi starts on a message; its control then carries the reviews.
    const { client } = harness;
    await client.watch([task.taskSessionId]);
    await client.prompt(task.taskSessionId, "where are we?");
    await seeReviews(client, task.taskSessionId, [id]);
    // The card is still there for the message that was sent: sending does not touch it.
    await client.answerReview(task.taskSessionId, id, { action: "pass" });
    expect((await harness.until(task.id, (now) => now.endedAt !== null)).endedAt).not.toBeNull();
  });
});

describe("graph approval reviews (ADR-0017, T8a)", () => {
  it("shows a graph change with what it adds and changes, approves one, and refuses the next", async () => {
    const harness = await startTaskHost({}, { design: CHATTER });
    const task = await startedTask(harness, [human("H1")], []);
    const { client } = harness;
    const sid = task.taskSessionId;
    await client.watch([sid]);
    await seeReviews(client, sid, [`${task.id}:human:H1:1`]);
    expect((await viewOf(harness, task.id)).pending).toBeNull();

    await harness.send(task.id, {
      type: "graph_proposed",
      author: "agent",
      note: "Add a second look",
      nodes: [human("H1"), human("H2")],
      edges: edges(["H1", "H2"]),
    });
    const id = `${task.id}:graph:v2`;
    const reviews = await seeReviews(client, sid, [`${task.id}:human:H1:1`, id]);
    const graph = reviews.find((review) => review.id === id);
    expect(graph).toMatchObject({
      source: { kind: "gate", gate: "task_graph" },
      subject: { code: "task_graph_change", params: { taskId: task.id, version: 2 } },
      evidence: [
        { kind: "graph_diff", from: 1, to: 2, added: ["H2"], removed: [], changed: ["H1"] },
        { kind: "summary", by: { kind: "agent" }, text: "Add a second look" },
      ],
      actions: [
        { id: "approve", reason: "none", targets: [], recommended: true },
        { id: "reject", reason: "optional", targets: [], recommended: false },
      ],
    });
    const waiting = await viewOf(harness, task.id);
    expect(waiting).toMatchObject({ pendingGraph: true, graphVersion: 1, graphDiff: null });
    expect(waiting.pending).toMatchObject({
      version: 2,
      author: "agent",
      note: "Add a second look",
      diff: { from: 1, added: ["H2"], removed: [], changed: ["H1"] },
    });
    expect(waiting.pending?.nodes.map((node) => node.id)).toStrictEqual(["H1", "H2"]);

    await client.answerReview(sid, id, { action: "approve" });
    await seeReviews(client, sid, [`${task.id}:human:H1:1`]);
    const approved = await viewOf(harness, task.id);
    expect(approved).toMatchObject({
      pendingGraph: false,
      graphVersion: 2,
      pending: null,
      graphDiff: { from: 1, added: ["H2"], removed: [], changed: ["H1"] },
    });

    await harness.send(task.id, {
      type: "graph_proposed",
      author: "agent",
      note: "Drop it again",
      nodes: [human("H1")],
      edges: [],
    });
    const second = `${task.id}:graph:v3`;
    await seeReviews(client, sid, [`${task.id}:human:H1:1`, second]);
    await client.answerReview(sid, second, { action: "reject" });
    await seeReviews(client, sid, [`${task.id}:human:H1:1`]);
    expect(await viewOf(harness, task.id)).toMatchObject({ pendingGraph: false, graphVersion: 2 });
    await vi.waitFor(() =>
      expect(recordLines(client, sid)).toStrictEqual(["task_graph: approve", "task_graph: reject"]),
    );
    // The state check of the business command stands behind the card: no graph waits any more.
    expect(await failure(client.answerReview(sid, second, { action: "approve" }))).toMatchObject({
      code: "review_closed",
    });
    expect(await failure(harness.host.host.tasks.approveGraph(task.id))).toMatchObject({
      code: "task_state_invalid",
    });
  });

  it("gives the requirement summary the conversation wrote to the board, and keeps it once the task started", async () => {
    const harness = await startTaskHost({}, { design: CHATTER });
    await harness.discuss();
    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    await harness.until(taskId, (task) => task.taskSessionId !== "");
    const summary = {
      goal: "Make out.txt",
      decisions: ["plain text"],
      constraints: [],
      nonGoals: ["no tests"],
      openQuestions: ["which name?"],
      acceptance: ["it says hello"],
    };
    await harness.send(taskId, { type: "summary_set", summary });
    await harness.send(taskId, { type: "meta_changed", name: TASK_NAME });
    await harness.send(taskId, { type: "graph_proposed", author: "agent", note: "", nodes: [human("H1")], edges: [] });

    expect((await viewOf(harness, taskId)).requirements).toStrictEqual(summary);
    await harness.host.host.tasks.start(taskId);
    await harness.send(taskId, { type: "summary_set", summary: { ...summary, goal: "Changed after the start" } });
    expect((await viewOf(harness, taskId)).requirements.goal).toBe("Make out.txt");
  });
});

describe("merge and archive reviews (ADR-0017, T8a)", () => {
  it("holds a merge back as a problem on the same card, retries it once the cause is gone, and then asks about the worktree", async () => {
    const harness = await startTaskHost({ N1: writing }, { design: CHATTER });
    const task = await startedTask(harness, [agent("N1", "work"), human("H", { merge: true })], edges(["N1", "H"]));
    const { client } = harness;
    const sid = task.taskSessionId;
    await client.watch([sid]);
    const id = `${task.id}:human:H:1`;
    const [open] = await seeReviews(client, sid, [id]);
    const dir = await harness.worktree(task.id);
    expect(open).toMatchObject({
      subject: { params: { node: "H", merge: true } },
      problem: null,
      actions: [{ id: "pass", recommended: true }],
    });
    expect(open?.evidence).toStrictEqual([
      {
        kind: "facts",
        facts: [
          { code: "worktree_clean", params: { name: expect.any(String) }, status: "ok" },
          { code: "commits_ahead", params: { count: 1 }, status: "ok" },
        ],
      },
      { kind: "changes", workspaceId: expect.any(String), files: 1, added: 1, removed: 0 },
      { kind: "summary", by: { kind: "node", node: "N1" }, text: "Wrote out.txt." },
    ]);

    await writeFile(join(dir, "loose.txt"), "not committed\n");
    await client.answerReview(sid, id, { action: "pass" });
    const [blocked] = await seeReviews(client, sid, [id]);
    expect(blocked).toMatchObject({
      problem: { code: "merge_worktree_dirty", params: {} },
      actions: [{ id: "retry", reason: "none", recommended: false }],
    });
    expect(blocked?.actions.map((action) => action.id)).toStrictEqual(["retry"]);
    expect(recordLines(client, sid)).toStrictEqual([]);

    git(dir, "clean", "-fdq");
    await client.answerReview(sid, id, { action: "retry" });
    const merged = await harness.until(task.id, (now) => now.endedAt !== null);
    expect(latestRunOf(merged, "H")).toMatchObject({ state: "passed" });
    expect(git(harness.repo, "show", "main:out.txt")).toBe("from the task");
    await vi.waitFor(() => expect(recordLines(client, sid)).toStrictEqual(["task_human: retry"]));

    // The task ended: the question about the worktree is the next card. Merged and clean, so archive is the default.
    const archiveId = `${task.id}:archive`;
    const [ask] = await seeReviews(client, sid, [archiveId]);
    expect(ask).toMatchObject({
      source: { kind: "gate", gate: "task_archive" },
      subject: { code: "task_archive", params: { taskId: task.id } },
      problem: null,
      actions: [
        { id: "archive", recommended: true },
        { id: "keep", recommended: false },
      ],
    });
    expect(ask?.evidence[0]).toMatchObject({
      kind: "facts",
      facts: [
        { code: "worktree_merged", status: "ok" },
        { code: "worktree_clean", status: "ok" },
        { code: "commits_ahead", status: "ok" },
      ],
    });
    await client.answerReview(sid, archiveId, { action: "archive" });
    await seeReviews(client, sid, []);
    expect(harness.task(task.id).archive).toBe("archived");
    await vi.waitFor(() =>
      expect(recordLines(client, sid)).toStrictEqual(["task_human: retry", "task_archive: archive"]),
    );
  });

  it("keeps a worktree that is not merged, by default, and leaves the question to answer_archive afterwards", async () => {
    const harness = await startTaskHost({ N1: writing }, { design: CHATTER });
    const task = await startedTask(harness, [agent("N1", "work")], []);
    const { client } = harness;
    const sid = task.taskSessionId;
    await client.watch([sid]);
    const archiveId = `${task.id}:archive`;
    const [ask] = await seeReviews(client, sid, [archiveId]);

    expect(ask?.actions).toStrictEqual([
      { id: "archive", reason: "none", targets: [], recommended: false },
      { id: "keep", reason: "none", targets: [], recommended: true },
    ]);
    expect(ask?.evidence[0]).toMatchObject({
      facts: [{ code: "worktree_not_merged", status: "warn" }, { code: "worktree_clean" }, { code: "commits_ahead" }],
    });
    await client.answerReview(sid, archiveId, { action: "keep" });
    await seeReviews(client, sid, []);
    expect(harness.task(task.id).archive).toBe("kept");
    await vi.waitFor(() => expect(recordLines(client, sid)).toStrictEqual(["task_archive: keep"]));
    // The business command still reaches it, as the list's row does.
    expect(await failure(harness.host.host.tasks.answerArchive(task.id, "keep"))).toMatchObject({
      code: "task_state_invalid",
    });
  });

  it("answers a refused archive with the business command's own code and keeps the card", async () => {
    const harness = await startTaskHost({ N1: writing }, { design: CHATTER });
    const task = await startedTask(harness, [agent("N1", "work")], []);
    const { client } = harness;
    const sid = task.taskSessionId;
    await client.watch([sid]);
    const archiveId = `${task.id}:archive`;
    await seeReviews(client, sid, [archiveId]);
    await writeFile(join(await harness.worktree(task.id), "loose.txt"), "not committed\n");

    expect(await failure(client.answerReview(sid, archiveId, { action: "archive" }))).toMatchObject({
      code: "workspace_dirty",
    });
    const [still] = await seeReviews(client, sid, [archiveId]);
    expect(still?.evidence[0]).toMatchObject({
      facts: expect.arrayContaining([{ code: "worktree_dirty", params: expect.anything(), status: "danger" }]),
    });
    expect(recordLines(client, sid)).toStrictEqual([]);
  });
});

describe("the conversations the reviews sit beside (T8a)", () => {
  it("lets the task conversation take a message while a review is open, and a node's question be answered in its own session", async () => {
    const harness = await startTaskHost(
      {
        N1: [
          call("ask_user", "q1", {
            questions: [
              {
                header: "Scope",
                question: "Which scope?",
                multiSelect: false,
                options: [
                  { label: "Small", description: "just this" },
                  { label: "Large", description: "all of it" },
                ],
              },
            ],
          }),
          call("node_done", "d1", { ok: true, summary: "Small it is." }),
        ],
      },
      { design: CHATTER },
    );
    const task = await startedTask(harness, [agent("N1", "explore"), human("H1")], edges(["N1", "H1"]));
    const { client } = harness;
    const sid = task.taskSessionId;

    // The node's question reaches a client that only watches the node's session: no tab is opened.
    const asking = await harness.until(task.id, (now) => latestRunOf(now, "N1")?.waitingFor === "question");
    const nodeSession = present(latestRunOf(asking, "N1")?.sessionId, "the node's session");
    await client.watch([nodeSession, sid]);
    await vi.waitFor(() => expect(client.session(nodeSession)?.getState().control.question?.id).toBe("q1"));
    await client.answerQuestion(nodeSession, "q1", { answers: [{ selected: [0], other: null }] });
    await harness.until(task.id, (now) => latestRunOf(now, "H1")?.state === "waiting");
    expect(client.index.getState().sessions.map((one) => one.sessionId)).not.toContain(nodeSession);
    expect(client.index.getState().sessions.map((one) => one.sessionId)).not.toContain(sid);

    // The task conversation takes a message the ordinary way and the review stays.
    const id = `${task.id}:human:H1:1`;
    await seeReviews(client, sid, [id]);
    await client.prompt(sid, "how far along are we?");
    await vi.waitFor(() => expect(client.session(sid)?.getState().items.length).toBeGreaterThan(1));
    await vi.waitFor(async () =>
      expect(JSON.stringify((await harness.contexts()).at(-1)?.messages)).toContain("how far along"),
    );
    expect(controlReviews(client, sid).map((review) => review.id)).toStrictEqual([id]);
    await client.answerReview(sid, id, { action: "pass" });
    expect((await harness.until(task.id, (now) => now.endedAt !== null)).endedAt).not.toBeNull();
  });
});

describe("opening a task's own session without a tab (open_task_session, T8a)", () => {
  it("starts the pi of a node that has passed, so a watcher gets its snapshot, and changes nothing of the task", async () => {
    const harness = await startTaskHost(
      { N1: [call("node_done", "d1", { ok: true, summary: "Looked." })] },
      { design: CHATTER },
    );
    const task = await startedTask(harness, [agent("N1", "explore"), human("H1")], edges(["N1", "H1"]));
    const { client } = harness;
    const passed = await harness.until(task.id, (now) => latestRunOf(now, "H1")?.state === "waiting");
    const nodeSession = present(latestRunOf(passed, "N1")?.sessionId, "the node's session");
    // Its pi was stopped when the node passed, so watching it alone brings no snapshot.
    await client.watch([nodeSession]);
    expect(client.session(nodeSession)?.getState().status).not.toBe("ready");
    const before = JSON.stringify(harness.task(task.id));

    await client.openTaskSession(task.id, nodeSession);

    await vi.waitFor(() => expect(client.session(nodeSession)?.getState().status).toBe("ready"));
    expect(client.session(nodeSession)?.getState().items.length).toBeGreaterThan(0);
    expect(JSON.stringify(harness.task(task.id))).toBe(before);
    // And it is no tab or list entry of the project.
    expect(client.index.getState().sessions.map((one) => one.sessionId)).not.toContain(nodeSession);
    expect(JSON.stringify(client.index.getState().layout)).not.toContain(nodeSession);
  });

  it("opens the task conversation the same way, and refuses a session that is not the task's or a task that is not there", async () => {
    const harness = await startTaskHost({}, { design: CHATTER });
    const task = await startedTask(harness, [human("H1")], []);
    const { client } = harness;
    await client.watch([task.taskSessionId]);

    await client.openTaskSession(task.id, task.taskSessionId);

    await vi.waitFor(() => expect(client.session(task.taskSessionId)?.getState().status).toBe("ready"));
    expect(await failure(client.openTaskSession(task.id, harness.origin))).toStrictEqual({
      code: "session_not_found",
      params: { sessionId: harness.origin },
    });
    expect(await failure(client.openTaskSession(task.id, "ses_nobody"))).toMatchObject({ code: "session_not_found" });
    expect(await failure(client.openTaskSession("tsk_nobody", task.taskSessionId))).toStrictEqual({
      code: "task_not_found",
      params: undefined,
    });
  });
});
