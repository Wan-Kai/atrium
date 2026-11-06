import { type HostMessage, PROTOCOL_VERSION } from "@atrium/protocol";
import { createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { type TestHost, startTestHost } from "../test/harness";
import { PONG_ENTRIES, PONG_TURN, UNANSWERED_STATS } from "../test/scripted-chat";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
});

/**
 * A host in a home of the test's own, whose scripted pi answers "ping" with "pong", and a client.
 *
 * @remarks
 * The visual's message is "ping", so the scripted pi echoes it as the user message of a turn.
 *
 * @sideEffects Creates temporary directories; starts a host; opens a socket.
 * @returns The host, its home, the socket and what it received, and a chat's session.
 */
async function visualHost() {
  const bin = await createTempDir("visual-bin");
  onTestFinished(bin.cleanup);
  const homeDir = await createTempDir("visual-home");
  onTestFinished(homeDir.cleanup);
  const home = await realpath(homeDir.path);
  const scripted = await writeScriptedPi(
    bin.path,
    {
      rules: {
        get_state: { data: { sessionId: "pi-session-1" } },
        get_entries: PONG_ENTRIES,
        get_session_stats: UNANSWERED_STATS,
        prompt: { data: { disposition: "started" }, events: PONG_TURN },
      },
    },
    "pi",
  );
  testHost = await startTestHost({ home, toolEnv: { PATH: `${bin.path}:/usr/bin:/bin`, ...scripted.env } });
  await testHost.host.tools;
  const socket = new WebSocket(testHost.url);
  const received: HostMessage[] = [];
  socket.on("message", (data: Buffer) => received.push(JSON.parse(data.toString("utf8")) as HostMessage));
  await new Promise((done) => socket.once("open", done));
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      clientId: "c1",
      token: testHost.token,
      traceparent,
    }),
  );
  await vi.waitFor(() => expect(received.map(({ type }) => type)).toContain("plans_updated"));
  const client = { socket, received };
  const created = await command(client, { type: "create_chat", requestId: "r1" });
  const { sessionId } = (created as { result: { sessionId: string } }).result;
  await command(client, { type: "open_session", requestId: "r2", sessionId });
  await command(client, { type: "subscribe_sessions", requestId: "r3", sessionIds: [sessionId] });
  return { ...client, home, sessionId, port: testHost.host.port };
}

/**
 * Sends a command and waits for its response.
 *
 * @remarks
 * As the chat host test does.
 *
 * @sideEffects Sends on the socket.
 * @param client - The socket and what it received.
 * @param fields - The command, without its trace.
 * @returns The response.
 */
async function command(
  client: { readonly socket: WebSocket; readonly received: HostMessage[] },
  fields: Record<string, unknown>,
): Promise<HostMessage> {
  const requestId = String(fields["requestId"]);
  client.socket.send(JSON.stringify({ traceparent, ...fields }));
  return vi.waitFor(
    () =>
      present(
        client.received.find((message) => message.type === "response" && message.requestId === requestId),
        `response to ${requestId}`,
      ),
    { timeout: 15_000 },
  );
}

describe("inline visuals through a real host", () => {
  it("resolves a visual in the session's folder, serves it framed and sandboxed, and tells of a change", async () => {
    const host = await visualHost();
    const dir = join(host.home, "visuals", host.sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.html"), '<div id="lesson">一</div>');

    const resolved = await command(host, {
      type: "resolve_visual",
      requestId: "v1",
      sessionId: host.sessionId,
      path: join(dir, "a.html"),
    });
    const outside = await command(host, {
      type: "resolve_visual",
      requestId: "v2",
      sessionId: host.sessionId,
      path: "a.html",
    });
    const { url } = (resolved as { result: { url: string } }).result;
    const page = await fetch(`http://127.0.0.1:${host.port}/visual/${new URL(url).host}/a.html`);

    expect(resolved).toMatchObject({
      ok: true,
      result: { url: expect.stringMatching(/^atrium-visual:\/\/[0-9a-f]{32}\/a\.html$/u), size: 26 },
    });
    expect(outside).toMatchObject({ ok: false, error: { code: "visual_outside" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(await page.text()).toContain('<body><div id="lesson">一</div></body>');

    await writeFile(join(dir, "a.html"), '<div id="lesson">二</div>');
    await vi.waitFor(
      () =>
        expect(host.received).toContainEqual({
          type: "visual_changed",
          sessionId: host.sessionId,
          path: join(dir, "a.html"),
          mtime: expect.any(Number),
        }),
      { timeout: 10_000 },
    );
  });

  it("sends a visual's message as the session's, marked and remembered, and drops one too soon after", async () => {
    const host = await visualHost();
    const dir = join(host.home, "visuals", host.sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.html"), "<p>x</p>");
    const path = join(dir, "a.html");

    const sent = await command(host, {
      type: "send_visual_message",
      requestId: "m1",
      sessionId: host.sessionId,
      path,
      text: "ping",
    });
    const again = await command(host, {
      type: "send_visual_message",
      requestId: "m2",
      sessionId: host.sessionId,
      path,
      text: "ping",
    });

    expect(sent).toMatchObject({ ok: true, result: { disposition: "started" } });
    expect(again).toMatchObject({ ok: true, result: { disposition: "dropped" } });
    await vi.waitFor(() => expect(host.received.map((message) => message.type)).toContain("run_settled"), {
      timeout: 15_000,
    });
    const started = host.received.find((message) => message.type === "turn_started");
    expect(started).toMatchObject({
      turn: { user: { text: "ping", clientMessageId: "m1", source: { kind: "visual", path } } },
    });
    await vi.waitFor(
      async () =>
        expect(JSON.parse(await readFile(join(host.home, "turns", `${host.sessionId}.json`), "utf8"))).toMatchObject({
          sources: { u1: { kind: "visual", path } },
        }),
      { timeout: 10_000 },
    );
  });
});
