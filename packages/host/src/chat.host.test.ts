import { createAtriumClient } from "@atrium/client";
import { type HostMessage, PROTOCOL_VERSION } from "@atrium/protocol";
import { createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { type TestHost, startTestHost } from "../test/harness";
import { PONG_ENTRIES, PONG_TURN } from "../test/scripted-chat";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const traceparent = `00-${traceId}-00f067aa0ba902b7-01`;
let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
});

/** Starts a host whose tool environment finds a scripted pi as `pi`, and opens an authenticated socket. */
async function chatHost() {
  const bin = await createTempDir("chat-bin");
  onTestFinished(bin.cleanup);
  const scripted = await writeScriptedPi(
    bin.path,
    {
      rules: {
        get_state: { data: { sessionId: "pi-session-1" } },
        get_entries: PONG_ENTRIES,
        prompt: { data: { disposition: "started" }, events: PONG_TURN },
      },
    },
    "pi",
  );
  testHost = await startTestHost({ toolEnv: { PATH: `${bin.path}:/usr/bin:/bin`, ...scripted.env } });
  await testHost.host.tools;
  return { ...(await openClient(testHost, "client-1")), host: testHost };
}

/** Opens a socket to the host and completes the handshake. */
async function openClient(host: TestHost, clientId: string) {
  const socket = new WebSocket(host.url);
  const received: HostMessage[] = [];
  socket.on("message", (data: Buffer) => received.push(JSON.parse(data.toString("utf8")) as HostMessage));
  await new Promise((done) => socket.once("open", done));
  socket.send(
    JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, clientId, token: host.token, traceparent }),
  );
  await vi.waitFor(() => expect(received).toHaveLength(1));
  return { socket, received };
}

/** Sends a command and waits for its response. */
async function command(
  chat: Awaited<ReturnType<typeof openClient>>,
  fields: Record<string, unknown>,
): Promise<HostMessage> {
  const requestId = String(fields["requestId"]);
  chat.socket.send(JSON.stringify({ traceparent, ...fields }));
  return vi.waitFor(
    () =>
      present(
        chat.received.find((message) => message.type === "response" && message.requestId === requestId),
        `response to ${requestId}`,
      ),
    { timeout: 15_000 },
  );
}

/** The session events among what the host sent. */
function sessionEvents(received: readonly HostMessage[]): HostMessage[] {
  return received.filter((message) => message.type !== "response" && message.type !== "welcome");
}

/** Where the response to `requestId` is among what the host sent. */
function responseIndex(received: readonly HostMessage[], requestId: string): number {
  return received.findIndex((message) => message.type === "response" && message.requestId === requestId);
}

/** The span record with this name in the log. */
function spanNamed(log: readonly Record<string, unknown>[], name: string): Record<string, unknown> {
  return present(
    log.find((record) => record["kind"] === "span" && record["name"] === name),
    `${name} span`,
  );
}

