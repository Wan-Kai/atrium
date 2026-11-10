import type { AtriumClient } from "@atrium/client";
import { CommandError, type PendingReview, TaskView } from "@atrium/protocol";
import { present } from "@atrium/testkit";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { controlReviews, latestRunOf, recordLines, reviewRecords } from "../../test/review-support";
import { type TaskHost, startTaskHost } from "../../test/task-harness";
import { agent, edges, human } from "./test-support";
import type { GraphEdge, GraphNode, Task } from "./types";

vi.setConfig({ testTimeout: 90_000 });

const say = (text: string) => ({ blocks: [{ type: "text" as const, text }] });
const call = (name: string, id: string, args: Record<string, unknown>) => ({
  blocks: [{ type: "toolCall" as const, id, name, arguments: args as Record<string, never> }],
});

/** What the task conversation says in the turns the tests start, after its design turn. */
const CHATTER = [say("Designing."), say("Noted."), say("Noted again."), say("And once more.")];

/**
 * Makes a real task conversation and a started task on a graph.
 *
 * @remarks
 * Same as the T8a tests: the conversation is a real pi on the faux model, the graph is recorded the way its tool
 * would.
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
  await harness.send(taskId, { type: "meta_changed", name: "test task" });
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

describe("a verdict on a graph change is for the version the user saw (T8 review fix 2)", () => {
  it("does not approve or reject a newer proposal that came between the card and the verdict", async () => {
    const harness = await startTaskHost({}, { design: CHATTER });
    const task = await startedTask(harness, [human("H1")], []);
    const { client } = harness;
    const sid = task.taskSessionId;
    await client.watch([sid]);
    const seen = { version: 2, reviewId: `${task.id}:graph:v2` };
    await harness.send(task.id, {
      type: "graph_proposed",
      author: "agent",
      note: "v2",
      nodes: [human("H1"), human("H2")],
      edges: edges(["H1", "H2"]),
    });
    await seeReviews(client, sid, [`${task.id}:human:H1:1`, seen.reviewId]);

    // The newer proposal is queued ahead of the verdicts, as when the agent proposes between the card and the click.
    const proposing = harness.send(task.id, {
      type: "graph_proposed",
      author: "agent",
      note: "v3",
      nodes: [human("H1"), human("H3")],
      edges: edges(["H1", "H3"]),
    });
    const approving = failure(harness.host.host.tasks.approveGraph(task.id, seen));
    const rejecting = failure(harness.host.host.tasks.rejectGraph(task.id, seen));
    await proposing;

    expect(await approving).toStrictEqual({ code: "review_closed", params: { reviewId: seen.reviewId } });
    expect(await rejecting).toStrictEqual({ code: "review_closed", params: { reviewId: seen.reviewId } });
    const after = await viewOf(harness, task.id);
    expect(after).toMatchObject({ pendingGraph: true, graphVersion: 1 });
    expect(after.pending?.version).toBe(3);
    expect(harness.task(task.id).pendingGraph).toBe(3);
  });
});

describe("refusing a graph change takes an optional reason (T8 review decision 3)", () => {
  it("takes the reason into the record and the model's context, and still takes a refusal without one", async () => {
    const harness = await startTaskHost({}, { design: CHATTER });
    const task = await startedTask(harness, [human("H1")], []);
    const { client } = harness;
    const sid = task.taskSessionId;
    await client.watch([sid]);
    const propose = async (note: string, nodes: GraphNode[]) =>
      harness.send(task.id, { type: "graph_proposed", author: "agent", note, nodes, edges: [] });

    await propose("v2", [human("H1"), human("H2")]);
    await seeReviews(client, sid, [`${task.id}:human:H1:1`, `${task.id}:graph:v2`]);
    await client.answerReview(sid, `${task.id}:graph:v2`, { action: "reject", reason: "too many steps" });
    await propose("v3", [human("H1"), human("H3")]);
    await seeReviews(client, sid, [`${task.id}:human:H1:1`, `${task.id}:graph:v3`]);
    await client.answerReview(sid, `${task.id}:graph:v3`, { action: "reject" });

    await vi.waitFor(() =>
      expect(recordLines(client, sid)).toStrictEqual(["task_graph: reject", "task_graph: reject"]),
    );
    expect(reviewRecords(client, sid).map((record) => record.verdict)).toStrictEqual([
      { action: "reject", reason: "too many steps" },
      { action: "reject" },
    ]);
    await client.prompt(sid, "what did I say?");
    await vi.waitFor(async () => {
      const last = JSON.stringify((await harness.contexts()).at(-1)?.messages);
      expect(last).toContain("task_graph_change taskId=");
      expect(last).toContain("The user's reason: too many steps");
    });
  });
});

describe("a task's sessions do not become ordinary tabs (T8 review fix 3)", () => {
  it("refuses to open, rename or archive the task conversation or a node's conversation, for the local client", async () => {
    const harness = await startTaskHost(
      { N1: [call("node_done", "d1", { ok: true, summary: "Looked." })] },
      { design: CHATTER },
    );
    const task = await startedTask(harness, [agent("N1", "explore"), human("H1")], edges(["N1", "H1"]));
    const { client } = harness;
    const passed = await harness.until(task.id, (now) => latestRunOf(now, "H1")?.state === "waiting");
    const nodeSession = present(latestRunOf(passed, "N1")?.sessionId, "the node's session");
    const layoutBefore = JSON.stringify(client.index.getState().layout);

    for (const sessionId of [task.taskSessionId, nodeSession]) {
      const gone = { code: "session_not_found", params: { sessionId } };
      expect(await failure(client.openSession(sessionId))).toStrictEqual(gone);
      expect(await failure(client.renameSession(sessionId, "my tab"))).toStrictEqual(gone);
      expect(await failure(client.archiveSession(sessionId))).toStrictEqual(gone);
    }

    // Nothing was opened, renamed or archived: still no tab, and the task still has its conversation.
    expect(JSON.stringify(client.index.getState().layout)).toBe(layoutBefore);
    expect(JSON.stringify(client.index.getState().layout)).not.toContain(task.taskSessionId);
    await client.watch([task.taskSessionId]);
    await client.openTaskSession(task.id, task.taskSessionId);
    await vi.waitFor(() => expect(client.session(task.taskSessionId)?.getState().status).toBe("ready"));
  });
});

describe("a message into a task conversation whose pi is not running (T8 review decision 4)", () => {
  it("starts its pi the way prompt always does, without open_task_session and without a tab", async () => {
    const harness = await startTaskHost({}, { design: CHATTER });
    const task = await startedTask(harness, [human("H1")], []);
    await harness.restart();
    const { client } = harness;
    const sid = task.taskSessionId;
    await client.watch([sid]);
    expect(client.session(sid)?.getState().status).not.toBe("ready");

    await client.prompt(sid, "where are we?");

    await vi.waitFor(() => expect(client.session(sid)?.getState().status).toBe("ready"));
    await vi.waitFor(() => {
      const items = JSON.stringify(client.session(sid)?.getState().items);
      expect(items).toContain("where are we?");
    });
    expect(JSON.stringify(client.index.getState().layout)).not.toContain(sid);
  });
});

/** The scripts of a work node that writes `out.txt`. */
const writing = [
  call("write", "w1", { path: "./out.txt", content: "from the task\n" }),
  call("node_done", "d1", { ok: true, summary: "Wrote out.txt." }),
];

