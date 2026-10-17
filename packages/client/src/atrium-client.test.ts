import { CloseCode, CommandError, IDLE_CONTROL, PROTOCOL_VERSION, UNKNOWN_METRICS } from "@atrium/protocol";
import { FakeClock, present } from "@atrium/testkit";
import { describe, expect, it, vi } from "vitest";
import { type AtriumClient, ConnectionLostError, createAtriumClient } from "./atrium-client";

const trace = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const CHAT = "cht_a";

/** A welcome with a 15 s heartbeat. */
function welcome(hostVersion = "0.1.0", hostInstanceId = "h1"): string {
  return JSON.stringify({
    type: "welcome",
    protocolVersion: PROTOCOL_VERSION,
    hostVersion,
    hostInstanceId,
    heartbeatMs: 15_000,
    installSeed: 4242,
    logDir: "/Users/test/.atrium/logs",
  });
}

/** A socket the test drives by hand: it records what the client sends and replays host messages. */
function scriptedSocket() {
  const listeners: Record<string, Array<(event: never) => void>> = {};
  const socket = {
    readyState: 0,
    sent: [] as Record<string, unknown>[],
    closes: [] as Array<[number | undefined, string | undefined]>,
    send: (data: string) => socket.sent.push(JSON.parse(data) as Record<string, unknown>),
    close: (code?: number, reason?: string) => socket.closes.push([code, reason]),
    addEventListener: (type: string, listener: (event: never) => void) => {
      (listeners[type] ??= []).push(listener);
    },
    open: () => listeners["open"]?.forEach((listener) => listener(undefined as never)),
    receive: (data: unknown) => listeners["message"]?.forEach((listener) => listener({ data } as never)),
    closeWith: (code: number) => listeners["close"]?.forEach((listener) => listener({ code } as never)),
    /** Answers the last command of `type` with `result`. */
    answer: (type: string, result: unknown = {}) => {
      const command = present(
        socket.sent.findLast((sent) => sent["type"] === type),
        `a ${type} command`,
      );
      socket.receive(JSON.stringify({ type: "response", requestId: command["requestId"], ok: true, result }));
    },
    /** Answers the last command of `type`, or the one numbered `at` from 0, with the error `code`. */
    fail: (type: string, code: string, at?: number) => {
      const ofType = socket.sent.filter((sent) => sent["type"] === type);
      const command = present(ofType.at(at ?? -1), `a ${type} command`);
      socket.receive(JSON.stringify({ type: "response", requestId: command["requestId"], ok: false, error: { code } }));
    },
    /** The commands sent after the hello, without their trace or the list subscription every welcome brings. */
    commands: () =>
      socket.sent
        .slice(1)
        .filter((sent) => sent["type"] !== "subscribe_index")
        .map((sent) => Object.fromEntries(Object.entries(sent).filter(([key]) => key !== "traceparent"))),
  };
  return socket;
}

type ScriptedSocket = ReturnType<typeof scriptedSocket>;

/** A client over scripted sockets, opened in order, with a fake clock. */
function clientWith(options: { reconnectDelaysMs?: number[] } = {}) {
  const sockets: ScriptedSocket[] = [];
  const clock = new FakeClock();
  const client: AtriumClient = createAtriumClient({
    url: "ws://host.invalid",
    token: "token-value",
    clientId: "client-1",
    openSocket: () => {
      const socket = scriptedSocket();
      sockets.push(socket);
      return socket;
    },
    createTrace: () => trace,
    clock,
    ...options,
  });
  return { client, sockets, clock, latest: () => present(sockets.at(-1), "a socket") };
}

/**
 * What first launch checks, with pi in `state`.
 *
 * @remarks
 * pi's version goes with a ready pi only.
 *
 * @sideEffects none
 * @param state - pi's state.
 * @returns The answer to `check_setup`.
 */
function setupState(state: "missing" | "ready") {
  return {
    pi: {
      state,
      path: state === "ready" ? "/bin/pi" : null,
      version: state === "ready" ? "1.1.0" : null,
      minimum: "1.0.1",
      detail: null,
      latest: null,
      checkedAt: null,
    },
    node: { state: "ready", version: "22.19.0" },
    homebrew: false,
    fd: false,
    login: { state: "unavailable" },
    projects: 0,
  } as const;
}

/**
 * Answers the command of `type` numbered `at` from 0 with `result`.
 *
 * @remarks
 * For answers that arrive out of order.
 *
 * @sideEffects Delivers the answer to the client.
 * @param socket - The socket.
 * @param type - The command type.
 * @param at - Which of its commands.
 * @param result - The result.
 */
function answerAt(socket: ScriptedSocket, type: string, at: number, result: unknown): void {
  const command = present(socket.sent.filter((sent) => sent["type"] === type).at(at), `a ${type} command`);
  socket.receive(JSON.stringify({ type: "response", requestId: command["requestId"], ok: true, result }));
}

/** A client connected over its first socket. */
async function connected() {
  const setup = clientWith();
  const settled = setup.client.connect();
  setup.latest().open();
  setup.latest().receive(welcome());
  await settled;
  return setup;
}

/** An event of session s1. */
function event(seq: number, fields: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: "s1", epoch: 1, seq, traceId: null, ...fields });
}

/** A snapshot of s1 at `seq` with `items`. */
function snapshot(seq: number, items: unknown[] = [], hasOlder = false): string {
  return event(seq, {
    type: "session_snapshot",
    items,
    hasOlder,
    run: null,
    exited: false,
    control: IDLE_CONTROL,
    model: null,
    fast: false,
    metrics: UNKNOWN_METRICS,
  });
}

/** How many `subscribe_sessions` the client sent. */
function subscriptions(socket: { commands(): Record<string, unknown>[] }): number {
  return socket.commands().filter((command) => command["type"] === "subscribe_sessions").length;
}

/** A turn of the transcript, opened by `clientMessageId`. */
function turn(id: string, clientMessageId: string | null = null) {
  return {
    kind: "turn",
    id,
    user: { text: "hi", images: 0, clientMessageId, auto: false, command: null, timestamp: 0 },
    steps: [],
    outcome: "done",
    error: null,
    startedAt: 0,
    durationMs: 1,
    usage: null,
    changes: [],
  };
}

