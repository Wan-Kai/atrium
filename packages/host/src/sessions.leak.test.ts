import type { AtriumClient } from "@atrium/client";
import { type HostMessage, PROTOCOL_VERSION } from "@atrium/protocol";
import type { TranscriptItem } from "@atrium/protocol";
import { type FauxReply, createTempDir, fauxPi, present, writeScriptedPi } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { type TestHost, startTestHost } from "../test/harness";
import { PONG_STATS } from "../test/scripted-chat";

/** Rounds in a batch; with a pause after each, a client stays under the host's 200 messages a second. */
const BATCH = 50;
const BATCHES = 4;
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

let testHost: TestHost | undefined;
/** Where the scripted pi's sessions are read from, the latest host's. */
let sessionsDir: string | undefined;

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
        get_session_stats: PONG_STATS,
        prompt: { data: { disposition: "started" }, events: [{ type: "agent_start" }] },
        abort: { data: {}, events: [{ type: "agent_settled" }] },
      },
    },
    "pi",
  );
  sessionsDir = bin.path;
  testHost = await startTestHost({
    logLevel: "warn",
    toolEnv: { PATH: `${bin.path}:/usr/bin:/bin`, PI_CODING_AGENT_SESSION_DIR: bin.path, ...scripted.env },
  });
  await testHost.host.tools;
  const client = testHost.connect();
  expect(await client.connect()).toMatchObject({ status: "connected" });
  return { host: testHost, client };
}

/**
 * A chat's session that pi wrote a file of, so child conversations can hang under it.
 *
 * @remarks
 * The scripted pi writes no file; the test writes one where the host reads pi's sessions, and the
 * window coming to the front makes the host look again (SPEC-0002: a draft has no children).
 *
 * @sideEffects Creates a chat and its session file; makes the host scan.
 * @param host - The host, whose home holds the chat's directory.
 * @param client - The client.
 * @returns The session's id and its chat.
 */
async function sessionOnFile(
  host: TestHost,
  client: AtriumClient,
): Promise<{ sessionId: string; containerId: string }> {
  const { sessionId } = await client.createChat();
  const containerId = present(
    client.index.getState().sessions.find((one) => one.sessionId === sessionId),
    "the new session",
  ).containerId;
  // The host reads only files whose directory is a container's; a chat's is under its home.
  const cwd = join(dirname(dirname(host.host.logFile)), "chats", containerId.slice("cht_".length));
  const entry = { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: "go" } };
  await writeFile(
    join(present(sessionsDir, "the sessions folder"), `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "session", id: sessionId, timestamp: "", cwd })}\n${JSON.stringify(entry)}\n`,
  );
  await client.windowFocused();
  const summary = () => client.index.getState().sessions.find((one) => one.sessionId === sessionId);
  await vi.waitFor(() => expect(summary()?.state).toBe("persisted"), { timeout: 10_000 });
  return { sessionId, containerId };
}

/**
 * Waits until the host's counts and Node's handles are back to where they were.
 *
 * @remarks
 * Kinds that first appeared after the baseline must be back to zero. Node's handles are read with
 * a timer of our own running, hence at most one more `Timeout` than before. A test that made
 * sessions that keep a count of their own says by how much (`grown`).
 *
 * @sideEffects Waits.
 * @param host - The host.
 * @param before - Its counts before.
 * @param handles - Node's handles before.
 * @param processes - The child processes before.
 * @param grown - Counts expected above the baseline.
 */
async function backToBaseline(
  host: TestHost,
  before: Readonly<Record<string, number>>,
  handles: ReturnType<typeof liveHandles>,
  processes: readonly number[],
  grown: Readonly<Record<string, number>> = {},
): Promise<void> {
  const appeared = Object.keys(host.host.resources.snapshot()).filter((kind) => !(kind in before));
  const expected = {
    ...before,
    ...Object.fromEntries(appeared.map((kind) => [kind, 0])),
    ...Object.fromEntries(Object.entries(grown).map(([kind, more]) => [kind, (before[kind] ?? 0) + more])),
  };
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

  it("leaves no pi, timer or handle behind after opening and archiving a child conversation 200 times (SPEC-0002)", async () => {
    const { host, client } = await sessionsHost();
    const parent = await sessionOnFile(host, client);
    const { before, handles, processes } = await baseline(host);

    for (let batch = 0; batch < BATCHES; batch++) {
      for (let round = 0; round < BATCH / 2; round++) {
        const { sessionId } = await client.createChild(parent.containerId, {
          parentSessionId: parent.sessionId,
          name: "子对话",
          place: "same",
        });
        await client.archiveSession(sessionId);
      }
      await pause();
    }

    await vi.waitFor(() =>
      expect(
        client.index
          .getState()
          .sessions.filter((one) => !one.archived)
          .map((one) => one.sessionId),
      ).toStrictEqual([parent.sessionId]),
    );
    await client.closeTab(parent.sessionId);
    await backToBaseline(host, before, handles, processes);
  });
});

/** Atrium's extension, from its source, as pi loads it (ADR-0008, ADR-0013). */
const ATRIUM_EXTENSION = fileURLToPath(new URL("../../pi/src/extension/atrium.ts", import.meta.url));

/** Rounds of the agent opening a child, after one to warm up. */
const AGENT_ROUNDS = 5;

/**
 * The real pi on this process's PATH.
 *
 * @remarks
 * As the end-to-end tests run it: the pi installed, answering from the faux model.
 *
 * @sideEffects Checks files on disk.
 * @returns Its path.
 * @throws {Error} When pi is not installed.
 */
