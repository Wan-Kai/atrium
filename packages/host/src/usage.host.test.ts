import { type HostMessage, PROTOCOL_VERSION } from "@atrium/protocol";
import { FakeClock, createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { type TestHost, startTestHost } from "../test/harness";
import { PONG_ENTRIES, PONG_STATS, PONG_TURN } from "../test/scripted-chat";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
});

/** The host's log records with the given message. */
async function recordsWith(host: TestHost, msg: string): Promise<Record<string, unknown>[]> {
  return (await host.readLog()).filter((record) => record["msg"] === msg);
}

/**
 * Sends a command over a socket and waits for its response.
 *
 * @remarks
 * Responses are told apart by their request id.
 *
 * @sideEffects Sends on the socket.
 * @param socket - The socket.
 * @param received - What the host sent on it.
 * @param fields - The command.
 * @returns The response.
 */
function commandOver(socket: WebSocket, received: readonly HostMessage[], fields: Record<string, unknown>) {
  socket.send(JSON.stringify({ traceparent, ...fields }));
  return vi.waitFor(
    () =>
      present(
        received.find((message) => message.type === "response" && message.requestId === fields["requestId"]),
        `response to ${String(fields["requestId"])}`,
      ),
    { timeout: 15_000 },
  );
}

describe("usage in the host's log", () => {
  it("logs resource counts and memory once a minute", async () => {
    const clock = new FakeClock(0);
    testHost = await startTestHost({ clock });
    await testHost.host.tools;

    clock.advance(59_999);
    expect(await recordsWith(testHost, "resource usage")).toStrictEqual([]);
    clock.advance(1);
    clock.advance(60_000);
    const reports = await recordsWith(testHost, "resource usage");

    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report).toMatchObject({
        level: "info",
        resources: expect.objectContaining({ "tools.detect": 0 }),
        memory: {
          rss: expect.any(Number),
          heapTotal: expect.any(Number),
          heapUsed: expect.any(Number),
          external: expect.any(Number),
          arrayBuffers: expect.any(Number),
        },
      });
    }
  });

  it("stops an idle session's pi with the first minute's report once it has been idle 30 minutes (SPEC-0001, \"空闲回收\")", async () => {
    const bin = await createTempDir("usage-bin");
    onTestFinished(bin.cleanup);
    const scripted = await writeScriptedPi(
      bin.path,
      {
        rules: {
          get_state: { data: { sessionId: "pi-session-1" } },
          get_entries: PONG_ENTRIES,
          get_session_stats: PONG_STATS,
          prompt: { data: { disposition: "started" }, events: PONG_TURN },
        },
      },
      "pi",
    );
    const clock = new FakeClock(0);
    testHost = await startTestHost({ clock, toolEnv: { PATH: `${bin.path}:/usr/bin:/bin`, ...scripted.env } });
    await testHost.host.tools;
    const socket = new WebSocket(testHost.url);
    const received: HostMessage[] = [];
    socket.on("message", (data: Buffer) => received.push(JSON.parse(data.toString("utf8")) as HostMessage));
    await new Promise((done) => socket.once("open", done));
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        clientId: "client-1",
        token: testHost.token,
        traceparent,
      }),
    );
    const command = (fields: Record<string, unknown>) => commandOver(socket, received, fields);
    // Time goes on as it would while pi starts and stops, for what waits on the clock meanwhile.
    let ticking = setInterval(() => clock.advance(20), 20);
    onTestFinished(() => clearInterval(ticking));
    const created = await command({ type: "create_chat", requestId: "r1" });
    const { sessionId } = (created as { result: { sessionId: string } }).result;
    await command({ type: "open_session", requestId: "r2", sessionId });
    await command({ type: "subscribe_sessions", requestId: "r3", sessionIds: [sessionId] });
    await command({ type: "prompt", requestId: "r4", sessionId, text: "ping" });
    await vi.waitFor(() => expect(received.map((message) => message.type)).toContain("run_settled"), {
      timeout: 15_000,
    });
    clearInterval(ticking);

    // The client answers no pings in fake time and is dropped meanwhile; the counts and the log tell.
    testHost.expectLog({ level: "warn", msg: "client dropped: no pong before the next ping", times: 1 });
    // The 30th minute's report comes a little under 30 minutes after the run: pi stays.
    for (let minute = 0; minute < 30; minute++) clock.advance(60_000);
    // A stop begun by then would have ended within this while, time going on meanwhile.
    ticking = setInterval(() => clock.advance(20), 20);
    await new Promise((done) => setTimeout(done, 300));
    clearInterval(ticking);
    expect(testHost.host.resources.snapshot()["pi-process"]).toBe(1);
    // The next one stops it.
    clock.advance(60_000);
    ticking = setInterval(() => clock.advance(20), 20);

    await vi.waitFor(() => expect(testHost?.host.resources.snapshot()["pi-process"]).toBe(0), { timeout: 10_000 });
    await vi.waitFor(async () =>
      expect(await recordsWith(present(testHost, "host"), "pi exited")).toMatchObject([{ requested: true }]),
    );
    socket.close();
  }, 30_000);

  it("logs the desktop app's processes it is handed", async () => {
    testHost = await startTestHost();

    testHost.host.recordAppMetrics([
      { type: "Browser", memoryKb: 120_000, cpuPercent: 1.5 },
      { type: "Utility", memoryKb: 80_000, cpuPercent: 0 },
    ]);

    expect(await recordsWith(testHost, "app metrics")).toStrictEqual([
      expect.objectContaining({
        level: "info",
        processes: [
          { type: "Browser", memoryKb: 120_000, cpuPercent: 1.5 },
          { type: "Utility", memoryKb: 80_000, cpuPercent: 0 },
        ],
      }),
    ]);
  });
});