describe("createAtriumClient: the connection", () => {
  it("sends hello on open and stays connecting until a real welcome arrives", async () => {
    const { client, latest } = clientWith();
    const settled = client.connect();

    latest().open();
    latest().receive("not json");
    latest().receive(JSON.stringify({ type: "something-else" }));
    latest().receive(new Uint8Array([1, 2, 3]));
    const beforeWelcome = client.connection.getState();
    latest().receive(welcome("0.1.0", "h7"));

    expect(latest().sent[0]).toStrictEqual({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      clientId: "client-1",
      token: "token-value",
      traceparent,
    });
    expect(beforeWelcome).toStrictEqual({ status: "connecting", traceId: trace.traceId });
    expect(await settled).toStrictEqual({
      status: "connected",
      traceId: trace.traceId,
      hostVersion: "0.1.0",
      hostInstanceId: "h7",
      installSeed: 4242,
      logDir: "/Users/test/.atrium/logs",
    });
  });

  it("ignores a valid message that is not a welcome while connecting", () => {
    const { client, latest } = clientWith();
    void client.connect();
    latest().open();

    latest().receive(JSON.stringify({ type: "response", requestId: "x", ok: true }));

    expect(client.connection.getState()).toStrictEqual({ status: "connecting", traceId: trace.traceId });
  });

  it.each([
    [CloseCode.Unauthorized, "unauthorized"],
    [CloseCode.VersionMismatch, "version-mismatch"],
    [CloseCode.BadHandshake, "bad-handshake"],
    [CloseCode.HandshakeTimeout, "handshake-timeout"],
    [CloseCode.RateLimited, "rate-limited"],
    [CloseCode.TooManyConnections, "too-many-connections"],
  ] as const)("maps close code %i to the rejection %s and does not retry", async (code, reason) => {
    const { client, latest, clock } = clientWith();
    const settled = client.connect();

    latest().closeWith(code);

    expect(await settled).toStrictEqual({ status: "rejected", reason });
    expect(clock.pendingTimers()).toBe(0);
  });

  it("starts idle, and closes the socket normally without retrying when asked to disconnect", async () => {
    const idle = clientWith();
    idle.client.disconnect();
    expect(idle.client.connection.getState()).toStrictEqual({ status: "idle" });

    const { client, latest, clock } = await connected();
    client.disconnect();
    latest().closeWith(1000);

    expect(latest().closes).toStrictEqual([[1000, "client closed"]]);
    expect(client.connection.getState()).toStrictEqual({ status: "disconnected", code: 1000 });
    expect(clock.pendingTimers()).toBe(0);
  });

  it("closes the previous socket on a new connect and ignores the old one's late events", async () => {
    const { client, sockets } = clientWith();
    const firstAttempt = client.connect();
    const secondAttempt = client.connect();
    const [first, second] = sockets as [ScriptedSocket, ScriptedSocket];
    first.receive(welcome("0.1.0"));
    expect(client.connection.getState()).toStrictEqual({ status: "connecting", traceId: trace.traceId });
    second.open();
    second.receive(welcome("0.2.0"));
    await secondAttempt;

    first.closeWith(1006);

    expect(first.closes).toStrictEqual([[1000, "client reconnecting"]]);
    expect(await firstAttempt).toStrictEqual({ status: "disconnected", code: 1006 });
    expect(client.connection.getState()).toMatchObject({ status: "connected", hostVersion: "0.2.0" });
  });

  it("reports a replaced attempt's own refusal without touching the current state", async () => {
    const { client, sockets } = clientWith();
    const firstAttempt = client.connect();
    void client.connect();

    sockets[0]?.closeWith(CloseCode.Unauthorized);

    expect(await firstAttempt).toStrictEqual({ status: "rejected", reason: "unauthorized" });
    expect(client.connection.getState()).toStrictEqual({ status: "connecting", traceId: trace.traceId });
  });

  it("starts each reconnect attempt from a clean connecting state and refuses commands meanwhile", async () => {
    const { client, latest, clock } = await connected();

    latest().closeWith(1006);
    await expect(client.createChat()).rejects.toStrictEqual(new ConnectionLostError("create_chat"));
    clock.advance(250);

    expect(client.connection.getState()).toStrictEqual({ status: "connecting", traceId: trace.traceId });
  });

  it("uses the platform's timers by default, cancelling the reconnect on disconnect", async () => {
    const sockets: ScriptedSocket[] = [];
    const client = createAtriumClient({
      url: "ws://host.invalid",
      token: "token-value",
      clientId: "client-1",
      openSocket: () => {
        const socket = scriptedSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelaysMs: [1],
    });
    void client.connect();

    sockets[0]?.closeWith(1006);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]?.closeWith(1006);
    client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sockets).toHaveLength(2);
  });

  it("reconnects after a drop with growing delays, the last one repeating, until a welcome resets them", async () => {
    const { client, sockets, clock, latest } = clientWith({ reconnectDelaysMs: [100, 300] });
    void client.connect();

    const waits: number[] = [];
    for (let drop = 1; drop <= 3; drop++) {
      latest().closeWith(1006);
      expect(client.connection.getState()).toStrictEqual({ status: "reconnecting", attempt: drop, code: 1006 });
      const before = sockets.length;
      let waited = 0;
      while (sockets.length === before) {
        clock.advance(100);
        waited += 100;
      }
      waits.push(waited);
    }
    latest().open();
    latest().receive(welcome());
    latest().closeWith(1006);

    expect(waits).toStrictEqual([100, 300, 300]);
    expect(client.connection.getState()).toStrictEqual({ status: "reconnecting", attempt: 1, code: 1006 });
  });

  it("does not reconnect when retries are turned off", async () => {
    const { client, latest, clock } = clientWith({ reconnectDelaysMs: [] });
    void client.connect();

    latest().closeWith(1006);

    expect(client.connection.getState()).toStrictEqual({ status: "disconnected", code: 1006 });
    expect(clock.pendingTimers()).toBe(0);
  });

  it("pings every heartbeat and drops a connection whose ping went unanswered", async () => {
    const { client, latest, clock } = await connected();
    const socket = latest();

    expect(socket.commands()).toStrictEqual([{ type: "ping", requestId: "client-1-1" }]);
    socket.answer("ping");
    await Promise.resolve();
    clock.advance(15_000);
    expect(socket.commands()).toStrictEqual([
      { type: "ping", requestId: "client-1-1" },
      { type: "ping", requestId: "client-1-3" },
    ]);
    const waiting = client.createChat();
    clock.advance(15_000);

    // Given up at once, without waiting for the browser to report the close.
    expect(socket.closes).toStrictEqual([[4000, "heartbeat lost"]]);
    expect(client.connection.getState()).toStrictEqual({ status: "reconnecting", attempt: 1, code: 4000 });
    await expect(waiting).rejects.toStrictEqual(new ConnectionLostError("create_chat"));
    await expect(client.createChat()).rejects.toStrictEqual(new ConnectionLostError("create_chat"));
    // The late close event changes nothing, and only one reconnect is scheduled.
    socket.closeWith(1006);
    expect(client.connection.getState()).toStrictEqual({ status: "reconnecting", attempt: 1, code: 4000 });
    expect(clock.pendingTimers()).toBe(1);
  });

  it("fails commands still waiting on the old socket when connecting again", async () => {
    const { client } = await connected();
    const waiting = client.createChat();

    void client.connect();

    await expect(waiting).rejects.toStrictEqual(new ConnectionLostError("create_chat"));
  });

  it("ends a reconnect wait when told to disconnect", async () => {
    const { client, latest, clock } = await connected();
    latest().closeWith(1006);

    client.disconnect();

    expect(client.connection.getState()).toStrictEqual({ status: "disconnected", code: 1000 });
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe("ConnectionLostError", () => {
  it("names the command that lost its answer", () => {
    expect(new ConnectionLostError("prompt")).toMatchObject({
      name: "ConnectionLostError",
      message: "connection lost before prompt was answered",
      command: "prompt",
    });
  });
});

describe("createAtriumClient: commands", () => {
  it("sends each command with a new request id and the trace, and resolves with its checked result", async () => {
    const { client, latest } = await connected();

    const created = client.createChat();
    latest().answer("create_chat", { sessionId: "s1" });

    expect(await created).toStrictEqual({ sessionId: "s1" });
    expect(latest().sent.at(-1)).toStrictEqual({ type: "create_chat", requestId: "client-1-3", traceparent });
  });

  it("sends the session, project, workspace, chat and preference commands with their fields", async () => {
    const { client, latest } = await connected();
    const calls = [
      client.createSession("wks_0123456789abcdef"),
      client.createSession("wks_0123456789abcdef", false),
      client.archiveSession("s1"),
      client.renameSession("s1", "名字"),
      client.addProject("/work/app"),
      client.removeProject("prj_0123456789abcdef"),
      client.renameProject("prj_0123456789abcdef", "app"),
      client.renameWorkspace("wks_0123456789abcdef", null),
      client.archiveWorkspace("wks_0123456789abcdef"),
      client.restoreWorkspace("wks_0123456789abcdef"),
      client.listBases("prj_0123456789abcdef"),
      client.createWorkspace("prj_0123456789abcdef", "atrium/a", "origin/main"),
      client.nameBranch("prj_0123456789abcdef", "Fix it", { providerId: "faux", modelId: "m" }),
      client.renameChat(CHAT, "合并原理"),
      client.archiveChat(CHAT),
      client.restoreChat(CHAT),
      client.windowFocused(),
      client.clearAttention("s1"),
      client.handOff("s1"),
      client.takeBack("s1"),
    ];
    answerAt(latest(), "create_session", 0, { sessionId: "s9" });
    answerAt(latest(), "create_session", 1, { sessionId: "s8" });
    latest().answer("add_project", { projectId: "prj_0123456789abcdef" });
    latest().answer("hand_off", { file: "/pi/s1.jsonl" });
    latest().answer("list_bases", { main: "origin/main", current: "main", local: ["main"], remote: ["origin/main"] });
    latest().answer("create_workspace", { workspaceId: "wks_00000000000000aa" });
    latest().answer("name_branch", { branch: "atrium/fix-it" });
    for (const type of [
      "archive_session",
      "rename_session",
      "remove_project",
      "rename_project",
      "rename_workspace",
      "archive_workspace",
      "restore_workspace",
      "rename_chat",
      "archive_chat",
      "restore_chat",
      "window_focused",
      "clear_attention",
      "take_back",
    ]) {
      latest().answer(type);
    }

    expect(await Promise.all(calls)).toStrictEqual([
      { sessionId: "s9" },
      { sessionId: "s8" },
      {},
      {},
      { projectId: "prj_0123456789abcdef" },
      {},
      {},
      {},
      {},
      {},
      { main: "origin/main", current: "main", local: ["main"], remote: ["origin/main"] },
      { workspaceId: "wks_00000000000000aa" },
      { branch: "atrium/fix-it" },
      {},
      {},
      {},
      {},
      {},
      { file: "/pi/s1.jsonl" },
      {},
    ]);
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] !== "ping")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "create_session", containerId: "wks_0123456789abcdef" },
      { type: "create_session", containerId: "wks_0123456789abcdef", go: false },
      { type: "archive_session", sessionId: "s1" },
      { type: "rename_session", sessionId: "s1", name: "名字" },
      { type: "add_project", path: "/work/app" },
      { type: "remove_project", projectId: "prj_0123456789abcdef" },
      { type: "rename_project", projectId: "prj_0123456789abcdef", name: "app" },
      { type: "rename_workspace", workspaceId: "wks_0123456789abcdef", name: null },
      { type: "archive_workspace", workspaceId: "wks_0123456789abcdef" },
      { type: "restore_workspace", workspaceId: "wks_0123456789abcdef" },
      { type: "list_bases", projectId: "prj_0123456789abcdef" },
      { type: "create_workspace", projectId: "prj_0123456789abcdef", branch: "atrium/a", base: "origin/main" },
      {
        type: "name_branch",
        projectId: "prj_0123456789abcdef",
        text: "Fix it",
        model: { providerId: "faux", modelId: "m" },
      },
      { type: "rename_chat", chatId: CHAT, name: "合并原理" },
      { type: "archive_chat", chatId: CHAT },
      { type: "restore_chat", chatId: CHAT },
      { type: "window_focused" },
      { type: "clear_attention", sessionId: "s1" },
      { type: "hand_off", sessionId: "s1" },
      { type: "take_back", sessionId: "s1" },
    ]);
  });

  it("rejects with the host's error code, and with the schema's error for a malformed result", async () => {
    const { client, latest } = await connected();

    const failed = client.createChat();
    latest().receive(
      JSON.stringify({
        type: "response",
        requestId: "client-1-3",
        ok: false,
        error: { code: "pi_unavailable", params: { status: "missing" } },
      }),
    );
    const malformed = client.createChat();
    latest().answer("create_chat", { sessionId: 7 });

    await expect(failed).rejects.toStrictEqual(new CommandError("pi_unavailable", { status: "missing" }));
    await expect(malformed).rejects.toMatchObject({ name: "ZodError" });
  });

  it("ignores responses nobody waits for", async () => {
    const { client, latest } = await connected();
    const created = client.createChat();

    latest().receive(JSON.stringify({ type: "response", requestId: "other", ok: true, result: {} }));
    latest().receive(
      JSON.stringify({ type: "response", requestId: null, ok: false, error: { code: "invalid_message" } }),
    );
    latest().answer("create_chat", { sessionId: "s1" });

    expect(await created).toStrictEqual({ sessionId: "s1" });
  });

  it("fails commands at once without a connection, and fails waiting ones when it drops", async () => {
    const offline = clientWith();
    await expect(offline.client.createChat()).rejects.toStrictEqual(new ConnectionLostError("create_chat"));

    const { client, latest } = await connected();
    const waiting = client.createChat();
    latest().closeWith(1006);

    await expect(waiting).rejects.toStrictEqual(new ConnectionLostError("create_chat"));
  });

  it("truncates reported issues to 4 KB", async () => {
    const { client, latest } = await connected();

    const reported = client.reportIssue("error", "m".repeat(5000), "d".repeat(5000));
    latest().answer("report_client_issue");
    await reported;
    const short = client.reportIssue("long_task", "took 80 ms");
    latest().answer("report_client_issue");
    await short;

    expect(latest().commands().slice(1)).toStrictEqual([
      {
        type: "report_client_issue",
        requestId: "client-1-3",
        kind: "error",
        message: "m".repeat(4096),
        details: "d".repeat(4096),
      },
      { type: "report_client_issue", requestId: "client-1-4", kind: "long_task", message: "took 80 ms" },
    ]);
  });
});

