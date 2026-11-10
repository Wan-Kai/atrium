import { HostMessage, PROTOCOL_VERSION, TaskView } from "@atrium/protocol";
import { createTempDir } from "@atrium/testkit";
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { startTestHost } from "../../test/harness";
import { FOLLOWED_STEPS, countOf, fingerprint, followedTask, writeTask } from "./follow-support";
import { newTaskRecord } from "./new-task";
import { agent, edges, human } from "./test-support";

vi.setConfig({ testTimeout: 30_000 });

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/**
 * A raw client of the host's socket: says hello, sends commands and keeps what it receives.
 *
 * @remarks
 * The client package has no methods for the task commands, so this speaks the protocol itself and parses what
 * comes back with the protocol's own schema.
 *
 * @sideEffects Opens a socket, closed when the test finishes.
 * @param url - The host's address.
 * @param token - The host's token.
 * @returns A way to send a command and wait for its response, and the pushes received.
 */
async function connect(url: string, token: string) {
  const socket = new WebSocket(url);
  onTestFinished(() => socket.close());
  const received: HostMessage[] = [];
  socket.on("message", (data: Buffer) => {
    received.push(HostMessage.parse(JSON.parse(data.toString("utf8"))));
  });
  await new Promise<void>((done) => socket.once("open", () => done()));
  socket.send(
    JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, clientId: "raw", token, traceparent }),
  );
  await vi.waitFor(() => expect(received.some((message) => message.type === "welcome")).toBe(true));
  let counter = 0;
  return {
    received,
    async send(command: Record<string, unknown>) {
      counter += 1;
      const requestId = `r${String(counter)}`;
      socket.send(JSON.stringify({ ...command, requestId, traceparent }));
      return vi.waitFor(() => {
        const found = received.find((message) => message.type === "response" && message.requestId === requestId);
        if (found?.type !== "response") throw new Error("no response yet");
        return found;
      });
    },
  };
}

/** The last message of a type among those received. */
function lastOf<T extends HostMessage["type"]>(received: readonly HostMessage[], type: T) {
  return received.findLast((message): message is Extract<HostMessage, { type: T }> => message.type === type);
}

/** The task a response to `open_task` carried. */
function viewOf(response: Extract<HostMessage, { type: "response" }>): TaskView {
  return TaskView.parse(Reflect.get(Object(Reflect.get(Object(response), "result")), "task"));
}

/**
 * A host that follows a directory a second writer appends to.
 *
 * @remarks
 * `before` writes what is in the directory when the host starts, the way a `task:try` run that began first would.
 *
 * @sideEffects Creates a temporary directory and starts a host, both removed when the test finishes.
 * @param before - Writes into the directory before the host starts, and gives back what the test needs of it.
 * @returns The directory, the host, its home and what `before` gave.
 */
async function followingHost<T>(before: (directory: string) => Promise<T>) {
  const followed = await createTempDir("followed-tasks");
  onTestFinished(followed.cleanup);
  const tasks = join(followed.path, "tasks");
  await mkdir(tasks);
  const prepared = await before(tasks);
  const home = await createTempDir("followed-own-home");
  onTestFinished(home.cleanup);
  const host = await startTestHost({ home: home.path, followTasks: tasks });
  onTestFinished(host.dispose);
  return { tasks, host, home: home.path, prepared };
}

