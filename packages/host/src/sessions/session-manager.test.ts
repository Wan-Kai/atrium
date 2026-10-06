import { CommandError, type SessionEvent } from "@atrium/protocol";
import { type ScriptedPiBehavior, createTempDir, writeScriptedPi } from "@atrium/testkit";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { SubscriptionRegistry } from "../sync/subscriptions";
import { type SessionManager, type SessionTools, createSessionManager } from "./session-manager";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/** What pi prints for one prompt that it answers with "pong". */
const turn = [
  { type: "agent_start" },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "ping" }], timestamp: 1 } },
  { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 2 } },
  { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "pong" } },
  {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "pong" }], stopReason: "stop", timestamp: 2 },
  },
  { type: "agent_settled" },
];

/** A manager whose tools are `tools`, or a scripted pi with `behavior`, with one registered connection. */
async function manage(tools: ScriptedPiBehavior | SessionTools | null) {
  const home = await createTempDir("sessions-home");
  const recording = recordingTracing();
  cleanups.push(home.cleanup, recording.shutdown);
  let found: SessionTools | null;
  if (tools === null || "pi" in tools) {
    found = tools;
  } else {
    const scripted = await writeScriptedPi(home.path, tools);
    found = {
      env: { PATH: process.env["PATH"] ?? "", ...scripted.env },
      pi: { status: "ready", piPath: scripted.piPath, version: [1, 0, 2] },
    };
  }
  const subscriptions = new SubscriptionRegistry(recording.resources);
  const received: SessionEvent[] = [];
  subscriptions.connect("c1", (event) => received.push(event));
  let next = 0;
  const manager: SessionManager = createSessionManager({
    home: home.path,
    tools: Promise.resolve(found),
    subscriptions,
    clock: systemClock,
    resources: recording.resources,
    tracer: recording.tracer,
    logger: recording.logger,
    newId: () => `id${++next}`,
  });
  cleanups.push(() => manager.close());
  return { manager, received, home: home.path, records: recording.records };
}

describe("createSessionManager", () => {
  it("creates a chat in its own directory under chats/, named by the session id pi reports", async () => {
    const { manager, home, records } = await manage({
      argvToStderr: true,
      rules: { get_state: { data: { sessionId: "pi-session-1" } } },
    });

    expect(await manager.createChat("c1")).toStrictEqual({ sessionId: "pi-session-1" });

    expect(await readdir(join(home, "chats"))).toStrictEqual(["id1"]);
    // pi reports its directory with symlinks resolved, as in /private/var on macOS.
    const cwd = await realpath(join(home, "chats", "id1"));
    await vi.waitFor(() =>
      expect(records).toContainEqual(
        expect.objectContaining({
          msg: "pi stderr",
          line: JSON.stringify({ argv: ["--mode", "rpc"], cwd }),
        }),
      ),
    );
  });

  it("sends a subscriber the snapshot, then the session's events as pi works", async () => {
    const { manager, received } = await manage({
      rules: {
        get_state: { data: { sessionId: "pi-session-1" } },
        prompt: { data: { disposition: "started" }, events: turn },
      },
    });
    const { sessionId } = await manager.createChat("c1");

    await manager.subscribe("c1", [sessionId]);
    const answer = await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" });
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe("run_settled"));

    expect(answer).toStrictEqual({ disposition: "started" });
    expect(received.map((event) => [event.type, event.seq])).toStrictEqual([
      ["session_snapshot", 0],
      ["run_started", 1],
      ["message_finished", 2],
      ["message_started", 3],
      ["text_delta", 4],
      ["message_finished", 5],
      ["run_settled", 6],
    ]);
    expect(received[2]).toMatchObject({ message: { role: "user", text: "ping", clientMessageId: "q1" } });
  });

  it("sends a snapshot only for sessions a connection did not already watch", async () => {
    const { manager, received } = await manage({ rules: { get_state: { data: { sessionId: "pi-session-1" } } } });
    const { sessionId } = await manager.createChat("c1");

    await manager.subscribe("c1", [sessionId]);
    await manager.subscribe("c1", [sessionId]);

    expect(received.map((event) => event.type)).toStrictEqual(["session_snapshot"]);
  });

  it.each([
    ["detection did not finish", null, "unknown"],
    ["pi is missing", { env: {}, pi: { status: "missing" } } satisfies SessionTools, "missing"],
  ])("refuses to create a chat when %s", async (_case, tools, status) => {
    const { manager, home } = await manage(tools);

    await expect(manager.createChat("c1")).rejects.toStrictEqual(new CommandError("pi_unavailable", { status }));
    await expect(readdir(home)).resolves.toStrictEqual([]);
  });

  it("refuses to create a chat when pi exits before reporting its session", async () => {
    const { manager } = await manage({ exitCode: 1 });

    await expect(manager.createChat("c1")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
  });

  it("answers commands on sessions it does not know with session_not_found", async () => {
    const { manager } = await manage(null);

    await expect(manager.subscribe("c1", ["nope"])).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "nope" }),
    );
    await expect(
      manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "nope", text: "x" }),
    ).rejects.toStrictEqual(new CommandError("session_not_found", { sessionId: "nope" }));
  });

  it("stops every pi when it closes, which subscribers see as a requested exit", async () => {
    const { manager, received } = await manage({ rules: { get_state: { data: { sessionId: "pi-session-1" } } } });
    const { sessionId } = await manager.createChat("c1");
    await manager.subscribe("c1", [sessionId]);

    await manager.close();
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe("session_exited"));

    expect(received.at(-1)).toMatchObject({ reason: "requested", code: 0 });
  });
});