describe("createAtriumClient: sessions", () => {
  it("creates a loading view per watched session, drops unwatched ones, and subscribes", async () => {
    const { client, latest } = await connected();

    const watching = client.watch(["s1", "s2", "s1"]);
    latest().answer("subscribe_sessions");
    await watching;
    const s1 = client.session("s1");
    const rewatching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await rewatching;

    expect(latest().commands().slice(1)).toStrictEqual([
      { type: "subscribe_sessions", requestId: "client-1-3", sessionIds: ["s1", "s2"] },
      { type: "subscribe_sessions", requestId: "client-1-4", sessionIds: ["s1"] },
    ]);
    expect(client.session("s1")).toBe(s1);
    expect(client.session("s2")).toBeUndefined();
    expect(s1?.getState()).toMatchObject({ sessionId: "s1", status: "loading" });
  });

  it("creates views before connecting without sending anything", async () => {
    const { client, latest } = clientWith();
    void client.connect();

    await client.watch(["s1"]);

    expect(client.session("s1")?.getState().status).toBe("loading");
    expect(latest().sent).toStrictEqual([]);
    // The first welcome is no restart: the views stay and are subscribed.
    latest().open();
    latest().receive(welcome());
    expect(client.session("s1")?.getState().status).toBe("loading");
    expect(latest().commands()).toStrictEqual([
      { type: "ping", requestId: "client-1-1" },
      { type: "subscribe_sessions", requestId: "client-1-3", sessionIds: ["s1"] },
    ]);
  });

  it("applies a session's events to its view, and drops events of sessions it does not watch", async () => {
    const { client, latest } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;

    latest().receive(snapshot(3));
    latest().receive(event(4, { type: "run_started", runId: "r1", startedAt: 9 }));
    latest().receive(
      JSON.stringify({ ...JSON.parse(event(1, { type: "turn_started", turn: turn("t1") })), sessionId: "s9" }),
    );

    expect(client.session("s1")?.getState()).toMatchObject({
      status: "ready",
      seq: 4,
      run: { runId: "r1", startedAt: 9 },
    });
  });

  it("asks for a fresh snapshot when it misses an event", async () => {
    const { client, latest } = await connected();
    const watching = client.watch(["s1", "s2"]);
    latest().answer("subscribe_sessions");
    await watching;
    latest().receive(snapshot(3));

    latest().receive(event(5, { type: "run_settled", runId: "r", outcome: "completed", settledAt: 1 }));
    latest().answer("subscribe_sessions");
    await Promise.resolve();
    await Promise.resolve();

    expect(client.session("s1")?.getState().status).toBe("loading");
    expect(latest().commands().slice(2)).toStrictEqual([
      { type: "subscribe_sessions", requestId: "client-1-4", sessionIds: ["s2"] },
      { type: "subscribe_sessions", requestId: "client-1-5", sessionIds: ["s1", "s2"] },
    ]);
  });

  it("subscribes the watched sessions again after reconnecting", async () => {
    const { client, latest, clock } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;

    latest().closeWith(1006);
    clock.advance(250);
    latest().open();
    latest().receive(welcome("0.1.0", "h1"));

    expect(latest().commands()).toStrictEqual([
      { type: "ping", requestId: "client-1-4" },
      { type: "subscribe_sessions", requestId: "client-1-6", sessionIds: ["s1"] },
    ]);
  });

  it("shows a prompt at once as pending until the host confirms it", async () => {
    const { client, latest } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;
    latest().receive(snapshot(0));

    const sent = client.prompt("s1", "hello");
    const pendingNow = client.session("s1")?.getState().pending;
    latest().answer("prompt", { disposition: "started" });
    await sent;
    // Started is not confirmed yet: the copy stays until pi echoes the message.
    const pendingAfterAnswer = client.session("s1")?.getState().pending;
    latest().receive(event(1, { type: "turn_started", turn: turn("t1", "client-1-4") }));

    expect(pendingNow).toStrictEqual([{ clientMessageId: "client-1-4", text: "hello" }]);
    expect(pendingAfterAnswer).toStrictEqual(pendingNow);
    expect(latest().sent.at(-1)).toStrictEqual({
      type: "prompt",
      requestId: "client-1-4",
      traceparent,
      sessionId: "s1",
      text: "hello",
    });
    expect(client.session("s1")?.getState()).toMatchObject({ pending: [], items: [turn("t1", "client-1-4")] });
  });

  it("shows the tag a message went with on its pending copy, sending only its text", async () => {
    const { client, latest } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;
    latest().receive(snapshot(0));

    void client.prompt("s1", "/review src", [], [], { source: "prompt", name: "review" }).catch(() => undefined);
    void client.steer("s1", "/skill:tdd", [], [], { source: "skill", name: "skill:tdd" }).catch(() => undefined);

    expect(client.session("s1")?.getState().pending).toStrictEqual([
      { clientMessageId: "client-1-4", text: "/review src", command: { source: "prompt", name: "review" } },
      { clientMessageId: "client-1-5", text: "/skill:tdd", command: { source: "skill", name: "skill:tdd" } },
    ]);
    expect(
      latest()
        .sent.slice(-2)
        .map(({ type, text }) => [type, text]),
    ).toStrictEqual([
      ["prompt", "/review src"],
      ["steer", "/skill:tdd"],
    ]);
    expect(Object.keys(present(latest().sent.at(-1), "the steer"))).toStrictEqual([
      "type",
      "requestId",
      "traceparent",
      "sessionId",
      "text",
    ]);
  });

  it("takes a pending prompt back when it fails or an extension handles it", async () => {
    const { client, latest } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;

    const handled = client.prompt("s1", "/noop");
    latest().answer("prompt", { disposition: "handled" });
    await handled;
    const kept = client.prompt("s1", "kept");
    const failed = client.prompt("s1", "x");
    latest().receive(
      JSON.stringify({ type: "response", requestId: "client-1-6", ok: false, error: { code: "session_not_found" } }),
    );
    await expect(failed).rejects.toBeInstanceOf(CommandError);

    expect(client.session("s1")?.getState().pending).toStrictEqual([{ clientMessageId: "client-1-5", text: "kept" }]);
    latest().receive(
      JSON.stringify({ type: "response", requestId: "client-1-5", ok: true, result: { disposition: "started" } }),
    );
    await kept;
  });

  it("takes a pending copy back once the message went into the queue, or pi took it as a steer", async () => {
    const { client, latest } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;

    const queued = client.prompt("s1", "later");
    latest().answer("prompt", { disposition: "queued", itemId: "i1" });
    expect(await queued).toStrictEqual({ disposition: "queued", itemId: "i1" });
    const steered = client.steer("s1", "also");
    latest().answer("steer", { disposition: "queued" });
    await steered;
    const sentIdle = client.steer("s1", "go");
    latest().answer("steer", { disposition: "started" });
    await sentIdle;

    expect(client.session("s1")?.getState().pending).toStrictEqual([{ clientMessageId: "client-1-6", text: "go" }]);
    expect(latest().commands().slice(-1)).toStrictEqual([
      { type: "steer", requestId: "client-1-6", sessionId: "s1", text: "go" },
    ]);
  });

  it("sends the run control commands with their fields and returns their results", async () => {
    const { client, latest } = await connected();
    /** Runs a command and answers it with `result`. */
    const run = async <T>(send: () => Promise<T>, type: string, result: unknown = {}) => {
      const going = send();
      latest().answer(type, result);
      return going;
    };

    expect(await run(() => client.stop("s1"), "stop", { confirmed: false })).toStrictEqual({ confirmed: false });
    await run(() => client.resumeQueue("s1"), "resume_queue");
    await run(() => client.clearQueue("s1"), "clear_queue");
    await run(() => client.updateQueued("s1", "i1", "new"), "update_queued");
    await run(() => client.removeQueued("s1", "i2"), "remove_queued");
    expect(await run(() => client.steerQueued("s1", "i3"), "steer_queued", { disposition: "queued" })).toStrictEqual({
      disposition: "queued",
    });
    await run(() => client.answerInteraction("s1", "d1", { confirmed: true }), "answer_interaction");
    await run(() => client.retryRun("s1"), "retry_run");

    expect(
      latest()
        .commands()
        .filter((command) => command["type"] !== "ping")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "stop", sessionId: "s1" },
      { type: "resume_queue", sessionId: "s1" },
      { type: "clear_queue", sessionId: "s1" },
      { type: "update_queued", sessionId: "s1", itemId: "i1", text: "new" },
      { type: "remove_queued", sessionId: "s1", itemId: "i2" },
      { type: "steer_queued", sessionId: "s1", itemId: "i3" },
      { type: "answer_interaction", sessionId: "s1", interactionId: "d1", answer: { confirmed: true } },
      { type: "retry_run", sessionId: "s1" },
    ]);
  });

  it("sends a prompt for a session it does not watch, without a pending copy", async () => {
    const { client, latest } = await connected();

    const sent = client.prompt("s9", "hi");
    latest().answer("prompt", { disposition: "started" });

    expect(await sent).toStrictEqual({ disposition: "started" });
    const failed = client.prompt("s9", "again");
    latest().receive(
      JSON.stringify({ type: "response", requestId: "client-1-4", ok: false, error: { code: "session_not_found" } }),
    );
    await expect(failed).rejects.toStrictEqual(new CommandError("session_not_found"));
    expect(client.session("s9")).toBeUndefined();
  });

  it("marks the watched sessions lost when the host restarted, keeping what was shown", async () => {
    const { client, latest, clock } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;
    latest().receive(
      event(3, {
        type: "session_snapshot",
        items: [turn("t1")],
        hasOlder: false,
        run: { runId: "r1", startedAt: 1 },
        exited: false,
        control: IDLE_CONTROL,
        model: null,
        fast: false,
        metrics: UNKNOWN_METRICS,
      }),
    );
    const shown = client.session("s1")?.getState().items;
    expect(shown).toStrictEqual([turn("t1")]);

    latest().closeWith(1006);
    clock.advance(250);
    latest().open();
    latest().receive(welcome("0.1.0", "h2"));

    expect(client.session("s1")?.getState()).toMatchObject({ status: "lost", run: null, pending: [] });
    expect(client.session("s1")?.getState().items).toBe(shown);
    // The new host does not know the session, so it is not subscribed again.
    expect(latest().commands()).toStrictEqual([{ type: "ping", requestId: "client-1-4" }]);
  });

  it("fetches the page before the earliest item once at a time, joining a fetch on its way, and puts it in front", async () => {
    const { client, latest } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;
    latest().receive(snapshot(2, [turn("t5")], true));

    const loading = client.loadOlder("s1");
    const again = client.loadOlder("s1");
    expect(again).toBe(loading);
    latest().answer("fetch_transcript", { items: [turn("t3"), turn("t4")], hasOlder: false });
    await Promise.all([loading, again]);
    await client.loadOlder("s1");

    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "fetch_transcript"),
    ).toStrictEqual([
      { type: "fetch_transcript", requestId: "client-1-4", sessionId: "s1", epoch: 1, before: "t5", limit: 50 },
    ]);
    expect(client.session("s1")?.getState()).toMatchObject({
      items: [turn("t3"), turn("t4"), turn("t5")],
      hasOlder: false,
    });
  });

  it("fetches nothing for a session it does not watch, one still loading, lost or empty", async () => {
    const { client, latest, clock } = await connected();
    const watching = client.watch(["s1", "s2"]);
    latest().answer("subscribe_sessions");
    await watching;
    latest().receive(JSON.stringify({ ...JSON.parse(snapshot(0, [], true)), sessionId: "s2" }));

    await client.loadOlder("s9");
    await client.loadOlder("s1");
    await client.loadOlder("s2");
    latest().receive(snapshot(0, [turn("t1")], true));
    latest().closeWith(1006);
    clock.advance(250);
    latest().open();
    latest().receive(welcome("0.1.0", "h2"));
    await client.loadOlder("s1");

    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "fetch_transcript"),
    ).toStrictEqual([]);
  });

  it("asks for a fresh snapshot when the host rebuilt the transcript, and passes other failures on", async () => {
    const { client, latest } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;
    latest().receive(snapshot(2, [turn("t5")], true));

    const changed = client.loadOlder("s1");
    latest().fail("fetch_transcript", "transcript_changed");
    await vi.waitFor(() => expect(subscriptions(latest())).toBe(2));
    latest().answer("subscribe_sessions");
    await vi.waitFor(() => expect(subscriptions(latest())).toBe(3));
    latest().answer("subscribe_sessions");
    await changed;
    expect(client.session("s1")?.getState().status).toBe("loading");

    latest().receive(snapshot(0, [turn("t5")], true));
    const failed = client.loadOlder("s1");
    latest().fail("fetch_transcript", "session_not_found");
    await expect(failed).rejects.toStrictEqual(new CommandError("session_not_found"));
  });

  it("fetches a step whole and puts it in place, and resyncs when the host rebuilt the transcript", async () => {
    const { client, latest } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;
    const preview = {
      kind: "tool",
      id: "0",
      callId: "c",
      tool: "bash",
      args: {},
      status: "done",
      output: "end",
      details: null,
      partial: true,
    };
    latest().receive(snapshot(2, [{ ...turn("t1"), steps: [preview] }]));

    const loaded = client.loadStep("s1", "t1", "0");
    latest().answer("fetch_step", { step: { ...preview, output: "start…end", partial: false } });
    await loaded;
    await client.loadStep("s9", "t1", "0");

    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "fetch_step"),
    ).toStrictEqual([
      { type: "fetch_step", requestId: "client-1-4", sessionId: "s1", epoch: 1, turnId: "t1", stepId: "0" },
    ]);
    expect(client.session("s1")?.getState().items).toStrictEqual([
      { ...turn("t1"), steps: [{ ...preview, output: "start…end", partial: false }] },
    ]);

    const changed = client.loadStep("s1", "t1", "0");
    latest().fail("fetch_step", "transcript_changed");
    await vi.waitFor(() => expect(subscriptions(latest())).toBe(2));
    latest().answer("subscribe_sessions");
    await vi.waitFor(() => expect(subscriptions(latest())).toBe(3));
    latest().answer("subscribe_sessions");
    await changed;
    expect(client.session("s1")?.getState().status).toBe("loading");
    await client.loadStep("s1", "t1", "0");
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "fetch_step"),
    ).toHaveLength(2);
    latest().receive(snapshot(0, [turn("t1")]));
    const failed = client.loadStep("s1", "t1", "0");
    latest().fail("fetch_step", "session_not_found");
    await expect(failed).rejects.toStrictEqual(new CommandError("session_not_found"));
  });

  it("fetches no step for a session that was lost", async () => {
    const { client, latest, clock } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;
    latest().receive(snapshot(0, [turn("t1")]));
    latest().closeWith(1006);
    clock.advance(250);
    latest().open();
    latest().receive(welcome("0.1.0", "h2"));

    await client.loadStep("s1", "t1", "0");

    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "fetch_step"),
    ).toStrictEqual([]);
  });

  it("keeps sessions when it reconnects to the same host", async () => {
    const { client, latest, clock } = await connected();
    const watching = client.watch(["s1"]);
    latest().answer("subscribe_sessions");
    await watching;
    latest().receive(snapshot(0));

    latest().closeWith(1006);
    clock.advance(250);
    latest().open();
    latest().receive(welcome("0.1.0", "h1"));

    expect(client.session("s1")?.getState().status).toBe("ready");
  });
});

