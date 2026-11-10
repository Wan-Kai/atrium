import { HostMessage, PROTOCOL_VERSION, TaskView } from "@atrium/protocol";
import { WebSocket } from "ws";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { startTaskHost } from "../../test/task-harness";
import { edges, human } from "./test-support";

vi.setConfig({ testTimeout: 60_000 });

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/**
 * A raw client of the host's socket: says hello, sends commands and keeps what it receives.
 *
 * @remarks
 * The task commands have no client method yet (the board is T7), so this speaks the protocol itself and parses
 * what comes back with the protocol's own schema.
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

/** The result a response carried, which a test knows succeeded. */
function resultOf(response: Extract<HostMessage, { type: "response" }>): unknown {
  return Reflect.get(Object(response), "result");
}

describe("the task commands over the socket (SPEC-0006, T5)", () => {
  it("lists, opens and answers, and pushes the list and the open task to the connections that watch", async () => {
    const harness = await startTaskHost({});
    const task = await harness.start([human("H1"), human("H2")], edges(["H1", "H2"]));
    const client = await connect(harness.host.url, harness.host.token);

    const listed = await client.send({ type: "list_tasks", watch: true });
    const opened = await client.send({ type: "open_task", taskId: task.id });

    expect(listed).toMatchObject({
      ok: true,
      result: { tasks: [{ id: task.id, status: "waiting", attention: "human" }] },
    });
    expect(TaskView.parse(Reflect.get(Object(resultOf(opened)), "task"))).toMatchObject({
      id: task.id,
      nodes: [
        { id: "H1", state: "waiting" },
        { id: "H2", state: "pending" },
      ],
    });

    const answered = await client.send({ type: "answer_human", taskId: task.id, node: "H1", answer: { kind: "pass" } });

    expect(answered).toMatchObject({ ok: true, result: {} });
    await vi.waitFor(() => {
      expect(lastOf(client.received, "task_updated")?.task.nodes.map((node) => node.state)).toStrictEqual([
        "passed",
        "waiting",
      ]);
      expect(lastOf(client.received, "tasks_updated")?.tasks[0]?.id).toBe(task.id);
    });
    // The list's seq only goes up.
    const seqs = client.received.filter((message) => message.type === "tasks_updated").map((message) => message.seq);
    expect(seqs).toStrictEqual(seqs.toSorted((a, b) => a - b));
  });

  it("answers with the protocol's codes, and stops pushing once the watch is turned off", async () => {
    const harness = await startTaskHost({});
    const task = await harness.start([human("H1"), human("H2")], edges(["H1", "H2"]));
    const client = await connect(harness.host.url, harness.host.token);

    expect(await client.send({ type: "open_task", taskId: "tsk_missing" })).toMatchObject({
      ok: false,
      error: { code: "task_not_found" },
    });
    expect(
      await client.send({ type: "answer_human", taskId: task.id, node: "H2", answer: { kind: "pass" } }),
    ).toMatchObject({
      ok: false,
      error: { code: "task_state_invalid" },
    });
    await client.send({ type: "list_tasks", watch: true });
    await client.send({ type: "list_tasks", watch: false });
    await client.send({ type: "pause_task", taskId: task.id });
    await harness.host.host.tasks.idle();

    expect(harness.task(task.id).paused).toBe(true);
    expect(client.received.filter((message) => message.type === "tasks_updated")).toStrictEqual([]);
  });
});
