import type { AtriumClient } from "@atrium/client";
import { type HostMessage, PROTOCOL_VERSION } from "@atrium/protocol";
import { createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { type TestHost, startTestHost } from "../test/harness";

/** Rounds in a batch; with a pause after each, a client stays under the host's 200 messages a second. */
const BATCH = 50;
const BATCHES = 4;
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
});

/**
 * Node's live child processes, pipes, sockets and timers, apart from the host's own counts.
 *
 * @remarks
 * A count released without `clearTimeout`, or a child whose pipes stay open, shows up only here
 * (testing.md, "泄漏测试").
 *
 * @sideEffects none
 * @returns The counts by kind.
 */
function liveHandles(): Record<"ProcessWrap" | "PipeWrap" | "TCPWrap" | "Timeout", number> {
  const resources = process.getActiveResourcesInfo();
  const count = (kind: string): number => resources.filter((resource) => resource === kind).length;
  return {
    ProcessWrap: count("ProcessWrap"),
    PipeWrap: count("PipeWrap"),
    TCPWrap: count("TCPWrap"),
    Timeout: count("Timeout"),
  };
}

/**
 * The pids of the processes this test process started that still run, `ps` itself aside.
 *
 * @remarks
 * pi leads its own process group but stays this process's child until it exits.
 *
 * @sideEffects Runs `ps`.
 * @returns The pids, sorted.
 */
function children(): number[] {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, comm]) => Number(ppid) === process.pid && comm !== "ps")
    .map(([pid]) => Number(pid))
    .toSorted((a, b) => a - b);
}

/**
 * A host whose pi is a scripted one, and a client connected to it.
 *
 * @remarks
 * Each message starts a run that goes on until stopped; a stop ends it. The host names each
 * session itself, so the id pi reports goes unused.
 *
 * @sideEffects Creates temporary directories; starts a host.
 * @returns The host and the client.
 */
async function sessionsHost(): Promise<{ readonly host: TestHost; readonly client: AtriumClient }> {
  const bin = await createTempDir("leak-bin");
  onTestFinished(bin.cleanup);
  const scripted = await writeScriptedPi(
    bin.path,
    {
      rules: {
        get_state: { data: { sessionId: "pi-session-1" } },
        get_entries: { data: { entries: [], leafId: null } },
        prompt: { data: { disposition: "started" }, events: [{ type: "agent_start" }] },
        abort: { data: {}, events: [{ type: "agent_settled" }] },
      },
    },
    "pi",
  );
  testHost = await startTestHost({ logLevel: "warn", toolEnv: { PATH: `${bin.path}:/usr/bin:/bin`, ...scripted.env } });
  await testHost.host.tools;
  const client = testHost.connect();
  expect(await client.connect()).toMatchObject({ status: "connected" });
  return { host: testHost, client };
}

/**
 * Waits until the host's counts and Node's handles are back to where they were.
 *
 * @remarks
 * Kinds that first appeared after the baseline must be back to zero. Node's handles are read with
 * a timer of our own running, hence at most one more `Timeout` than before.
 *
 * @sideEffects Waits.
 * @param host - The host.
 * @param before - Its counts before.
 * @param handles - Node's handles before.
 * @param processes - The child processes before.
 */
async function backToBaseline(
  host: TestHost,
  before: Readonly<Record<string, number>>,
  handles: ReturnType<typeof liveHandles>,
  processes: readonly number[],
): Promise<void> {
  const appeared = Object.keys(host.host.resources.snapshot()).filter((kind) => !(kind in before));
  const expected = { ...before, ...Object.fromEntries(appeared.map((kind) => [kind, 0])) };
  await vi.waitFor(() => expect(host.host.resources.snapshot()).toStrictEqual(expected), { timeout: 10_000 });
  await vi.waitFor(() => expect(children()).toStrictEqual(processes), { timeout: 10_000 });
  await vi.waitFor(
    () => {
      const after = liveHandles();
      expect({ ...after, Timeout: Math.min(after.Timeout, handles.Timeout) }).toStrictEqual(handles);
    },
    { timeout: 10_000 },
  );
}

/**
 * The counts and handles once the host has nothing pending.
 *
 * @remarks
 * The list's push, a run's reads and the host's first look at the workspaces end within a moment;
 * until then their timers and git processes count. Four timers stay: the next resource report,
 * the background fetch, the daily look for the latest pi, and the client's heartbeat.
 *
 * @sideEffects Waits.
 * @param host - The host.
 * @returns The host's counts, Node's handles and the child processes.
 */