/** A list snapshot of host instance `generation` at `seq`, with one session in a workspace. */
function indexSnapshot(seq: number, generation = "h1", fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "index_snapshot",
    generation,
    seq,
    reason: "no_cursor",
    projects: [],
    workspaces: [],
    chats: [],
    sessions: [
      {
        sessionId: "s1",
        containerId: "wks_0123456789abcdef",
        name: null,
        prompt: "hi",
        file: null,
        state: "draft",
        updatedAt: 1,
        archived: false,
        running: false,
        attention: null,
        asking: null,
        handedOff: false,
        parent: null,
      },
    ],
    layout: { container: null, tabs: {} },
    preferences: {
      setupDone: false,
      appearance: "system",
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: null,
      proxy: null,
      inbox: true,
    },
    resets: [],
    ...fields,
  });
}

/** List changes of host instance `h1` at `seq`, removing session `remove`. */
function indexChanges(seq: number, remove: string): string {
  return JSON.stringify({
    type: "index_changes",
    generation: "h1",
    seq,
    projects: { upsert: [], remove: [] },
    workspaces: { upsert: [], remove: [] },
    chats: { upsert: [], remove: [] },
    sessions: { upsert: [], remove: [remove] },
    layout: null,
    preferences: null,
  });
}

/** A layout of a chat with tabs `s1` and `s2`, `active` shown. */
function tabs(active: string | null) {
  return { container: CHAT, tabs: { [CHAT]: { open: ["s1", "s2"], active } } };
}

/** List changes of host instance `h1` at `seq` that carry only a layout. */
function layoutChange(seq: number, layout: unknown): string {
  return JSON.stringify({ ...JSON.parse(indexChanges(seq, "s9")), sessions: { upsert: [], remove: [] }, layout });
}

describe("createAtriumClient: the list", () => {
  it("subscribes to the list on every connection, from where it was once it had a snapshot", async () => {
    const { latest, clock } = await connected();
    /** The list subscriptions the latest socket sent. */
    const subscribed = () =>
      latest()
        .sent.filter((sent) => sent["type"] === "subscribe_index")
        .map(({ requestId: _id, traceparent: _trace, ...command }) => command);
    expect(subscribed()).toStrictEqual([{ type: "subscribe_index" }]);
    latest().receive(indexSnapshot(4));
    latest().receive(indexChanges(5, "s9"));

    latest().closeWith(1006);
    clock.advance(250);
    latest().open();
    latest().receive(welcome());

    expect(subscribed()).toStrictEqual([{ type: "subscribe_index", cursor: { generation: "h1", seq: 5 } }]);
  });

  it("is empty until the first snapshot, takes every snapshot whole and applies changes", async () => {
    const { client, latest } = await connected();
    expect(client.index.getState()).toMatchObject({ ready: false, sessions: [], seq: 0 });
    latest().receive(indexChanges(1, "s1"));
    expect(client.index.getState()).toMatchObject({ ready: false, seq: 0 });

    latest().receive(indexSnapshot(2));
    expect(client.index.getState()).toMatchObject({ ready: true, seq: 2, sessions: [{ sessionId: "s1" }] });
    latest().receive(indexChanges(3, "s1"));
    expect(client.index.getState()).toMatchObject({ generation: "h1", seq: 3, sessions: [] });

    latest().receive(indexSnapshot(1, "h2"));
    expect(client.index.getState()).toMatchObject({ generation: "h2", seq: 1, sessions: [{ sessionId: "s1" }] });
    expect(client.index.getState()).not.toHaveProperty("type");
    expect(client.index.getState()).not.toHaveProperty("reason");
  });

  it("keeps the tab chosen while a layout the host made before reaches it, and takes the host's once answered", async () => {
    const { client, latest } = await connected();
    latest().receive(indexSnapshot(1, "h1", { layout: tabs("s1") }));

    const opened = client.openSession("s2");
    const closed = client.closeTab("s1");
    latest().receive(layoutChange(2, tabs("s1")));
    expect(client.index.getState().layout).toStrictEqual({
      container: CHAT,
      tabs: { [CHAT]: { open: ["s2"], active: "s2" } },
    });
    latest().receive(layoutChange(3, tabs("s2")));
    latest().answer("open_session");
    await opened;
    expect(client.index.getState().layout).toStrictEqual({
      container: CHAT,
      tabs: { [CHAT]: { open: ["s2"], active: "s2" } },
    });

    latest().fail("close_tab", "session_not_found");
    await expect(closed).rejects.toStrictEqual(new CommandError("session_not_found"));
    expect(client.index.getState().layout).toStrictEqual(tabs("s2"));
    latest().receive(layoutChange(4, tabs("s1")));
    expect(client.index.getState().layout).toStrictEqual(tabs("s1"));
  });

  it("keeps a container chosen before the first list arrives once the host answers", async () => {
    const { client, latest } = await connected();

    const selected = client.selectContainer(CHAT);
    latest().answer("select_container");
    await selected;

    expect(client.index.getState().layout).toStrictEqual({ container: CHAT, tabs: {} });
  });

  it("goes back to the host's layout when a command fails, not to one changes of another host left", async () => {
    const { client, latest } = await connected();
    latest().receive(indexSnapshot(1, "h1", { layout: tabs("s1") }));

    const closed = client.closeTab("s1");
    expect(client.index.getState().layout.tabs).toStrictEqual({ [CHAT]: { open: ["s2"], active: "s2" } });
    latest().receive(JSON.stringify({ ...JSON.parse(layoutChange(2, tabs("s2"))), generation: "h2" }));
    latest().fail("close_tab", "session_not_found");
    await expect(closed).rejects.toStrictEqual(new CommandError("session_not_found"));

    expect(client.index.getState().layout).toStrictEqual(tabs("s1"));
  });

  it("goes back to the host's layout when a command fails, though list changes without a layout came meanwhile", async () => {
    const { client, latest } = await connected();
    latest().receive(indexSnapshot(1, "h1", { layout: tabs("s1") }));

    const closed = client.closeTab("s1");
    latest().receive(indexChanges(2, "s9"));
    expect(client.index.getState().layout.tabs).toStrictEqual({ [CHAT]: { open: ["s2"], active: "s2" } });
    latest().fail("close_tab", "session_not_found");
    await expect(closed).rejects.toStrictEqual(new CommandError("session_not_found"));

    expect(client.index.getState().layout).toStrictEqual(tabs("s1"));
  });

  it("shows tab and preference changes at once, before the host confirms them", async () => {
    const { client, latest } = await connected();
    latest().receive(indexSnapshot(1));

    const opened = client.openSession("s1");
    expect(client.index.getState().layout).toStrictEqual({
      container: "wks_0123456789abcdef",
      tabs: { wks_0123456789abcdef: { open: ["s1"], active: "s1" } },
    });
    const closed = client.closeTab("s1");
    expect(client.index.getState().layout.tabs).toStrictEqual({ wks_0123456789abcdef: { open: [], active: null } });
    const selected = client.selectContainer(CHAT);
    expect(client.index.getState().layout.container).toBe(CHAT);
    const preferred = client.setPreferences({ appearance: "dark" });
    expect(client.index.getState().preferences).toStrictEqual({
      setupDone: false,
      appearance: "dark",
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: null,
      proxy: null,
      inbox: true,
    });

    for (const type of ["open_session", "close_tab", "select_container", "set_preferences"]) latest().answer(type);
    expect(await Promise.all([opened, closed, selected, preferred])).toStrictEqual([{}, {}, {}, {}]);
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] !== "ping")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "open_session", sessionId: "s1" },
      { type: "close_tab", sessionId: "s1" },
      { type: "select_container", containerId: CHAT },
      { type: "set_preferences", appearance: "dark" },
    ]);
  });

  it("shows a proxy only once the host has checked it, and the other preferences at once", async () => {
    const { client, latest } = await connected();
    latest().receive(indexSnapshot(1));

    const preferred = client.setPreferences({
      appearance: "dark",
      proxy: { url: "HTTP://127.0.0.1:7897/", noProxy: [] },
    });

    expect(client.index.getState().preferences).toMatchObject({ appearance: "dark", proxy: null });
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "set_preferences")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "set_preferences", appearance: "dark", proxy: { url: "HTTP://127.0.0.1:7897/", noProxy: [] } },
    ]);
    latest().fail("set_preferences", "proxy_invalid");
    await expect(preferred).rejects.toStrictEqual(new CommandError("proxy_invalid"));
    expect(client.index.getState().preferences.proxy).toBeNull();
  });
});

/** A connected client watching s1, whose snapshot says pi uses `model`. */
async function watchingWithModel(model: unknown, fast = false) {
  const setup = await connected();
  const watched = setup.client.watch(["s1"]);
  setup.latest().answer("subscribe_sessions");
  await watched;
  setup.latest().receive(
    event(1, {
      type: "session_snapshot",
      items: [],
      hasOlder: false,
      run: null,
      exited: false,
      control: IDLE_CONTROL,
      model,
      fast,
      metrics: UNKNOWN_METRICS,
    }),
  );
  return setup;
}

