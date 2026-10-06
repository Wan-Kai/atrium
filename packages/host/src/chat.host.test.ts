import type { HostMessage } from "@atrium/protocol";
import { createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { type TestHost, startTestHost } from "../test/harness";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const traceparent = `00-${traceId}-00f067aa0ba902b7-01`;
let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
});

/** What a scripted pi prints for one prompt, answered with "pong". */
const turn = [
  { type: "agent_start" },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "ping" }], timestamp: 1 } },
  { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 2 } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "pong" } },
  {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "pong" }], stopReason: "stop", timestamp: 2 },
  },
  { type: "agent_settled" },
];

/** Starts a host whose tool environment finds a scripted pi as `pi`, and opens an authenticated socket. */
async function chatHost() {
  const bin = await createTempDir("chat-bin");
  onTestFinished(bin.cleanup);
  const scripted = await writeScriptedPi(
    bin.path,
    {
      rules: {
        get_state: { data: { sessionId: "pi-session-1" } },
        prompt: { data: { disposition: "started" }, events: turn },
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
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, clientId, token: host.token, traceparent }));
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

    expect(await command(chat, { type: "create_chat", requestId: "r1" })).toStrictEqual({
      type: "response",
      requestId: "r1",
      ok: true,
      result: { sessionId: "pi-session-1" },
    });
    expect(
      await command(chat, { type: "subscribe_sessions", requestId: "r2", sessionIds: ["pi-session-1"] }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await command(chat, { type: "prompt", requestId: "r3", sessionId: "pi-session-1", text: "ping" }),
    ).toStrictEqual({
      type: "response",
      requestId: "r3",
      ok: true,
      result: { disposition: "started" },
    });
    await vi.waitFor(() => expect(chat.received.map((message) => message.type)).toContain("run_settled"), {
      timeout: 15_000,
    });

    const events = sessionEvents(chat.received);
    expect(events.map((event) => event.type)).toStrictEqual([
      "session_snapshot",
      "run_started",
      "message_finished",
      "message_started",
      "text_delta",
      "message_finished",
      "run_settled",
    ]);
    expect(events.slice(1)).toMatchObject(
      Array.from({ length: 6 }, (_, index) => ({ sessionId: "pi-session-1", epoch: 1, seq: index + 1, traceId })),
    );
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
    await command(first, { type: "create_chat", requestId: "r1" });
    await command(first, { type: "subscribe_sessions", requestId: "r2", sessionIds: ["pi-session-1"] });
    await command(second, { type: "subscribe_sessions", requestId: "r2", sessionIds: ["pi-session-1"] });

    await command(first, { type: "prompt", requestId: "r3", sessionId: "pi-session-1", text: "ping" });

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
});
