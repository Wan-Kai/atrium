import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CommandError, TaskView } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { TASK_NAME, startTaskHost } from "../../test/task-harness";
import { createTaskCommands } from "./task-commands";
import { agent, edges, human } from "./test-support";
import { newDesignTask } from "./new-task";
import type { GraphEdge, GraphNode, Task } from "./types";

vi.setConfig({ testTimeout: 90_000 });

/** A reply that calls a tool. */
const call = (name: string, id: string, args: Record<string, unknown>) => ({
  blocks: [{ type: "toolCall" as const, id, name, arguments: args as Record<string, never> }],
});

/** A reply that only talks. */
const say = (text: string) => ({ blocks: [{ type: "text" as const, text }] });

/** `node_done` with a summary. */
const done = (id: string, summary: string) => call("node_done", id, { ok: true, summary });

/** The summary the task conversation writes. */
const SUMMARY = {
  goal: "make out.txt",
  decisions: ["plain text"],
  constraints: [],
  nonGoals: [],
  openQuestions: [],
  acceptance: ["out.txt says hello"],
};

/** A graph as the conversation's tool takes it. */
const graph = (nodes: readonly GraphNode[], graphEdges: readonly GraphEdge[]) => ({
  nodes: nodes as unknown as Record<string, never>[],
  edges: graphEdges as unknown as Record<string, never>[],
});

/** Whether the conversation has named the task and proposed its first graph. */
function isDesigned(task: Task): boolean {
  return task.activeGraph === 1 && task.name === TASK_NAME;
}

/** Whether the human node H1 is waiting. */
function humanWaits(task: Task): boolean {
  return task.runs.some((run) => run.node === "H1" && run.state === "waiting");
}

/**
 * The index's record of a session, read from the host's files.
 *
 * @remarks
 * Task conversations are in no list the client sees, so the record is the place to look.
 *
 * @sideEffects Reads files.
 * @param home - The host's home.
 * @param sessionId - The session.
 * @returns The record, or `undefined`.
 */
async function recordOf(home: string, sessionId: string): Promise<{ archived?: boolean } | undefined> {
  const file = (await readdir(home, { recursive: true })).find((name) => name.endsWith("sessions.json"));
  const index = JSON.parse(await readFile(join(home, file ?? "sessions.json"), "utf8")) as {
    sessions: { sessionId: string; archived?: boolean }[];
  };
  return index.sessions.find((one) => one.sessionId === sessionId);
}

/** What a failed command throws, as its code and parameters. */
async function codeOf(work: Promise<unknown>): Promise<{ code: string; params: unknown }> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CommandError)) throw new Error("expected a CommandError");
  return { code: error.code, params: error.params };
}