describe("createAtriumClient: models", () => {
  const WORKSPACE = "wks_0123456789abcdef";
  const opus = { providerId: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" } as const;
  const listed = {
    providerId: "anthropic",
    modelId: "haiku",
    name: "Haiku",
    contextWindow: 200_000,
    maxOutput: 64_000,
    supportsImage: true,
    thinkingLevels: ["off"],
    fast: null,
  };

  it("lists a container's models into its view, keeping them shown while it asks again", async () => {
    const { client, latest } = await connected();
    const list = client.models(WORKSPACE);
    expect(list.getState()).toStrictEqual({ status: "idle", models: [], defaultModel: null, error: null });
    expect(client.models(WORKSPACE)).toBe(list);

    const loading = client.loadModels(WORKSPACE);
    expect(list.getState()).toStrictEqual({ status: "loading", models: [], defaultModel: null, error: null });
    latest().answer("list_models", { models: [listed], defaultModel: { providerId: "anthropic", modelId: "haiku" } });
    await loading;
    const ready = {
      status: "ready",
      models: [listed],
      defaultModel: { providerId: "anthropic", modelId: "haiku" },
      error: null,
    };
    expect(list.getState()).toStrictEqual(ready);
    const again = client.loadModels(WORKSPACE, true);
    expect(list.getState()).toStrictEqual({ ...ready, status: "loading" });
    latest().answer("list_models", { models: [], defaultModel: null });
    await again;

    expect(list.getState()).toStrictEqual({ status: "ready", models: [], defaultModel: null, error: null });
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "list_models")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "list_models", workspaceId: WORKSPACE, refresh: false },
      { type: "list_models", workspaceId: WORKSPACE, refresh: true },
    ]);
  });

  it("shows a list that failed with its error and no models", async () => {
    const { client, latest } = await connected();
    const first = client.loadModels(null);
    latest().answer("list_models", { models: [listed], defaultModel: null });
    await first;

    const failing = client.loadModels(null, true);
    latest().fail("list_models", "models_unavailable");
    await failing;

    expect(client.models(null).getState()).toStrictEqual({
      status: "failed",
      models: [],
      defaultModel: null,
      error: new CommandError("models_unavailable"),
    });
  });

  it("switches a session's model at once in its view, and puts it back when the host refuses", async () => {
    const { client, latest } = await watchingWithModel(opus);
    const view = present(client.session("s1"), "the view of s1");

    const switching = client.setModel("s1", { providerId: "anthropic", modelId: "haiku" });
    expect(view.getState().model).toStrictEqual({ providerId: "anthropic", modelId: "haiku", thinkingLevel: "high" });
    latest().fail("set_model", "pi_rejected");

    await expect(switching).rejects.toStrictEqual(new CommandError("pi_rejected"));
    expect(view.getState().model).toStrictEqual(opus);
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "set_model"),
    ).toStrictEqual([
      { type: "set_model", requestId: expect.any(String), sessionId: "s1", providerId: "anthropic", modelId: "haiku" },
    ]);
  });

  it("sets a session's thinking level at once in its view, keeping what the host reported since", async () => {
    const { client, latest } = await watchingWithModel(opus);
    const view = present(client.session("s1"), "the view of s1");

    const setting = client.setThinkingLevel("s1", "low");
    expect(view.getState().model).toStrictEqual({ ...opus, thinkingLevel: "low" });
    latest().receive(event(2, { type: "model_updated", model: { ...opus, thinkingLevel: "minimal" } }));
    latest().fail("set_thinking_level", "pi_rejected");

    await expect(setting).rejects.toStrictEqual(new CommandError("pi_rejected"));
    expect(view.getState().model).toStrictEqual({ ...opus, thinkingLevel: "minimal" });
    const succeeding = client.setThinkingLevel("s1", "max");
    latest().answer("set_thinking_level");
    await succeeding;
    expect(view.getState().model).toStrictEqual({ ...opus, thinkingLevel: "max" });
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "set_thinking_level"),
    ).toStrictEqual([
      { type: "set_thinking_level", requestId: expect.any(String), sessionId: "s1", level: "low" },
      { type: "set_thinking_level", requestId: expect.any(String), sessionId: "s1", level: "max" },
    ]);
  });

  it("switches a session's Fast at once in its view, keeping what the host took", async () => {
    const { client, latest } = await watchingWithModel(opus);
    const view = present(client.session("s1"), "the view of s1");

    const switching = client.setFast("s1", true);
    expect(view.getState().fast).toBe(true);
    latest().answer("set_fast");
    expect(await switching).toStrictEqual({});

    expect(view.getState().fast).toBe(true);
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "set_fast"),
    ).toStrictEqual([{ type: "set_fast", requestId: expect.any(String), sessionId: "s1", enabled: true }]);
  });

  it("puts Fast back as the host last took it once no switch is on its way", async () => {
    const { client, latest } = await watchingWithModel(opus);
    const view = present(client.session("s1"), "the view of s1");

    const off = client.setFast("s1", false);
    const on = client.setFast("s1", true);
    latest().fail("set_fast", "fast_unavailable", 0);
    await expect(off).rejects.toStrictEqual(new CommandError("fast_unavailable"));
    // The switch still on its way decides.
    expect(view.getState().fast).toBe(true);
    answerAt(latest(), "set_fast", 1, {});
    await on;

    const onAgain = client.setFast("s1", true);
    latest().fail("set_fast", "session_stopping", 2);
    await expect(onAgain).rejects.toStrictEqual(new CommandError("session_stopping"));
    const refused = client.setFast("s1", false);
    latest().fail("set_fast", "pi_unavailable", 3);
    await expect(refused).rejects.toStrictEqual(new CommandError("pi_unavailable"));
    expect(view.getState().fast).toBe(true);

    // Another client switched it off; a refused switch then goes back to that.
    latest().receive(event(2, { type: "fast_updated", fast: false }));
    const later = client.setFast("s1", true);
    latest().fail("set_fast", "pi_unavailable", 4);
    await expect(later).rejects.toStrictEqual(new CommandError("pi_unavailable"));
    expect(view.getState().fast).toBe(false);
  });

  it("puts Fast back as the host took it last though other events came while a refused switch was on its way", async () => {
    const { client, latest } = await watchingWithModel(opus);
    const view = present(client.session("s1"), "the view of s1");

    const on = client.setFast("s1", true);
    latest().receive(event(2, { type: "run_started", runId: "r1", startedAt: 9 }));
    latest().fail("set_fast", "pi_unavailable", 0);
    await expect(on).rejects.toStrictEqual(new CommandError("pi_unavailable"));

    expect(view.getState().fast).toBe(false);
  });

  it("puts Fast back as the host has it after another client switched it while a refused switch was on its way", async () => {
    const { client, latest } = await watchingWithModel(opus);
    const view = present(client.session("s1"), "the view of s1");

    const on = client.setFast("s1", true);
    latest().receive(event(2, { type: "fast_updated", fast: true }));
    latest().fail("set_fast", "pi_unavailable", 0);
    await expect(on).rejects.toStrictEqual(new CommandError("pi_unavailable"));
    const shown = view.getState().fast;
    const off = client.setFast("s1", false);
    // A fresh snapshot after a reconnect, another client having switched it off.
    latest().receive(
      event(3, {
        type: "session_snapshot",
        items: [],
        hasOlder: false,
        run: null,
        exited: false,
        control: IDLE_CONTROL,
        model: opus,
        fast: false,
        metrics: UNKNOWN_METRICS,
      }),
    );
    latest().fail("set_fast", "pi_unavailable", 1);
    await expect(off).rejects.toStrictEqual(new CommandError("pi_unavailable"));

    expect([shown, view.getState().fast]).toStrictEqual([true, false]);
  });

  it("keeps what the host took for a switch made while an earlier one is still on its way", async () => {
    const { client, latest } = await watchingWithModel(opus);
    const view = present(client.session("s1"), "the view of s1");

    const on = client.setFast("s1", true);
    const off = client.setFast("s1", false);
    answerAt(latest(), "set_fast", 0, {});
    await on;
    const onAgain = client.setFast("s1", true);
    latest().fail("set_fast", "pi_unavailable", 1);
    await expect(off).rejects.toStrictEqual(new CommandError("pi_unavailable"));
    latest().fail("set_fast", "pi_unavailable", 2);
    await expect(onAgain).rejects.toStrictEqual(new CommandError("pi_unavailable"));

    expect(view.getState().fast).toBe(true);
  });

  it("follows the Fast the host reports", async () => {
    const { client, latest } = await watchingWithModel(opus);

    latest().receive(event(2, { type: "fast_updated", fast: true }));

    expect(client.session("s1")?.getState().fast).toBe(true);
  });

  it("sends a switch for a session it does not watch, showing nothing", async () => {
    const { client, latest } = await connected();

    const switching = client.setFast("s2", false);
    latest().answer("set_fast");

    expect(await switching).toStrictEqual({});
    expect(client.session("s2")).toBeUndefined();
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] !== "ping"),
    ).toStrictEqual([{ type: "set_fast", requestId: expect.any(String), sessionId: "s2", enabled: false }]);
  });

  it("goes back to the model the host last reported when two changes on their way both fail", async () => {
    const { client, latest } = await watchingWithModel(opus);
    const view = present(client.session("s1"), "the view of s1");

    const switching = client.setModel("s1", { providerId: "anthropic", modelId: "haiku" });
    const setting = client.setThinkingLevel("s1", "low");
    expect(view.getState().model).toStrictEqual({ providerId: "anthropic", modelId: "haiku", thinkingLevel: "low" });
    latest().fail("set_model", "pi_rejected");
    await expect(switching).rejects.toStrictEqual(new CommandError("pi_rejected"));
    expect(view.getState().model).toStrictEqual({ providerId: "anthropic", modelId: "haiku", thinkingLevel: "low" });
    latest().fail("set_thinking_level", "pi_rejected");
    await expect(setting).rejects.toStrictEqual(new CommandError("pi_rejected"));

    expect(view.getState().model).toStrictEqual(opus);
  });

  it("goes back to the host's model, not a guess, after a third change joins two on their way", async () => {
    const { client, latest } = await watchingWithModel(opus);
    const view = present(client.session("s1"), "the view of s1");

    const switching = client.setModel("s1", { providerId: "anthropic", modelId: "haiku" });
    const lowering = client.setThinkingLevel("s1", "low");
    latest().answer("set_model");
    await switching;
    const raising = client.setThinkingLevel("s1", "max");
    latest().fail("set_thinking_level", "pi_rejected", 0);
    await Promise.allSettled([lowering]);
    latest().fail("set_thinking_level", "pi_rejected", 1);
    await Promise.allSettled([raising]);

    expect(view.getState().model).toStrictEqual(opus);
  });

  it("counts a change the host took as the model to go back to, once none is on its way", async () => {
    const { client, latest } = await watchingWithModel(opus);
    const view = present(client.session("s1"), "the view of s1");
    const switching = client.setModel("s1", { providerId: "anthropic", modelId: "haiku" });
    latest().answer("set_model");
    await switching;

    const lowering = client.setThinkingLevel("s1", "low");
    latest().fail("set_thinking_level", "pi_rejected");
    await expect(lowering).rejects.toStrictEqual(new CommandError("pi_rejected"));

    expect(view.getState().model).toStrictEqual({ ...opus, modelId: "haiku" });
  });

  it("goes back to what the host reported between two changes, not to the first guess", async () => {
    const { client, latest } = await watchingWithModel(opus);
    const view = present(client.session("s1"), "the view of s1");

    const switching = client.setModel("s1", { providerId: "anthropic", modelId: "haiku" });
    latest().receive(
      event(2, { type: "model_updated", model: { ...opus, modelId: "haiku", thinkingLevel: "medium" } }),
    );
    const setting = client.setThinkingLevel("s1", "low");
    latest().answer("set_model");
    await switching;
    latest().fail("set_thinking_level", "pi_rejected");
    await expect(setting).rejects.toStrictEqual(new CommandError("pi_rejected"));

    expect(view.getState().model).toStrictEqual({ ...opus, modelId: "haiku", thinkingLevel: "medium" });
  });

  it("changes nothing at once for a session whose model it does not know", async () => {
    const { client, latest } = await watchingWithModel(null);

    const setting = client.setThinkingLevel("s1", "low");
    const switching = client.setModel("s2", { providerId: "a", modelId: "b" });
    expect(client.session("s1")?.getState().model).toBeNull();
    latest().answer("set_thinking_level");
    latest().answer("set_model");

    expect(await setting).toStrictEqual({});
    expect(await switching).toStrictEqual({});
  });
});