async function realPi(): Promise<string> {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter).filter((one) => one !== "")) {
    const candidate = join(directory, "pi");
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  throw new Error("pi is not on PATH; the agent's children leak test needs it installed");
}

/**
 * What the parent's agent says in each round: opens a child, ends its run, and takes the child's notice.
 *
 * @remarks
 * The faux model picks a reply by how many it gave in the conversation, so the rounds follow on.
 *
 * @sideEffects none
 * @param rounds - How many rounds.
 * @returns The replies.
 */
function parentReplies(rounds: number): FauxReply[] {
  return Array.from({ length: rounds }, (_, round): FauxReply[] => [
    {
      blocks: [
        {
          type: "toolCall",
          id: `spawn-${String(round)}`,
          name: "agent_spawn",
          arguments: { name: `r${String(round)}`, task: "看一眼" },
        },
      ],
    },
    { blocks: [{ type: "text", text: `派出去了 ${String(round)}` }] },
    { blocks: [{ type: "text", text: `收到 ${String(round)}` }] },
  ]).flat();
}

/**
 * A host whose pi is the real one on a faux model, with Atrium's extension, and a client.
 *
 * @remarks
 * A `pi` wrapper first on PATH runs the real pi with the faux extension, as the end-to-end tests
 * do; the parent's agent opens a child each round and the child answers once (SPEC-0002, "验证 ·
 * 泄漏测试").
 *
 * @sideEffects Creates temporary directories; starts a host.
 * @param rounds - How many rounds the script has.
 * @returns The host and the client.
 */
async function agentHost(rounds: number): Promise<{ readonly host: TestHost; readonly client: AtriumClient }> {
  const dir = await createTempDir("leak-agent");
  onTestFinished(dir.cleanup);
  const launch = await fauxPi(
    { replies: parentReplies(rounds), childReplies: [{ blocks: [{ type: "text", text: "看完了" }] }] },
    dir.path,
  );
  const bin = join(dir.path, "bin");
  await mkdir(bin);
  const quoted = launch.args.map((arg) => `'${arg.replaceAll("'", String.raw`'\''`)}'`).join(" ");
  const wrapper = join(bin, "pi");
  await writeFile(
    wrapper,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then exec "$LEAK_REAL_PI" --version; fi\nexec "$LEAK_REAL_PI" "$@" ${quoted}\n`,
  );
  await chmod(wrapper, 0o755);
  testHost = await startTestHost({
    logLevel: "warn",
    fastExtension: ATRIUM_EXTENSION,
    toolEnv: {
      ...launch.env,
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
      LEAK_REAL_PI: await realPi(),
    },
  });
  await testHost.host.tools;
  const client = testHost.connect();
  expect(await client.connect()).toMatchObject({ status: "connected" });
  return { host: testHost, client };
}

/**
 * The texts of a transcript's replies, in order.
 *
 * @sideEffects none
 * @param items - The transcript.
 * @returns The texts.
 */
function replies(items: readonly TranscriptItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === "turn" ? item.steps.flatMap((step) => (step.kind === "text" ? [step.text] : [])) : [],
  );
}

/**
 * Runs one round: you speak, the agent opens a child, the child answers, its notice comes back.
 *
 * @remarks
 * The round is over once the parent's agent replied to the notice and the child's pi, idle without
 * a tab, was stopped (SPEC-0002, "角色与限制 · 进程").
 *
 * @sideEffects Sends a message; waits.
 * @param client - The client.
 * @param sessionId - The parent.
 * @param round - The round.
 */
async function agentRound(client: AtriumClient, sessionId: string, round: number): Promise<void> {
  await client.prompt(sessionId, `第 ${String(round)} 轮`);
  await vi.waitFor(
    () =>
      expect(replies(present(client.session(sessionId), "view").getState().items)).toContain(`收到 ${String(round)}`),
    { timeout: 30_000 },
  );
  const child = () => client.index.getState().sessions.find((one) => one.agent?.handle === `r${String(round)}`);
  await vi.waitFor(() => expect(child()?.agent?.status).toBe("idle"), { timeout: 30_000 });
}

describe("agent children's resources (SPEC-0002, 第二步)", () => {
  it("keeps no more pi running after the agent opens a child, it finishes and is put away, again and again", async () => {
    const { host, client } = await agentHost(AGENT_ROUNDS + 1);
    // The faux model answers a title request with an error unless its script names one (testing.md,
    // "faux 模型"); whether a title call ends before the host closes is up to timing.
    host.expectLog({ level: "warn", msg: "one-shot pi failed", fields: { reason: "model_failed" }, optional: true });
    const { sessionId } = await client.createChat();
    await client.watch([sessionId]);
    await agentRound(client, sessionId, 0);
    const { before, handles, processes } = await baseline(host);

    for (const round of Array.from({ length: AGENT_ROUNDS }, (_, at) => at + 1)) {
      await agentRound(client, sessionId, round);
    }

    expect(
      client.index
        .getState()
        .sessions.filter((one) => one.agent !== null)
        .map((one) => one.agent?.status),
    ).toStrictEqual(Array.from({ length: AGENT_ROUNDS + 1 }, () => "idle"));
    // Each child keeps its controller, as any session whose pi stopped does, until it is archived;
    // its pi does not stay.
    await backToBaseline(host, before, handles, processes, { "session.controller": AGENT_ROUNDS });
  });
});