describe("a task made from a conversation runs to the end (SPEC-0006, T6)", () => {
  it("/task: reads the source, writes the summary, proposes a graph by a guide; started, it runs to done; the lines are written", async () => {
    const nodes = [agent("N1", "explore"), agent("N2", "work"), agent("N3", "check")];
    const harness = await startTaskHost(
      {
        N1: [done("d1", "Explored.")],
        N2: [call("write", "w1", { path: "./out.txt", content: "hello\n" }), done("d2", "Wrote out.txt.")],
        N3: [call("bash", "b1", { command: "cat out.txt" }), done("d3", "It prints hello.")],
      },
      {
        source: [say("Plan: write hello into out.txt.")],
        design: [
          call("task_read_source", "t1", {}),
          call("task_set_summary", "t2", { summary: SUMMARY }),
          call("task_set_meta", "t3", { name: TASK_NAME }),
          call("task_propose_graph", "t4", {
            ...graph(nodes, edges(["N1", "N2"], ["N2", "N3"])),
            note: "three steps",
            guide: "feature",
          }),
          say("I used the feature guide: explore, write, check. Nothing is open."),
        ],
      },
    );
    await harness.discuss();

    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, "only out.txt");
    const designed = await harness.until(taskId, isDesigned);

    expect(designed).toMatchObject({
      guide: { id: "feature", version: 1 },
      summary: SUMMARY,
      origin: { kind: "chat", sessionId: harness.origin },
      projectId: expect.any(String),
      ownsWorkspace: true,
      startedAt: null,
    });
    // The board can show it: a designing task with the graph the conversation proposed.
    const view = TaskView.parse(await harness.host.host.tasks.view(taskId, new AbortController().signal));
    expect(view).toMatchObject({ status: "designing", pendingGraph: false, graphVersion: 1 });
    expect(view.nodes.map((node) => node.id)).toStrictEqual(["N1", "N2", "N3"]);
    // The conversation read the source: its tool result held the discussion, quoted.
    const contexts = await harness.contexts();
    const design = contexts.findLast((context) => JSON.stringify(context.messages).includes("<atrium-task-design>"));
    expect(design?.tools).toStrictEqual(
      expect.arrayContaining(["read", "task_read_source", "task_propose_graph", "ask_user"]),
    );
    expect(design?.tools).not.toContain("write");
    expect(design?.tools).not.toContain("agent_spawn");
    const text = JSON.stringify(design?.messages);
    expect(text).toContain("only out.txt");
    expect(text).toContain("Plan: write hello into out.txt.");
    expect(text).toContain('<atrium-quoted from=\\"来源对话\\">');
    // The source conversation was marked, in its own file.
    await vi.waitFor(async () => {
      expect(await harness.fileText(harness.origin)).toContain(`"kind":"converted"`);
    });
    expect(await harness.fileText(harness.origin)).toContain(taskId);

    await harness.host.host.tasks.start(taskId);
    const finished = await harness.until(taskId, (now) => now.endedAt !== null);

    expect(finished.runs.map((run) => [run.node, run.state])).toStrictEqual([
      ["N1", "passed"],
      ["N2", "passed"],
      ["N3", "passed"],
    ]);
    // The progress lines of the run are in the task conversation's file, without a model call for them.
    await vi.waitFor(async () => {
      const lines = (await harness.fileText(finished.taskSessionId))
        .split("\n")
        .filter((line) => line.includes('"kind":"progress"'));
      const whats = lines.map((line) => /"what":"([a-z_]+)"/u.exec(line)?.[1]);
      expect(whats).toStrictEqual(expect.arrayContaining(["node_started", "node_passed", "workspace_ready"]));
    });
  });

  it("a node's request_graph_change wakes the conversation, which proposes a graph; approved, the node goes on and the task ends", async () => {
    const harness = await startTaskHost(
      {
        N1: [done("d1", "first")],
        N2: [
          call("request_graph_change", "g1", { reason: "A check step is missing.", suggestion: "Add N3 after N2." }),
          done("d2", "N2 done after the change"),
        ],
        N3: [done("d3", "checked")],
      },
      {
        design: [
          call("task_set_meta", "t1", { name: TASK_NAME }),
          call("task_propose_graph", "t2", {
            ...graph([agent("N1"), agent("N2")], edges(["N1", "N2"])),
            note: "two steps",
            guide: "research",
          }),
          say("Two steps."),
          // Woken by N2.
          call("task_status", "t3", {}),
          call("task_propose_graph", "t4", {
            ...graph([agent("N1"), agent("N2"), agent("N3")], edges(["N1", "N2"], ["N2", "N3"])),
            note: "add N3",
          }),
          say("Proposed N3 after N2; please approve."),
        ],
      },
    );
    await harness.discuss();
    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    await harness.until(taskId, isDesigned);
    await harness.host.host.tasks.start(taskId);

    const waiting = await harness.until(taskId, (now) => now.pendingGraph !== null);

    expect(waiting.runs.find((run) => run.node === "N2")).toMatchObject({
      state: "waiting",
      waitingFor: "graph_change",
    });
    expect(waiting.graphs).toHaveLength(2);
    expect(waiting.activeGraph).toBe(1);
    // The conversation was woken with the node's words, quoted.
    const woken = (await harness.contexts()).findLast((context) =>
      JSON.stringify(context.messages).includes('reason=\\"wake\\"'),
    );
    const wakeText = JSON.stringify(woken?.messages);
    expect(wakeText).toContain("A check step is missing.");
    expect(wakeText).toContain('<atrium-quoted from=\\"N2 · node N2\\">');

    await harness.host.host.tasks.approveGraph(taskId);
    const finished = await harness.until(taskId, (now) => now.endedAt !== null);

    expect(finished.activeGraph).toBe(2);
    expect(finished.pendingGraph).toBeNull();
    expect(finished.runs.map((run) => [run.node, run.state])).toStrictEqual([
      ["N1", "passed"],
      ["N2", "passed"],
      ["N3", "passed"],
    ]);
    expect(finished.runs.find((run) => run.node === "N2")?.summary).toBe("N2 done after the change");
  });

  it("a graph rejected leaves the node to go on with the old one", async () => {
    const harness = await startTaskHost(
      {
        N1: [call("request_graph_change", "g1", { reason: "More?", suggestion: "Add N2." }), done("d1", "kept going")],
      },
      {
        design: [
          call("task_set_meta", "t1", { name: TASK_NAME }),
          call("task_propose_graph", "t2", { ...graph([agent("N1")], []), note: "one step" }),
          say("One step."),
          call("task_propose_graph", "t3", {
            ...graph([agent("N1"), agent("N2")], edges(["N1", "N2"])),
            note: "add N2",
          }),
          say("Proposed."),
        ],
      },
    );
    await harness.discuss();
    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    await harness.until(taskId, isDesigned);
    await harness.host.host.tasks.start(taskId);
    await harness.until(taskId, (now) => now.pendingGraph !== null);

    await harness.host.host.tasks.rejectGraph(taskId);
    const finished = await harness.until(taskId, (now) => now.endedAt !== null);

    expect(finished.activeGraph).toBe(1);
    expect(finished.runs).toHaveLength(1);
    expect(finished.runs[0]).toMatchObject({ state: "passed", summary: "kept going" });
  });
});

