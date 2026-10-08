import { CloseCode, CommandError, PROTOCOL_VERSION } from "@atrium/protocol";
import { FakeClock, present } from "@atrium/testkit";
import { describe, expect, it, vi } from "vitest";
import { type AtriumClient, ConnectionLostError, createAtriumClient } from "./atrium-client";

const trace = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/** A welcome with a 15 s heartbeat. */
function welcome(hostVersion = "0.1.0", hostInstanceId = "h1"): string {
  return JSON.stringify({
    type: "welcome",
    protocolVersion: PROTOCOL_VERSION,
    hostVersion,
    hostInstanceId,
    heartbeatMs: 15_000,
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
    /** Answers the last command of `type` with the error `code`. */
    fail: (type: string, code: string) => {
      const command = present(
        socket.sent.findLast((sent) => sent["type"] === type),
        `a ${type} command`,
      );
      socket.receive(JSON.stringify({ type: "response", requestId: command["requestId"], ok: false, error: { code } }));
    },
    /** The commands sent after the hello, without their trace. */
    commands: () =>
      socket.sent
        .slice(1)
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
  return event(seq, { type: "session_snapshot", items, hasOlder, run: null, exited: false });
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
    user: { text: "hi", images: 0, clientMessageId, timestamp: 0 },
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
      { type: "ping", requestId: "client-1-2" },
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
    expect(latest().sent.at(-1)).toStrictEqual({ type: "create_chat", requestId: "client-1-2", traceparent });
  });

  it("rejects with the host's error code, and with the schema's error for a malformed result", async () => {
    const { client, latest } = await connected();

    const failed = client.createChat();
    latest().receive(
      JSON.stringify({
        type: "response",
        requestId: "client-1-2",
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
        requestId: "client-1-2",
        kind: "error",
        message: "m".repeat(4096),
        details: "d".repeat(4096),
      },
      { type: "report_client_issue", requestId: "client-1-3", kind: "long_task", message: "took 80 ms" },
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
      { type: "subscribe_sessions", requestId: "client-1-2", sessionIds: ["s1", "s2"] },
      { type: "subscribe_sessions", requestId: "client-1-3", sessionIds: ["s1"] },
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
      { type: "subscribe_sessions", requestId: "client-1-2", sessionIds: ["s1"] },
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
      { type: "subscribe_sessions", requestId: "client-1-3", sessionIds: ["s2"] },
      { type: "subscribe_sessions", requestId: "client-1-4", sessionIds: ["s1", "s2"] },
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
      { type: "ping", requestId: "client-1-3" },
      { type: "subscribe_sessions", requestId: "client-1-4", sessionIds: ["s1"] },
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
    latest().receive(event(1, { type: "turn_started", turn: turn("t1", "client-1-3") }));

    expect(pendingNow).toStrictEqual([{ clientMessageId: "client-1-3", text: "hello" }]);
    expect(pendingAfterAnswer).toStrictEqual(pendingNow);
    expect(latest().sent.at(-1)).toStrictEqual({
      type: "prompt",
      requestId: "client-1-3",
      traceparent,
      sessionId: "s1",
      text: "hello",
    });
    expect(client.session("s1")?.getState()).toMatchObject({ pending: [], items: [turn("t1", "client-1-3")] });
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
      JSON.stringify({ type: "response", requestId: "client-1-5", ok: false, error: { code: "session_not_found" } }),
    );
    await expect(failed).rejects.toBeInstanceOf(CommandError);

    expect(client.session("s1")?.getState().pending).toStrictEqual([{ clientMessageId: "client-1-4", text: "kept" }]);
    latest().receive(
      JSON.stringify({ type: "response", requestId: "client-1-4", ok: true, result: { disposition: "started" } }),
    );
    await kept;
  });

  it("sends a prompt for a session it does not watch, without a pending copy", async () => {
    const { client, latest } = await connected();

    const sent = client.prompt("s9", "hi");
    latest().answer("prompt", { disposition: "started" });

    expect(await sent).toStrictEqual({ disposition: "started" });
    const failed = client.prompt("s9", "again");
    latest().receive(
      JSON.stringify({ type: "response", requestId: "client-1-3", ok: false, error: { code: "session_not_found" } }),
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
      }),
    );
    const shown = client.session("s1")?.getState().items;

    latest().closeWith(1006);
    clock.advance(250);
    latest().open();
    latest().receive(welcome("0.1.0", "h2"));

    expect(client.session("s1")?.getState()).toMatchObject({ status: "lost", run: null, pending: [] });
    expect(client.session("s1")?.getState().items).toBe(shown);
    // The new host does not know the session, so it is not subscribed again.
    expect(latest().commands()).toStrictEqual([{ type: "ping", requestId: "client-1-3" }]);
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
      { type: "fetch_transcript", requestId: "client-1-3", sessionId: "s1", epoch: 1, before: "t5", limit: 50 },
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