describe("createAtriumClient: the composer's lists", () => {
  it("asks for a session's commands and for files, returning what the host lists", async () => {
    const { client, latest } = await connected();
    const commands = [{ name: "review", description: null, source: "prompt" }];
    const files = [{ path: "src/", directory: true }];

    const listing = client.listCommands("s1");
    latest().answer("list_commands", { commands });
    const searching = client.searchFiles("s1", "src");
    latest().answer("search_files", { files });

    expect(await listing).toStrictEqual({ commands });
    expect(await searching).toStrictEqual({ files });
    expect(
      latest()
        .commands()
        .filter((command) => ["list_commands", "search_files"].includes(String(command["type"])))
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "list_commands", sessionId: "s1" },
      { type: "search_files", sessionId: "s1", query: "src" },
    ]);
  });
});

describe("createAtriumClient: a workspace's files", () => {
  it("lists a directory and reads a file of a workspace, returning what the host answers", async () => {
    const { client, latest } = await connected();
    const entries = [{ name: "src", kind: "dir" }];
    const content = { kind: "text", text: "a" };

    const W1 = "wks_0000000000000001";
    const listing = client.listDir(W1, "src");
    latest().answer("list_dir", { entries, truncated: false });
    const reading = client.readFile(W1, "src/a.ts");
    latest().answer("read_file", { size: 1, content });

    expect(await listing).toStrictEqual({ entries, truncated: false });
    expect(await reading).toStrictEqual({ size: 1, content });
    expect(
      latest()
        .commands()
        .filter((command) => ["list_dir", "read_file"].includes(String(command["type"])))
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "list_dir", workspaceId: W1, path: "src" },
      { type: "read_file", workspaceId: W1, path: "src/a.ts" },
    ]);
  });
});

describe("createAtriumClient: compacting", () => {
  it("asks the host to compact a session, with what to keep in mind when given", async () => {
    const { client, latest } = await connected();

    const asked = client.compactSession("s1", "keep the API");
    latest().answer("compact_session");
    const plain = client.compactSession("s1");
    latest().answer("compact_session");

    expect(await asked).toStrictEqual({});
    expect(await plain).toStrictEqual({});
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "compact_session")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "compact_session", sessionId: "s1", instructions: "keep the API" },
      { type: "compact_session", sessionId: "s1" },
    ]);
  });
});

describe("createAtriumClient: exporting", () => {
  it("asks the host for a session's page, returning it", async () => {
    const { client, latest } = await connected();

    const exporting = client.exportSession("s1");
    latest().answer("export_session", { html: "<html></html>" });

    expect(await exporting).toStrictEqual({ html: "<html></html>" });
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "export_session")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([{ type: "export_session", sessionId: "s1" }]);
  });
});

describe("createAtriumClient: forking", () => {
  it("asks the host to fork a session after a turn, returning the new session", async () => {
    const { client, latest } = await connected();

    const forking = client.forkSession("s1", "s1:u2", "修 bug（分叉）");
    latest().answer("fork_session", { sessionId: "s2" });

    expect(await forking).toStrictEqual({ sessionId: "s2" });
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "fork_session")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([{ type: "fork_session", sessionId: "s1", turnId: "s1:u2", name: "修 bug（分叉）" }]);
  });
});

describe("createAtriumClient: child conversations", () => {
  it("asks the host for an empty child, a child forked from a turn, and a detach, with their places", async () => {
    const { client, latest } = await connected();
    const child = { parentSessionId: "s1", name: "补测试", place: "worktree", branch: "atrium/tests" } as const;

    const created = client.createChild("wks_0123456789abcdef", child);
    latest().answer("create_session", { sessionId: "s3" });
    const forked = client.forkSession("s1", "s1:u2", "查日志", { place: "same" });
    latest().answer("fork_session", { sessionId: "s4" });
    const detached = client.detachSession("s3");
    latest().answer("detach_session", {});

    expect([await created, await forked, await detached]).toStrictEqual([{ sessionId: "s3" }, { sessionId: "s4" }, {}]);
    expect(
      latest()
        .commands()
        .filter((command) => ["create_session", "fork_session", "detach_session"].includes(String(command["type"])))
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "create_session", containerId: "wks_0123456789abcdef", child },
      { type: "fork_session", sessionId: "s1", turnId: "s1:u2", name: "查日志", child: { place: "same" } },
      { type: "detach_session", sessionId: "s3" },
    ]);
  });
});

describe("createAtriumClient: message images", () => {
  it("asks for one image of a turn, returning what the host read", async () => {
    const { client, latest } = await connected();

    const fetching = client.fetchImage("s1", "s1:u2", 1);
    latest().answer("fetch_image", { mimeType: "image/webp", data: "eA==" });

    expect(await fetching).toStrictEqual({ mimeType: "image/webp", data: "eA==" });
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "fetch_image")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([{ type: "fetch_image", sessionId: "s1", turnId: "s1:u2", index: 1 }]);
  });
});