describe("one conversation, one task (SPEC-0006, T6)", () => {
  it("answers task_already_converted with the task's id, until the task is abandoned; then /task works again", async () => {
    const harness = await startTaskHost({}, { design: [say("Waiting for you.")] });
    await harness.discuss();
    const first = await harness.host.host.tasks.createFromChat(harness.origin, undefined);

    expect(await codeOf(harness.host.host.tasks.createFromChat(harness.origin, "again"))).toStrictEqual({
      code: "task_already_converted",
      params: { taskId: first.taskId },
    });

    const before = harness.task(first.taskId);
    await harness.host.host.tasks.abandon(first.taskId);

    // The record is gone from memory and from disk, and the conversation is archived.
    expect(harness.host.host.tasks.task(first.taskId)).toBeUndefined();
    expect(await readdir(join(harness.home, "tasks"))).toStrictEqual([]);
    expect(await harness.host.host.tasks.list()).toStrictEqual([]);
    await vi.waitFor(async () => {
      expect(await recordOf(harness.home, before.taskSessionId)).toMatchObject({ archived: true });
    });
    // The source conversation says so in a second line.
    await vi.waitFor(async () => {
      expect(await harness.fileText(harness.origin)).toContain('"state":"abandoned"');
    });

    const second = await harness.host.host.tasks.createFromChat(harness.origin, undefined);

    expect(second.taskId).not.toBe(first.taskId);
    expect(harness.task(second.taskId)).toMatchObject({
      origin: { kind: "chat", sessionId: harness.origin },
      startedAt: null,
    });
  });

  it("tells a connection watching the list the task is gone after an abandon, without a warning for the task it had open", async () => {
    const harness = await startTaskHost({}, { design: [say("Waiting for you.")] });
    await harness.discuss();
    const { records, logger } = recordingTracing();
    const sent: { type: string; tasks?: { id: string }[] }[] = [];
    const commands = createTaskCommands({
      service: harness.host.host.tasks,
      send: (_connection, event) => sent.push(event),
      logger,
    });
    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    await commands.list("c1", true);
    await commands.open("c1", taskId);

    await commands.abandon(taskId);
    await commands.close();

    const lists = sent.filter((event) => event.type === "tasks_updated");
    expect(lists.at(-1)?.tasks).toStrictEqual([]);
    expect(records.filter((record) => record["level"] === "warn")).toStrictEqual([]);
  });

  it("does not count a record that a crash left between abandoning and deleting it", async () => {
    const harness = await startTaskHost({}, { design: [say("Waiting for you.")] });
    await harness.discuss();
    const first = await harness.host.host.tasks.createFromChat(harness.origin, undefined);

    // The `abandoned` event is recorded; the files were never removed.
    await harness.send(first.taskId, { type: "abandoned" });

    expect(await harness.host.host.tasks.list()).toStrictEqual([]);
    const second = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    expect(second.taskId).not.toBe(first.taskId);
  });

  it("a task that started stays the conversation's task: cancelled, it still answers task_already_converted", async () => {
    const harness = await startTaskHost(
      { N1: [done("d1", "x")] },
      {
        design: [
          call("task_set_meta", "t1", { name: TASK_NAME }),
          call("task_propose_graph", "t2", { ...graph([human("H1")], []), note: "wait" }),
          say("Waits for you."),
        ],
      },
    );
    await harness.discuss();
    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    await harness.until(taskId, (now) => now.activeGraph === 1);
    await harness.host.host.tasks.start(taskId);
    await harness.host.host.tasks.cancel(taskId);

    expect(await codeOf(harness.host.host.tasks.createFromChat(harness.origin, undefined))).toStrictEqual({
      code: "task_already_converted",
      params: { taskId },
    });
    expect(await codeOf(harness.host.host.tasks.abandon(taskId))).toMatchObject({ code: "task_state_invalid" });
  });

  it("refuses a conversation the host does not know", async () => {
    const harness = await startTaskHost({});

    expect(await codeOf(harness.host.host.tasks.createFromChat("ses_nobody", undefined))).toMatchObject({
      code: "session_not_found",
    });
  });
});