describe("one chat over the WebSocket", () => {
  it("creates a chat, sends its snapshot to the subscriber, and streams a reply", async () => {
    const chat = await chatHost();

    const created = await command(chat, { type: "create_chat", requestId: "r1" });
    expect(created).toMatchObject({ type: "response", requestId: "r1", ok: true });
    const { sessionId } = (created as { result: { sessionId: string } }).result;
    // As the UI does with the tab it shows: the open waits for the chat's pi to start.
    expect(await command(chat, { type: "open_session", requestId: "r1b", sessionId })).toMatchObject({ ok: true });
    expect(await command(chat, { type: "subscribe_sessions", requestId: "r2", sessionIds: [sessionId] })).toMatchObject(
      {
        ok: true,
      },
    );
    expect(await command(chat, { type: "prompt", requestId: "r3", sessionId, text: "ping" })).toStrictEqual({
      type: "response",
      requestId: "r3",
      ok: true,
      result: { disposition: "started" },
    });
    // The entries read after the run bring the reply's tokens to the status bar (SPEC-0001, "状态栏（M1.8）").
    await vi.waitFor(() => expect(chat.received.map((message) => message.type)).toContain("metrics_updated"), {
      timeout: 15_000,
    });

    const events = sessionEvents(chat.received);
    expect(events.map((event) => event.type)).toStrictEqual([
      "session_snapshot",
      "run_started",
      "turn_started",
      "step_added",
      "step_delta",
      "turn_finished",
      "run_settled",
      "metrics_updated",
    ]);
    expect(events.slice(1, 7)).toMatchObject(
      Array.from({ length: 6 }, (_, index) => ({ sessionId, epoch: 1, seq: index + 1, traceId })),
    );
    expect(events[7]).toMatchObject({ seq: 7, traceId: null });
    // The snapshot comes before the response to `subscribe_sessions`.
    expect(chat.received.findIndex((message) => message.type === "session_snapshot")).toBeLessThan(
      responseIndex(chat.received, "r2"),
    );
    const log = await chat.host.readLog();
    const connect = spanNamed(log, "ws.connect");
    expect(log).toContainEqual(
      expect.objectContaining({
        kind: "span",
        name: "command prompt",
        trace_id: traceId,
        links: [{ trace_id: connect["trace_id"], span_id: connect["span_id"] }],
      }),
    );
  });

  it("delivers a session's events to every client that subscribed to it", async () => {
    const first = await chatHost();
    const second = await openClient(first.host, "client-2");
    const created = await command(first, { type: "create_chat", requestId: "r1" });
    const { sessionId } = (created as { result: { sessionId: string } }).result;
    await command(first, { type: "open_session", requestId: "r1b", sessionId });
    await command(first, { type: "subscribe_sessions", requestId: "r2", sessionIds: [sessionId] });
    await command(second, { type: "subscribe_sessions", requestId: "r2", sessionIds: [sessionId] });

    await command(first, { type: "prompt", requestId: "r3", sessionId, text: "ping" });

    for (const client of [first, second]) {
      await vi.waitFor(
        () => expect(sessionEvents(client.received).map((event) => event.type)).toContain("run_settled"),
        {
          timeout: 15_000,
        },
      );
    }
    expect(sessionEvents(second.received)).toStrictEqual(sessionEvents(first.received));
  });

  it("lets the client create a chat, watch it and see the turn replace its pending message", async () => {
    const chat = await chatHost();
    const client = createAtriumClient({
      url: chat.host.url,
      token: chat.host.token,
      clientId: "real-client",
      reconnectDelaysMs: [],
    });
    onTestFinished(() => client.disconnect());
    await client.connect();

    const { sessionId } = await client.createChat();
    await client.watch([sessionId]);
    const view = present(client.session(sessionId), "the session's view");
    await vi.waitFor(() => expect(view.getState().status).toBe("ready"));
    await client.prompt(sessionId, "ping");
    await vi.waitFor(() => expect(view.getState().run).toBeNull());
    // Request ids count every command: the first heartbeat ping, subscribe_index, create_chat,
    // subscribe_sessions, prompt.

    expect(view.getState()).toMatchObject({
      status: "ready",
      epoch: 1,
      seq: 6,
      pending: [],
      items: [
        {
          kind: "turn",
          user: { text: "ping", clientMessageId: "real-client-5" },
          steps: [{ kind: "text", id: "0", text: "pong" }],
          outcome: "done",
          usage: { input: 3, output: 1 },
        },
      ],
    });
  });
});

describe("uploading images", () => {
  it("takes a connection's whole allowance of images sent at once, without closing it", async () => {
    testHost = await startTestHost();
    const chat = await openClient(testHost, "client-1");
    const data = Buffer.alloc(750_000, 7).toString("base64");

    for (let index = 0; index < 20; index++) {
      chat.socket.send(
        JSON.stringify({
          traceparent,
          type: "upload_attachment",
          requestId: `u${index}`,
          mimeType: "image/webp",
          data,
        }),
      );
    }

    await vi.waitFor(
      () =>
        expect(
          chat.received.filter((message) => message.type === "response").map((message) => message.ok),
        ).toStrictEqual(Array.from({ length: 20 }, () => true)),
      { timeout: 10_000 },
    );
    expect(chat.socket.readyState).toBe(WebSocket.OPEN);
  });
});