describe("createAtriumClient: first launch", () => {
  it("asks what first launch checks, keeping the last answer while asking again, and lands only the latest ask's answer", async () => {
    const { client, latest } = await connected();
    const missing = setupState("missing");
    const ready = setupState("ready");
    const before = client.setup.getState();

    const first = client.loadSetup();
    const asking = client.setup.getState();
    latest().answer("check_setup", missing);
    await first;
    const answered = client.setup.getState();
    const older = client.loadSetup(true);
    const again = client.setup.getState();
    const newer = client.loadSetup();
    latest().answer("check_setup", ready);
    await newer;
    answerAt(latest(), "check_setup", 1, missing);
    await older;

    expect(before).toStrictEqual({ status: "idle", state: null, error: null });
    expect(asking).toStrictEqual({ status: "loading", state: null, error: null });
    expect(answered).toStrictEqual({ status: "ready", state: missing, error: null });
    expect(again).toStrictEqual({ status: "loading", state: missing, error: null });
    expect(client.setup.getState()).toStrictEqual({ status: "ready", state: ready, error: null });
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "check_setup")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "check_setup", refresh: false },
      { type: "check_setup", refresh: true },
      { type: "check_setup", refresh: false },
    ]);
  });

  it("keeps a failed ask's reason with the last answer, and drops a failure an ask since has overtaken", async () => {
    const { client, latest } = await connected();
    const ready = setupState("ready");

    const first = client.loadSetup();
    latest().answer("check_setup", ready);
    await first;
    const failing = client.loadSetup();
    latest().fail("check_setup", "internal_error");
    await failing;
    const failed = client.setup.getState();
    const overtaken = client.loadSetup();
    const latestAsk = client.loadSetup();
    latest().answer("check_setup", ready);
    await latestAsk;
    latest().fail("check_setup", "internal_error", 2);
    await overtaken;

    expect(failed).toMatchObject({ status: "failed", state: ready });
    expect(failed.error).toBeInstanceOf(CommandError);
    expect(client.setup.getState()).toStrictEqual({ status: "ready", state: ready, error: null });
  });

  it("asks again without reading the login shell once asked before, when an install succeeds, when pi's credentials change and on a new host", async () => {
    const { client, latest, clock, sockets } = await connected();
    const job = {
      type: "install_updated",
      jobId: "j1",
      kind: "install_pi",
      running: null,
      exitCode: null,
      reason: null,
    };
    const login = {
      type: "login_updated",
      loginId: "l1",
      providerId: "acme",
      method: "oauth",
      authUrl: null,
      deviceCode: null,
      questions: [],
      progress: null,
      error: null,
    };
    /** How many `check_setup` the client sent on the latest socket. */
    const asks = (): number =>
      latest()
        .commands()
        .filter((command) => command["type"] === "check_setup").length;

    latest().receive(JSON.stringify({ ...job, state: "ok", exitCode: 0 }));
    latest().receive(JSON.stringify({ type: "credentials_changed" }));
    const unasked = asks();
    const first = client.loadSetup();
    latest().answer("check_setup", setupState("ready"));
    await first;
    latest().receive(JSON.stringify({ ...job, state: "running" }));
    latest().receive(JSON.stringify({ ...job, state: "failed", exitCode: 1, reason: "exit" }));
    latest().receive(JSON.stringify({ ...login, state: "running" }));
    latest().receive(JSON.stringify({ ...login, state: "failed", error: { reason: "failed", detail: null } }));
    const unchanged = asks();
    latest().receive(JSON.stringify({ ...job, state: "ok", exitCode: 0 }));
    const afterInstall = asks();
    // The host tells every window that the credentials changed; the login's end or the logout's
    // answer alone asks nothing more.
    latest().receive(JSON.stringify({ ...login, state: "ok" }));
    const loggedOut = client.logout("acme");
    latest().answer("logout");
    await loggedOut;
    const afterLogout = asks();
    latest().receive(JSON.stringify({ type: "credentials_changed" }));
    const afterChange = asks();
    latest().closeWith(1006);
    clock.advance(250);
    latest().open();
    latest().receive(welcome("0.1.0", "h1"));
    const sameHost = asks();
    latest().closeWith(1006);
    clock.advance(250);
    latest().open();
    latest().receive(welcome("0.1.0", "h2"));

    expect([unasked, unchanged, afterInstall, afterLogout, afterChange, sameHost, asks()]).toStrictEqual([
      0, 1, 2, 2, 3, 0, 1,
    ]);
    expect(
      sockets
        .flatMap((socket) => socket.commands())
        .filter((command) => command["type"] === "check_setup")
        .map((command) => command["refresh"]),
    ).toStrictEqual([false, false, false, false]);
  });

  it("counts a latest pi found at the clock's start as found, and one never found as older", async () => {
    const { client, latest } = await connected();
    const ready = setupState("ready");

    const first = client.loadSetup();
    latest().answer("check_setup", { ...ready, pi: { ...ready.pi, latest: "1.2.0", checkedAt: 0 } });
    await first;
    const foundAtStart = client.setup.getState().state?.pi;
    latest().receive(JSON.stringify({ type: "pi_latest", latest: "1.3.0", checkedAt: 1 }));
    const second = client.loadSetup();
    latest().answer("check_setup", ready);
    await second;

    expect(foundAtStart).toStrictEqual({ ...ready.pi, latest: "1.2.0", checkedAt: 0 });
    expect(client.setup.getState().state?.pi).toStrictEqual({ ...ready.pi, latest: "1.3.0", checkedAt: 1 });
  });

  it("reloads the model lists asked for once pi's credentials change, and leaves the others", async () => {
    const { client, latest } = await connected();
    const models = { models: [], defaultModel: null };
    const signedIn = {
      providerId: "acme",
      modelId: "fast",
      name: "Fast",
      contextWindow: 200_000,
      maxOutput: 64_000,
      supportsImage: false,
      thinkingLevels: ["off"],
      fast: null,
    };
    const loading = client.loadModels(null);
    latest().answer("list_models", models);
    await loading;
    client.models("wks_0123456789abcdef");

    latest().receive(JSON.stringify({ type: "credentials_changed" }));
    const reloading = client.models(null).getState();
    latest().answer("list_models", { models: [signedIn], defaultModel: null });

    expect(reloading.status).toBe("loading");
    await vi.waitFor(() => expect(client.models(null).getState().models).toStrictEqual([signedIn]));
    expect(client.models("wks_0123456789abcdef").getState().status).toBe("idle");
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "list_models")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "list_models", workspaceId: null, refresh: false },
      { type: "list_models", workspaceId: null, refresh: false },
    ]);
  });

  it("forgets the login and the job of a host that is gone, and keeps them for the same host", async () => {
    const { client, latest, clock } = await connected();
    const job = {
      type: "install_updated",
      jobId: "j1",
      kind: "install_pi",
      state: "running",
      running: null,
      exitCode: null,
      reason: null,
    };
    const login = {
      type: "login_updated",
      loginId: "l1",
      providerId: "acme",
      method: "oauth",
      state: "running",
      authUrl: null,
      deviceCode: null,
      questions: [],
      progress: null,
      error: null,
    };
    latest().receive(JSON.stringify(job));
    latest().receive(JSON.stringify({ type: "install_output", jobId: "j1", text: "one\n" }));
    latest().receive(JSON.stringify(login));

    latest().closeWith(1006);
    clock.advance(250);
    latest().open();
    latest().receive(welcome("0.1.0", "h1"));
    // The host tells what it has right after the welcome; the output it does not.
    latest().receive(JSON.stringify({ ...job, state: "failed", exitCode: 1, reason: "exit" }));
    const sameJob = client.installJob.getState();
    const sameLogin = client.loginState.getState();
    latest().closeWith(1006);
    clock.advance(250);
    latest().open();
    latest().receive(welcome("0.1.0", "h2"));

    expect(sameJob).toStrictEqual({ job: { ...job, state: "failed", exitCode: 1, reason: "exit" }, output: "one\n" });
    expect(sameLogin).toStrictEqual(login);
    expect(client.installJob.getState()).toBeNull();
    expect(client.loginState.getState()).toBeNull();
  });

  it("signs in and out through the host, and shows the latest state of a login from any window", async () => {
    const { client, latest } = await connected();
    const running = {
      type: "login_updated",
      loginId: "l1",
      providerId: "acme",
      method: "oauth",
      state: "running",
      authUrl: { url: "https://acme.test/authorize", instructions: null },
      deviceCode: null,
      questions: [{ promptId: 2, kind: "text", message: "Code?", placeholder: null, options: [] }],
      progress: null,
      error: null,
    };
    const before = client.loginState.getState();

    const started = client.login("acme", "oauth");
    latest().answer("login", { loginId: "l1" });
    const withKey = client.login("deepseek", "api_key", "sk-1");
    latest().answer("login", { loginId: "l2" });
    const answered = client.answerLogin("l1", 2, "42");
    latest().answer("answer_login");
    const cancelled = client.cancelLogin("l1");
    latest().answer("cancel_login");
    const loggedOut = client.logout("acme");
    latest().answer("logout");
    latest().receive(JSON.stringify(running));
    const shown = client.loginState.getState();
    latest().receive(JSON.stringify({ ...running, state: "ok", questions: [] }));

    expect(before).toBeNull();
    expect(await Promise.all([started, withKey, answered, cancelled, loggedOut])).toStrictEqual([
      { loginId: "l1" },
      { loginId: "l2" },
      {},
      {},
      {},
    ]);
    expect(shown).toStrictEqual(running);
    expect(client.loginState.getState()).toStrictEqual({ ...running, state: "ok", questions: [] });
    expect(
      latest()
        .commands()
        .filter((command) => ["login", "answer_login", "cancel_login", "logout"].includes(String(command["type"])))
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "login", providerId: "acme", method: "oauth" },
      { type: "login", providerId: "deepseek", method: "api_key", key: "sk-1" },
      { type: "answer_login", loginId: "l1", promptId: 2, value: "42" },
      { type: "cancel_login", loginId: "l1" },
      { type: "logout", providerId: "acme" },
    ]);
  });

  it("installs and updates through the host, and keeps the job under way with its output", async () => {
    const { client, latest } = await connected();
    const waiting = {
      type: "install_updated",
      jobId: "j1",
      kind: "update_pi",
      state: "waiting",
      running: 1,
      exitCode: null,
      reason: null,
    };
    const before = client.installJob.getState();

    const results = [client.installPi(), client.installNode(), client.updatePi(), client.cancelInstall("j1")];
    latest().answer("install_pi", { jobId: "j1" });
    latest().answer("install_node", { jobId: "j2" });
    latest().answer("update_pi", { jobId: "j3" });
    latest().answer("cancel_install");
    latest().receive(JSON.stringify({ type: "install_output", jobId: "j0", text: "not this job" }));
    latest().receive(JSON.stringify(waiting));
    const shown = client.installJob.getState();
    latest().receive(JSON.stringify({ ...waiting, state: "running", running: null }));
    latest().receive(JSON.stringify({ type: "install_output", jobId: "j1", text: "one\r" }));
    latest().receive(JSON.stringify({ type: "install_output", jobId: "j0", text: "not this job" }));
    latest().receive(JSON.stringify({ type: "install_output", jobId: "j1", text: "two\n" }));
    latest().receive(JSON.stringify({ ...waiting, state: "ok", running: null, exitCode: 0 }));
    const done = client.installJob.getState();
    latest().receive(JSON.stringify({ ...waiting, jobId: "j2", kind: "install_pi", state: "running", running: null }));

    expect(before).toBeNull();
    expect(await Promise.all(results)).toStrictEqual([{ jobId: "j1" }, { jobId: "j2" }, { jobId: "j3" }, {}]);
    expect(shown).toStrictEqual({ job: waiting, output: "" });
    expect(done).toStrictEqual({ job: { ...waiting, state: "ok", running: null, exitCode: 0 }, output: "one\rtwo\n" });
    expect(client.installJob.getState()).toStrictEqual({
      job: { ...waiting, jobId: "j2", kind: "install_pi", state: "running", running: null },
      output: "",
    });
    expect(
      latest()
        .commands()
        .filter((command) =>
          ["install_pi", "install_node", "update_pi", "cancel_install"].includes(String(command["type"])),
        )
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "install_pi" },
      { type: "install_node" },
      { type: "update_pi" },
      { type: "cancel_install", jobId: "j1" },
    ]);
  });

  it("looks for the latest pi when asked, and puts the latest the host found from any look into the setup", async () => {
    const { client, latest } = await connected();
    const found = { latest: "1.2.0", checkedAt: 7 };
    const later = { latest: "1.3.0", checkedAt: 8 };
    const ready = setupState("ready");

    latest().receive(JSON.stringify({ type: "pi_latest", ...found }));
    const unasked = client.setup.getState();
    const first = client.loadSetup();
    latest().answer("check_setup", ready);
    await first;
    const kept = client.setup.getState().state?.pi;
    const checking = client.checkPiUpdate();
    latest().receive(JSON.stringify({ type: "pi_latest", ...later }));
    latest().answer("check_pi_update", later);

    expect(unasked).toStrictEqual({ status: "idle", state: null, error: null });
    // Pushed before the answer, which the host gave from before it found it.
    expect(kept).toStrictEqual({ ...ready.pi, ...found });
    expect(await checking).toStrictEqual(later);
    expect(client.setup.getState()).toStrictEqual({
      status: "ready",
      state: { ...ready, pi: { ...ready.pi, ...later } },
      error: null,
    });
    expect(
      latest()
        .commands()
        .filter((command) => command["type"] === "check_pi_update")
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([{ type: "check_pi_update" }]);
  });

  it("keeps whichever latest pi was found later when an answer and a push cross", async () => {
    const { client, latest } = await connected();
    const ready = setupState("ready");

    const first = client.loadSetup();
    latest().receive(JSON.stringify({ type: "pi_latest", latest: "1.3.0", checkedAt: 9 }));
    latest().answer("check_setup", { ...ready, pi: { ...ready.pi, latest: "1.2.0", checkedAt: 8 } });
    await first;
    const crossed = client.setup.getState().state?.pi;
    const second = client.loadSetup();
    latest().answer("check_setup", { ...ready, pi: { ...ready.pi, latest: "1.4.0", checkedAt: 10 } });
    await second;

    expect(crossed).toStrictEqual({ ...ready.pi, latest: "1.3.0", checkedAt: 9 });
    expect(client.setup.getState().state?.pi).toStrictEqual({ ...ready.pi, latest: "1.4.0", checkedAt: 10 });
  });

  it("asks for the directories of pi's history that could become projects, and chooses main branches", async () => {
    const { client, latest } = await connected();
    const directories = [{ path: "/work/app", sessions: 2, lastUsedAt: 5 }];
    const project = "prj_0123456789abcdef";

    const discovering = client.discoverProjects();
    latest().answer("discover_projects", { directories });
    const listing = client.listBranches(project);
    latest().answer("list_branches", { branches: ["main"], head: "main" });
    const choosing = client.setMainBranch(project, "main");
    latest().answer("set_main_branch");

    expect(await Promise.all([discovering, listing, choosing])).toStrictEqual([
      { directories },
      { branches: ["main"], head: "main" },
      {},
    ]);
    expect(
      latest()
        .commands()
        .filter((command) =>
          ["discover_projects", "list_branches", "set_main_branch"].includes(String(command["type"])),
        )
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "discover_projects" },
      { type: "list_branches", projectId: project },
      { type: "set_main_branch", projectId: project, branch: "main" },
    ]);
  });

  it("keeps only the last mebibyte of a job's output", async () => {
    const { client, latest } = await connected();
    latest().receive(
      JSON.stringify({
        type: "install_updated",
        jobId: "j1",
        kind: "install_node",
        state: "running",
        running: null,
        exitCode: null,
        reason: null,
      }),
    );

    latest().receive(JSON.stringify({ type: "install_output", jobId: "j1", text: "a".repeat(1_048_576) }));
    latest().receive(JSON.stringify({ type: "install_output", jobId: "j1", text: "bc" }));

    const { output } = present(client.installJob.getState(), "the job");
    expect(output.length).toBe(1_048_576);
    expect(output.slice(-3)).toBe("abc");
  });
});