async function baseline(host: TestHost) {
  await vi.waitFor(() => {
    const now = host.host.resources.snapshot();
    expect([now["timer"], now["git.process"] ?? 0]).toStrictEqual([4, 0]);
  });
  return { before: host.host.resources.snapshot(), handles: liveHandles(), processes: children() };
}

/**
 * Waits a little over a second.
 *
 * @remarks
 * Lets the host's message window pass between batches.
 *
 * @sideEffects Waits.
 */
async function pause(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_100));
}

/**
 * Connects a socket that subscribes to the list and a session, then drops it without closing.
 *
 * @remarks
 * As a network drop: the host only learns the connection went when the socket errors or closes.
 *
 * @sideEffects Opens and destroys a socket.
 * @param host - The host.
 * @param sessionId - The session to watch.
 */
async function dropAfterWatching(host: TestHost, sessionId: string): Promise<void> {
  const socket = new WebSocket(host.url);
  const received: HostMessage[] = [];
  socket.on("message", (data: Buffer) => received.push(JSON.parse(data.toString("utf8")) as HostMessage));
  await new Promise((done) => socket.once("open", done));
  /** Sends a message with the trace context. */
  const send = (message: object): void => socket.send(JSON.stringify({ traceparent, ...message }));
  send({ type: "hello", protocolVersion: PROTOCOL_VERSION, clientId: "dropping", token: host.token });
  await vi.waitFor(() => expect(received.map((message) => message.type)).toContain("welcome"));
  send({ type: "subscribe_index", requestId: "r1" });
  send({ type: "subscribe_sessions", requestId: "r2", sessionIds: [sessionId] });
  await vi.waitFor(() => expect(received.map((message) => message.type)).toContain("session_snapshot"));
  socket.terminate();
}

describe("session resources (M1.9)", () => {
  it("leaves no pi, subscription, timer or handle behind after opening and closing a chat 200 times", async () => {
    const { host, client } = await sessionsHost();
    const { before, handles, processes } = await baseline(host);

    for (let round = 0; round < BATCH * BATCHES; round++) {
      const { sessionId } = await client.createChat();
      await client.watch([sessionId]);
      await client.closeTab(sessionId);
      await client.watch([]);
    }

    await vi.waitFor(() => expect(client.index.getState().sessions).toStrictEqual([]));
    await backToBaseline(host, before, handles, processes);
  });

  it("leaves no subscription or view behind after watching and unwatching a running session 200 times", async () => {
    const { host, client } = await sessionsHost();
    const { sessionId } = await client.createChat();
    await client.prompt(sessionId, "go");
    const { before, handles, processes } = await baseline(host);

    for (let batch = 0; batch < BATCHES; batch++) {
      for (let round = 0; round < BATCH; round++) {
        await client.watch([sessionId]);
        await vi.waitFor(() => expect(present(client.session(sessionId), "view").getState().run).not.toBeNull());
        await client.watch([]);
      }
      await pause();
    }

    expect(client.session(sessionId)).toBeUndefined();
    await backToBaseline(host, before, handles, processes);
  });

  it("forgets 200 connections dropped while they watched the list and a running session", async () => {
    const { host, client } = await sessionsHost();
    const { sessionId } = await client.createChat();
    await client.prompt(sessionId, "go");
    const { before, handles, processes } = await baseline(host);

    for (let round = 0; round < BATCH * BATCHES; round++) await dropAfterWatching(host, sessionId);

    expect(client.connection.getState().status).toBe("connected");
    await backToBaseline(host, before, handles, processes);
  });

  it("leaves no timer or handle behind after starting and stopping 200 runs", async () => {
    const { host, client } = await sessionsHost();
    const { sessionId } = await client.createChat();
    await client.watch([sessionId]);
    const view = () => present(client.session(sessionId), "view").getState();
    const { before, handles, processes } = await baseline(host);

    for (let batch = 0; batch < BATCHES; batch++) {
      for (let round = 0; round < BATCH; round++) {
        await client.prompt(sessionId, "go");
        await vi.waitFor(() => expect(view().run).not.toBeNull());
        expect(await client.stop(sessionId)).toStrictEqual({ confirmed: true });
        await vi.waitFor(() => expect(view().run).toBeNull());
      }
      await pause();
    }

    await backToBaseline(host, before, handles, processes);
  });
});