/** The facts of the first review's evidence, as codes. */
function factCodes(review: PendingReview | undefined): string[] {
  return (review?.evidence ?? []).flatMap((one) => (one.kind === "facts" ? one.facts.map((fact) => fact.code) : []));
}

describe("the facts on a card are counted again when the task is opened (T8 review fix 11)", () => {
  it("shows a worktree edited while the human node waited the next time the task is opened", async () => {
    const harness = await startTaskHost({ N1: writing }, { design: CHATTER });
    const task = await startedTask(harness, [agent("N1", "work"), human("H")], edges(["N1", "H"]));
    const { client } = harness;
    const sid = task.taskSessionId;
    await client.watch([sid]);
    const id = `${task.id}:human:H:1`;
    const [open] = await seeReviews(client, sid, [id]);
    expect(factCodes(open)).toStrictEqual(["worktree_clean", "commits_ahead"]);

    // Edited while the card waits: nothing in the task changed, so no event tells the host.
    await writeFile(join(await harness.worktree(task.id), "loose.txt"), "not committed\n");
    await client.openTask(task.id);

    await vi.waitFor(
      () => expect(factCodes(controlReviews(client, sid)[0])).toStrictEqual(["worktree_dirty", "commits_ahead"]),
      { timeout: 30_000 },
    );
    expect(controlReviews(client, sid)[0]?.actions[0]).toMatchObject({ id: "pass", recommended: false });
  });
});

describe("what the protocol takes of a task with many waiting nodes (T8 review fix 4)", () => {
  it("gives the client sixteen reviews, oldest first, in the task and in the conversation's control, and keeps answering", async () => {
    const harness = await startTaskHost({}, { design: CHATTER });
    const nodes = Array.from({ length: 20 }, (_, index) => human(`H${String(index + 1).padStart(2, "0")}`));
    const task = await startedTask(harness, nodes, []);
    const { client } = harness;
    const sid = task.taskSessionId;
    await client.watch([sid]);

    // The client throws away what the protocol does not take, silently: the push is there only if it fits.
    await client.openTask(task.id);
    await vi.waitFor(() => expect(client.task(task.id).getState().task?.reviews).toHaveLength(16));
    const ids = (
      await seeReviews(
        client,
        sid,
        controlReviews(client, sid).map((review) => review.id),
      )
    ).map((review) => review.id);
    await vi.waitFor(() => expect(controlReviews(client, sid)).toHaveLength(16));
    expect(
      client
        .task(task.id)
        .getState()
        .task?.reviews.map((review) => review.id),
    ).toStrictEqual(ids);
    expect(new Set(ids).size).toBe(16);

    // One passes: the next in line takes its place.
    const first = present(ids[0], "the first review");
    await client.answerReview(sid, first, { action: "pass" });
    await vi.waitFor(() => expect(controlReviews(client, sid).map((review) => review.id)).not.toContain(first));
    await vi.waitFor(() => expect(controlReviews(client, sid)).toHaveLength(16));
  });
});