describe("createAtriumClient: plans", () => {
  it("shows no plans until the host pushes them, then each push whole, and a malformed one not at all", async () => {
    const { client, latest } = await connected();
    const grok = {
      provider: "xai",
      plan: null,
      windows: [
        {
          seconds: 604_800,
          model: null,
          usedPercent: 34,
          resetsAt: 9,
          parts: [{ name: "GrokBuild", usedPercent: 33 }],
        },
      ],
      at: 1,
    };
    const before = client.plans.getState();

    latest().receive(JSON.stringify({ type: "plans_updated", plans: [grok] }));
    const pushed = client.plans.getState();
    latest().receive(JSON.stringify({ type: "plans_updated", plans: [{ ...grok, provider: "github-copilot" }] }));
    const afterMalformed = client.plans.getState();
    latest().receive(JSON.stringify({ type: "plans_updated", plans: [] }));

    expect([before, pushed, afterMalformed, client.plans.getState()]).toStrictEqual([[], [grok], [grok], []]);
    // The host pushes them; the client asks for nothing but its heartbeat.
    expect(
      latest()
        .commands()
        .filter((sent) => sent["type"] !== "ping"),
    ).toStrictEqual([]);
  });
});

describe("createAtriumClient: images", () => {
  it("uploads an image, and sends a message with it, shown pending with its count", async () => {
    const { client, latest } = await watchingWithModel(null);

    const uploading = client.uploadAttachment("image/webp", "UklGRg==");
    latest().answer("upload_attachment", { attachmentId: "a1" });
    expect(await uploading).toStrictEqual({ attachmentId: "a1" });
    const sending = client.prompt("s1", "看图", ["a1"]);
    expect(client.session("s1")?.getState().pending).toStrictEqual([
      { clientMessageId: expect.any(String), text: "看图", images: 1 },
    ]);
    latest().answer("prompt", { disposition: "started" });
    await sending;
    const steering = client.steer("s1", "", ["a2"]);
    latest().answer("steer", { disposition: "queued" });
    await steering;
    // Not answered: only what it sends matters.
    void client.prompt("s1", "只有字").catch(() => undefined);

    expect(
      latest()
        .commands()
        .filter((command) => ["upload_attachment", "prompt", "steer"].includes(String(command["type"])))
        .map(({ requestId: _id, ...command }) => command),
    ).toStrictEqual([
      { type: "upload_attachment", mimeType: "image/webp", data: "UklGRg==" },
      { type: "prompt", sessionId: "s1", text: "看图", attachmentIds: ["a1"] },
      { type: "steer", sessionId: "s1", text: "", attachmentIds: ["a2"] },
      { type: "prompt", sessionId: "s1", text: "只有字" },
    ]);
  });

  it("keeps the previews of the latest 50 messages sent with images, by message, but not of one that did not go", async () => {
    const { client, latest } = await watchingWithModel(null);
    const sentIds: string[] = [];
    for (let n = 0; n < 51; n += 1) {
      const sending = client.prompt("s1", `图${n}`, [`a${n}`], [`data:image/webp;base64,${n}`]);
      sentIds.push(present(client.session("s1")?.getState().pending.at(-1), "the pending message").clientMessageId);
      latest().answer("prompt", { disposition: "started" });
      await sending;
    }
    const steering = client.steer("s1", "", ["b"], ["data:image/png;base64,s", "data:image/png;base64,t"]);
    const steerId = present(client.session("s1")?.getState().pending.at(-1), "the steer").clientMessageId;
    latest().answer("steer", { disposition: "queued" });
    await steering;
    const failing = client.prompt("s1", "没发出", ["c"], ["data:image/png;base64,f"]);
    const failedId = present(client.session("s1")?.getState().pending.at(-1), "the failing message").clientMessageId;
    latest().fail("prompt", "attachment_missing");
    await failing.catch(() => undefined);
    const plain = client.prompt("s1", "只有字");
    const plainId = present(client.session("s1")?.getState().pending.at(-1), "the plain message").clientMessageId;
    latest().answer("prompt", { disposition: "started" });
    await plain;
    const plainSteer = client.steer("s1", "也只有字");
    const plainSteerId = present(client.session("s1")?.getState().pending.at(-1), "the plain steer").clientMessageId;
    latest().answer("steer", { disposition: "queued" });
    await plainSteer;

    expect([
      client.sentPreviews(present(sentIds[0], "the first")),
      // The steer and the failed message came after: 53 in all, so the first three went.
      client.sentPreviews(present(sentIds[2], "the third")),
      client.sentPreviews(present(sentIds[3], "the fourth")),
      client.sentPreviews(present(sentIds[50], "the last")),
      client.sentPreviews(steerId),
      client.sentPreviews(failedId),
      client.sentPreviews(plainId),
      client.sentPreviews(plainSteerId),
    ]).toStrictEqual([
      null,
      null,
      ["data:image/webp;base64,3"],
      ["data:image/webp;base64,50"],
      ["data:image/png;base64,s", "data:image/png;base64,t"],
      null,
      null,
      null,
    ]);
  });
});

/** The watch commands a socket carried, without their request ids. */
function watches(socket: ScriptedSocket): Record<string, unknown>[] {
  return socket
    .commands()
    .filter((command) => String(command["type"]).startsWith("watch_"))
    .map(({ requestId: _id, ...command }) => command);
}

describe("createAtriumClient: workspace changes", () => {
  const W1 = "wks_0000000000000001";
  const W2 = "wks_0000000000000002";
  const known = { stat: { added: 3, removed: 1 }, dirty: true, ahead: 0, branch: "main", base: "origin/main" };
  const file = {
    path: "a.ts",
    oldPath: null,
    status: "modified",
    added: 1,
    removed: 0,
    content: "binary",
    hunks: [],
  };

  it("asks for the changes of the workspaces shown, keeping what the host sends in each one's store", async () => {
    const { client, latest } = await connected();

    expect(client.changes(W1).getState()).toBeNull();
    const watching = client.watchChanges([W1]);
    latest().answer("watch_changes");
    await watching;
    latest().receive(JSON.stringify({ type: "changes_updated", workspaceId: W1, ...known }));

    expect(client.changes(W1).getState()).toStrictEqual(known);
    expect(client.changes(W2).getState()).toBeNull();
    expect(watches(latest())).toStrictEqual([{ type: "watch_changes", workspaceIds: [W1] }]);
  });

  it("shows the panel's files for the target asked, not another's, and empties it once closed", async () => {
    const { client, latest } = await connected();
    const target = { workspaceId: W1, mode: "uncommitted" } as const;

    const opening = client.watchDiff(target);
    expect(client.diff.getState()).toStrictEqual({
      target,
      status: "loading",
      files: [],
      tooLarge: false,
      error: null,
    });
    latest().answer("watch_diff");
    await opening;
    latest().receive(
      JSON.stringify({
        type: "diff_updated",
        workspaceId: W1,
        mode: "base",
        files: [file],
        tooLarge: false,
        error: null,
      }),
    );
    expect(client.diff.getState().status).toBe("loading");
    latest().receive(
      JSON.stringify({
        type: "diff_updated",
        workspaceId: W1,
        mode: "uncommitted",
        files: [file],
        tooLarge: false,
        error: null,
      }),
    );
    expect(client.diff.getState()).toStrictEqual({
      target,
      status: "ready",
      files: [file],
      tooLarge: false,
      error: null,
    });
    const closing = client.watchDiff(null);
    latest().answer("watch_diff");
    await closing;

    expect(client.diff.getState()).toStrictEqual({
      target: null,
      status: "idle",
      files: [],
      tooLarge: false,
      error: null,
    });
    expect(watches(latest())).toStrictEqual([
      { type: "watch_diff", target },
      { type: "watch_diff", target: null },
    ]);
  });

  it("keeps the files shown while the same target is asked for again, as the refresh button does", async () => {
    const { client, latest } = await connected();
    const target = { workspaceId: W1, mode: "base" } as const;
    void client.watchDiff(target);
    latest().receive(
      JSON.stringify({
        type: "diff_updated",
        workspaceId: W1,
        mode: "base",
        files: [file],
        tooLarge: false,
        error: null,
      }),
    );

    void client.watchDiff({ ...target });

    expect(client.diff.getState()).toStrictEqual({
      target,
      status: "ready",
      files: [file],
      tooLarge: false,
      error: null,
    });
    expect(watches(latest())).toStrictEqual([
      { type: "watch_diff", target },
      { type: "watch_diff", target },
    ]);
  });

  it("ignores another workspace's diff for the same mode, and any diff while the panel is closed", async () => {
    const { client, latest } = await connected();
    void client.watchDiff({ workspaceId: W1, mode: "base" });

    latest().receive(
      JSON.stringify({
        type: "diff_updated",
        workspaceId: W2,
        mode: "base",
        files: [file],
        tooLarge: false,
        error: null,
      }),
    );
    expect(client.diff.getState().status).toBe("loading");
    void client.watchDiff(null);
    latest().receive(
      JSON.stringify({
        type: "diff_updated",
        workspaceId: W1,
        mode: "base",
        files: [file],
        tooLarge: false,
        error: null,
      }),
    );

    expect(client.diff.getState()).toStrictEqual({
      target: null,
      status: "idle",
      files: [],
      tooLarge: false,
      error: null,
    });
  });

  it("shows nothing of one workspace's files once the panel moves to another in the same mode", async () => {
    const { client, latest } = await connected();
    void client.watchDiff({ workspaceId: W1, mode: "base" });
    latest().receive(
      JSON.stringify({
        type: "diff_updated",
        workspaceId: W1,
        mode: "base",
        files: [file],
        tooLarge: false,
        error: null,
      }),
    );

    void client.watchDiff({ workspaceId: W2, mode: "base" });

    expect(client.diff.getState()).toStrictEqual({
      target: { workspaceId: W2, mode: "base" },
      status: "loading",
      files: [],
      tooLarge: false,
      error: null,
    });
  });

  it("shows nothing of one mode's files once the panel switches to the other", async () => {
    const { client, latest } = await connected();
    void client.watchDiff({ workspaceId: W1, mode: "base" });
    latest().receive(
      JSON.stringify({
        type: "diff_updated",
        workspaceId: W1,
        mode: "base",
        files: [file],
        tooLarge: false,
        error: null,
      }),
    );

    void client.watchDiff({ workspaceId: W1, mode: "uncommitted" });

    expect(client.diff.getState()).toStrictEqual({
      target: { workspaceId: W1, mode: "uncommitted" },
      status: "loading",
      files: [],
      tooLarge: false,
      error: null,
    });
  });

  it("asks again on every connection for what it shows, and asks nothing before one", async () => {
    const { client, clock, latest, sockets } = clientWith({ reconnectDelaysMs: [100] });
    const target = { workspaceId: W2, mode: "base" } as const;
    await client.watchChanges([W1]);
    await client.watchDiff(target);
    expect(sockets).toStrictEqual([]);

    const connecting = client.connect();
    latest().open();
    latest().receive(welcome());
    await connecting;
    latest().closeWith(1006);
    clock.advance(100);
    latest().open();
    latest().receive(welcome());

    for (const socket of sockets) {
      expect(watches(socket)).toStrictEqual([
        { type: "watch_changes", workspaceIds: [W1] },
        { type: "watch_diff", target },
      ]);
    }
  });
});