describe("start and the approval check the graph again (SPEC-0006, T6)", () => {
  it("refuses to start a task with no graph, a graph that breaks a rule, or work in a task outside any project", async () => {
    const harness = await startTaskHost({}, { design: [say("Thinking.")] });
    await harness.discuss();
    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    await harness.until(taskId, (now) => now.runs.length === 0);

    // Not proposed yet: nothing to start.
    expect(await codeOf(harness.host.host.tasks.start(taskId))).toMatchObject({ code: "task_state_invalid" });

    // A graph the tool would have refused, put in by hand: the start checks it again.
    await harness.send(taskId, {
      type: "graph_proposed",
      author: "agent",
      note: "",
      nodes: [agent("N1")],
      edges: edges(["N1", "N1"]),
    });
    expect(await codeOf(harness.host.host.tasks.start(taskId))).toStrictEqual({
      code: "task_graph_invalid",
      params: { code: "seq_cycle" },
    });
    expect(harness.task(taskId).startedAt).toBeNull();

    // Without a project there is no worktree, so work has no place to be.
    const lone: Task = newDesignTask({
      id: "tsk_lone",
      name: "lone",
      projectId: null,
      sourceDir: harness.repo,
      originSessionId: "ses_elsewhere",
      taskSessionId: "ses_task_lone",
      model: { providerId: "faux", modelId: "faux-1", thinking: "off" },
      borrowed: null,
      now: Date.now(),
    });
    await harness.host.host.tasks.create(lone);
    await harness.send("tsk_lone", {
      type: "graph_proposed",
      author: "agent",
      note: "",
      nodes: [agent("N1", "work")],
      edges: [],
    });
    expect(await codeOf(harness.host.host.tasks.start("tsk_lone"))).toStrictEqual({
      code: "task_no_project_for_work",
      params: undefined,
    });
  });

  it("refuses approve and reject without a pending graph, before the start and after the end", async () => {
    const harness = await startTaskHost({}, { design: [say("Thinking.")] });
    await harness.discuss();
    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    await harness.send(taskId, { type: "graph_proposed", author: "agent", note: "", nodes: [human("H1")], edges: [] });

    expect(await codeOf(harness.host.host.tasks.approveGraph(taskId))).toMatchObject({ code: "task_state_invalid" });
    expect(await codeOf(harness.host.host.tasks.rejectGraph(taskId))).toMatchObject({ code: "task_state_invalid" });
    await harness.host.host.tasks.start(taskId);
    expect(await codeOf(harness.host.host.tasks.approveGraph(taskId))).toMatchObject({ code: "task_state_invalid" });
    expect(await codeOf(harness.host.host.tasks.rejectGraph(taskId))).toMatchObject({ code: "task_state_invalid" });
  });

  it("refuses to approve a pending graph that no longer fits what has run", async () => {
    const harness = await startTaskHost({ N1: [done("d1", "x")] }, { design: [say("Thinking.")] });
    await harness.discuss();
    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    await harness.send(taskId, { type: "meta_changed", name: TASK_NAME });
    await harness.send(taskId, {
      type: "graph_proposed",
      author: "agent",
      note: "",
      nodes: [agent("N1"), human("H1")],
      edges: edges(["N1", "H1"]),
    });
    await harness.host.host.tasks.start(taskId);
    await harness.until(taskId, humanWaits);
    // N1 has run; a pending graph that changes it is not allowed to take effect.
    await harness.send(taskId, {
      type: "graph_proposed",
      author: "agent",
      note: "",
      nodes: [agent("N1", "explore", { job: "changed" }), human("H1")],
      edges: edges(["N1", "H1"]),
    });

    expect(await codeOf(harness.host.host.tasks.approveGraph(taskId))).toStrictEqual({
      code: "task_graph_invalid",
      params: { code: "node_changed", node: "N1" },
    });
    await harness.host.host.tasks.rejectGraph(taskId);
    expect(harness.task(taskId).pendingGraph).toBeNull();
  });
});
