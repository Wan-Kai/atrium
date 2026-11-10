import type { AtriumClient } from "@atrium/client";
import { vi, describe, expect, it } from "vitest";
import { TASK_NAME, startTaskHost } from "../../test/task-harness";
import { agent, edges } from "./test-support";
import type { Task } from "./types";

vi.setConfig({ testTimeout: 90_000 });

/** How long to wait for what a real pi does. */
const LONG = { timeout: 60_000 };

const call = (name: string, id: string, args: Record<string, unknown>) => ({
  blocks: [{ type: "toolCall" as const, id, name, arguments: args as Record<string, never> }],
});
const say = (text: string) => ({ blocks: [{ type: "text" as const, text }] });
const done = (id: string, summary: string) => call("node_done", id, { ok: true, summary });

/** The progress lines in a conversation's items, as `what node`. */
function linesOf(client: AtriumClient, sessionId: string): string[] {
  const items = client.session(sessionId)?.getState().items ?? [];
  return items
    .filter((item) => item.kind === "notice")
    .flatMap((item) => (item.notice === "task_progress" ? [`${item.what ?? ""} ${item.node ?? ""}`.trim()] : []));
}

/** The ids of the tasks the marks in a conversation are about. */
function marksOf(client: AtriumClient, sessionId: string): string[] {
  const items = client.session(sessionId)?.getState().items ?? [];
  return items
    .filter((item) => item.kind === "notice")
    .flatMap((item) => (item.notice === "task_mark" ? [item.taskId] : []));
}

/** The first message of a conversation: what the user said in its first turn. */
function firstSaid(client: AtriumClient, sessionId: string): string {
  const items = client.session(sessionId)?.getState().items ?? [];
  return items.filter((item) => item.kind === "turn")[0]?.user.text ?? "";
}

/** Whether the conversation has named the task and proposed its first graph. */
function isDesigned(task: Task): boolean {
  return task.activeGraph === 1 && task.name === TASK_NAME;
}

/** The row of the list for a task. */
function rowOf(client: AtriumClient, taskId: string) {
  return client.tasks.getState().tasks.find((row) => row.id === taskId);
}

/** The states of a task's nodes, as the open task shows them. */
function statesOf(client: AtriumClient, taskId: string): string[] {
  return (client.task(taskId).getState().task?.nodes ?? []).map((node) => node.state);
}

describe("what the task area gets from a real host (SPEC-0006, T7)", () => {
  it("lists the task with where it is, opens it whole, and shows the task conversation and the source's mark through the ordinary subscription", async () => {
    const nodes = [agent("N1", "explore"), agent("N2", "work")];
    const harness = await startTaskHost(
      {
        N1: [done("d1", "Explored.")],
        N2: [call("write", "w1", { path: "./out.txt", content: "hello\n" }), done("d2", "Wrote out.txt.")],
      },
      {
        source: [say("Plan: write hello.")],
        design: [
          call("task_set_meta", "t1", { name: TASK_NAME }),
          call("task_propose_graph", "t2", {
            nodes,
            edges: edges(["N1", "N2"]),
            note: "two steps",
            guide: "feature",
          }),
          say("Two steps."),
        ],
      },
    );
    await harness.discuss();
    const { client } = harness;
    await client.watchTasks(true);
    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    const designed = await harness.until(taskId, isDesigned);

    // The list holds the designing task, with no node yet and the time something last happened.
    await vi.waitFor(() => expect(rowOf(client, taskId)?.status).toBe("designing"));
    expect(rowOf(client, taskId)).toMatchObject({
      status: "designing",
      current: null,
      scheduled: false,
      activeAt: expect.any(Number),
    });
    await client.openTask(taskId);
    expect(client.task(taskId).getState().task).toMatchObject({
      status: "designing",
      sourceSessionId: harness.origin,
      taskSessionId: designed.taskSessionId,
      model: { providerId: expect.any(String), modelId: expect.any(String), thinking: expect.any(String) },
      nodes: [
        { id: "N1", model: null },
        { id: "N2", model: null },
      ],
    });

    // The task conversation is watched by its id, though no list shows it.
    await client.watch([designed.taskSessionId]);
    await vi.waitFor(() => expect(client.session(designed.taskSessionId)?.getState().status).toBe("ready"));
    expect(firstSaid(client, designed.taskSessionId)).toContain("<atrium-task-design>");

    // Started, the run goes node by node and the lines arrive in the conversation as notices.
    await harness.host.host.tasks.start(taskId);
    await vi.waitFor(() => expect(rowOf(client, taskId)?.status).toBe("done"), LONG);
    await vi.waitFor(
      () =>
        expect(linesOf(client, designed.taskSessionId)).toStrictEqual(
          expect.arrayContaining(["node_started N1", "node_passed N1", "node_started N2", "node_passed N2"]),
        ),
      LONG,
    );
    await vi.waitFor(() => expect(statesOf(client, taskId)).toStrictEqual(["passed", "passed"]), LONG);

    // The conversation the task was made from carries the mark.
    await client.watch([harness.origin]);
    await vi.waitFor(() => expect(marksOf(client, harness.origin)).toStrictEqual([taskId]), LONG);
  });
});