describe("tasks followed read-only (SPEC-0006, T7.1)", () => {
  it("lists a followed task like an own one and pushes its nodes' states as the writer appends", async () => {
    const { host, prepared: writer } = await followingHost((directory) =>
      writeTask(directory, followedTask("tsk_try")),
    );
    await host.host.tasks.create(
      newTaskRecord({
        id: "tsk_own",
        name: "own",
        projectId: null,
        sourceDir: "/x",
        originSessionId: "s",
        taskSessionId: "ses_own",
        model: { providerId: "faux", modelId: "faux-1", thinking: "off" },
        goal: "g",
        nodes: [agent("N1"), human("H1")],
        edges: edges(["N1", "H1"]),
        now: 1,
      }),
    );
    const client = await connect(host.url, host.token);

    const listed = await client.send({ type: "list_tasks", watch: true });
    const opened = await client.send({ type: "open_task", taskId: "tsk_try" });
    const own = await client.send({ type: "open_task", taskId: "tsk_own" });
    await client.send({ type: "open_task", taskId: "tsk_try" });

    expect(listed).toMatchObject({ ok: true });
    expect(Reflect.get(Object(Reflect.get(Object(listed), "result")), "tasks")).toMatchObject([
      { id: "tsk_own", status: "designing" },
      { id: "tsk_try", status: "designing", name: "followed tsk_try" },
    ]);
    // The source conversation lives in the other process's home: no link to open.
    expect(viewOf(opened)).toMatchObject({ id: "tsk_try", followed: true, archiveFacts: null, sourceSessionId: null });
    expect(viewOf(own)).toMatchObject({ id: "tsk_own", followed: false, sourceSessionId: "s" });

    for (const step of FOLLOWED_STEPS.slice(0, 4)) await writer.record(step);
    await vi.waitFor(() =>
      expect(
        lastOf(client.received, "task_updated")?.task.nodes.map((node) => `${node.id}:${node.state}`),
      ).toStrictEqual(["N1:passed", "N2:running", "H1:pending"]),
    );
    expect(lastOf(client.received, "task_updated")?.task.followed).toBe(true);
    for (const step of FOLLOWED_STEPS.slice(4)) await writer.record(step);
    await vi.waitFor(() =>
      expect(
        lastOf(client.received, "task_updated")?.task.nodes.map((node) => `${node.id}:${node.state}`),
      ).toStrictEqual(["N1:passed", "N2:passed", "H1:waiting"]),
    );
    await vi.waitFor(() =>
      expect(lastOf(client.received, "tasks_updated")?.tasks.find((task) => task.id === "tsk_try")).toMatchObject({
        status: "waiting",
        attention: "human",
        current: { id: "H1", state: "waiting" },
      }),
    );
  });

  it("answers task_read_only to every command that would change a followed task, and writes nothing", async () => {
    const { tasks, host, home } = await followingHost(async (directory) => {
      const writer = await writeTask(directory, followedTask("tsk_try"));
      for (const step of FOLLOWED_STEPS) await writer.record(step);
    });
    const client = await connect(host.url, host.token);
    await client.send({ type: "list_tasks" });
    const before = await fingerprint(tasks);

    const commands: Record<string, unknown>[] = [
      { type: "answer_human", taskId: "tsk_try", node: "H1", answer: { kind: "pass" } },
      { type: "answer_human", taskId: "tsk_try", node: "H1", answer: { kind: "send_back", backTo: "N1", reason: "r" } },
      { type: "rerun_node", taskId: "tsk_try", node: "N1" },
      { type: "continue_node", taskId: "tsk_try", node: "N1" },
      { type: "pause_task", taskId: "tsk_try" },
      { type: "resume_task", taskId: "tsk_try" },
      { type: "cancel_task", taskId: "tsk_try" },
      { type: "start_task", taskId: "tsk_try" },
      { type: "abandon_task", taskId: "tsk_try" },
      { type: "approve_graph", taskId: "tsk_try" },
      { type: "reject_graph", taskId: "tsk_try" },
      { type: "answer_archive", taskId: "tsk_try", answer: "archive" },
      { type: "open_task_session", taskId: "tsk_try", sessionId: "ses_try_task" },
    ];
    const answers: unknown[] = [];
    for (const command of commands) answers.push([command["type"], await client.send(command)]);
    expect(answers).toMatchObject(
      commands.map((command) => [command["type"], { ok: false, error: { code: "task_read_only" } }]),
    );
    await expect(host.host.tasks.recover("tsk_try")).rejects.toMatchObject({ code: "task_read_only" });
    await expect(host.host.tasks.submit("tsk_try", { type: "paused" })).rejects.toMatchObject({
      code: "task_read_only",
    });

    // A task the host does not know is still not found, not read-only.
    expect(await client.send({ type: "rerun_node", taskId: "tsk_nobody", node: "N1" })).toMatchObject({
      ok: false,
      error: { code: "task_not_found" },
    });
    expect(await fingerprint(tasks)).toStrictEqual(before);
    // Nothing of it was taken up as an own task: the host's own tasks directory has no entry for it.
    expect(await readdir(join(home, "tasks")).catch(() => [])).not.toContain("tsk_try");
    expect(countOf(host.host.resources.snapshot(), "session.controller")).toBe(0);
  });

  it("shows a followed task no reviews to answer, and a verdict on its conversation finds nothing open and writes nothing (ADR-0018)", async () => {
    const { tasks, host } = await followingHost(async (directory) => {
      const writer = await writeTask(directory, followedTask("tsk_try"));
      for (const step of FOLLOWED_STEPS) await writer.record(step);
    });
    const client = await connect(host.url, host.token);
    await client.send({ type: "list_tasks" });
    const opened = viewOf(await client.send({ type: "open_task", taskId: "tsk_try" }));
    const before = await fingerprint(tasks);

    const answered = await client.send({
      type: "answer_review",
      sessionId: "ses_try_task",
      reviewId: "tsk_try:human:H1:1",
      verdict: { action: "pass" },
    });

    // H1 waits, and an own task in that state would have a review for it; a followed one has none.
    expect(opened).toMatchObject({ followed: true, attention: "human", reviews: [] });
    expect(answered).toMatchObject({ ok: false, error: { code: "review_closed" } });
    expect(await fingerprint(tasks)).toStrictEqual(before);
  });

  it("does not run, start or record anything for a followed task, even one that is running and waiting", async () => {
    const { tasks, host } = await followingHost(async (directory) => {
      const writer = await writeTask(directory, followedTask("tsk_try"));
      await writer.record({ type: "started" });
    });
    const before = await fingerprint(tasks);

    // Long enough for a scheduler that was running to have asked pi for the node.
    await new Promise((done) => setTimeout(done, 400));
    await host.host.tasks.list();
    await host.host.tasks.idle();

    expect(await fingerprint(tasks)).toStrictEqual(before);
    expect(countOf(host.host.resources.snapshot(), "session.controller")).toBe(0);
    expect(host.host.tasks.held().map((task) => task.id)).toStrictEqual(["tsk_try"]);
  });

  it("leaves the directory byte for byte as it was while the writer leaves a half line", async () => {
    const { tasks, host } = await followingHost(async (directory) => {
      const writer = await writeTask(directory, followedTask("tsk_try"));
      await writer.record({ type: "started" });
    });
    const client = await connect(host.url, host.token);
    await client.send({ type: "list_tasks", watch: true });
    await client.send({ type: "open_task", taskId: "tsk_try" });
    await appendFile(join(tasks, "tsk_try", "events.jsonl"), '{"seq":3,"at":9,"type":"node_sta');
    const before = await fingerprint(tasks);

    await new Promise((done) => setTimeout(done, 500));
    const view = await client.send({ type: "open_task", taskId: "tsk_try" });

    expect(viewOf(view).nodes.map((node) => `${node.id}:${node.state}`)).toStrictEqual([
      "N1:running",
      "N2:pending",
      "H1:pending",
    ]);
    expect(await fingerprint(tasks)).toStrictEqual(before);
  });

  it("lets an own task win an id a followed one has, in the list, the view and the commands", async () => {
    const { host } = await followingHost(async (directory) => {
      await writeTask(directory, followedTask("tsk_same"));
    });
    const client = await connect(host.url, host.token);
    await vi.waitFor(async () => {
      const listed = await client.send({ type: "list_tasks" });
      expect(Reflect.get(Object(Reflect.get(Object(listed), "result")), "tasks")).toHaveLength(1);
    });
    expect(viewOf(await client.send({ type: "open_task", taskId: "tsk_same" })).followed).toBe(true);

    await host.host.tasks.create(
      newTaskRecord({
        id: "tsk_same",
        name: "own",
        projectId: null,
        sourceDir: "/x",
        originSessionId: "s",
        taskSessionId: "ses_own",
        model: { providerId: "faux", modelId: "faux-1", thinking: "off" },
        goal: "g",
        nodes: [agent("N1")],
        edges: [],
        now: 1,
      }),
    );

    const listed = await client.send({ type: "list_tasks" });
    expect(Reflect.get(Object(Reflect.get(Object(listed), "result")), "tasks")).toMatchObject([
      { id: "tsk_same", name: "own" },
    ]);
    expect(viewOf(await client.send({ type: "open_task", taskId: "tsk_same" }))).toMatchObject({
      name: "own",
      followed: false,
    });
    // An own task's commands are not refused as read-only: the state is what fails.
    expect(await client.send({ type: "rerun_node", taskId: "tsk_same", node: "N1" })).toMatchObject({
      ok: false,
      error: { code: "task_state_invalid" },
    });
  });

  it("warns and goes on when the directory is not there, and follows once it is", async () => {
    const followed = await createTempDir("followed-missing");
    onTestFinished(followed.cleanup);
    const tasks = join(followed.path, "tasks");
    const host = await startTestHost({ followTasks: tasks });
    onTestFinished(host.dispose);
    host.expectLog({ level: "warn", msg: "task follow unavailable", times: 1 });
    const client = await connect(host.url, host.token);

    expect(await client.send({ type: "list_tasks" })).toMatchObject({ ok: true, result: { tasks: [] } });
    await mkdir(tasks);
    await writeTask(tasks, followedTask("tsk_try"));

    await vi.waitFor(
      async () => {
        const listed = await client.send({ type: "list_tasks" });
        expect(Reflect.get(Object(Reflect.get(Object(listed), "result")), "tasks")).toMatchObject([{ id: "tsk_try" }]);
      },
      { timeout: 15_000 },
    );
  });

  it("drops a task from the list when its directory is removed", async () => {
    const { tasks, host } = await followingHost(async (directory) => {
      await writeTask(directory, followedTask("tsk_try"));
    });
    const client = await connect(host.url, host.token);
    await client.send({ type: "list_tasks", watch: true });

    await rm(join(tasks, "tsk_try"), { recursive: true });

    await vi.waitFor(() => expect(lastOf(client.received, "tasks_updated")?.tasks).toStrictEqual([]));
  });

  it("refuses to follow its own tasks directory", async () => {
    const own = await createTempDir("own-home");
    onTestFinished(own.cleanup);
    const host = await startTestHost({ home: own.path, followTasks: join(own.path, "tasks") });
    onTestFinished(host.dispose);
    host.expectLog({ level: "warn", msg: "task follow refused: it is the host's own tasks directory", times: 1 });

    expect(countOf(host.host.resources.snapshot(), "task.follow.watch")).toBe(0);
  });
});
