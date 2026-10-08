import { CommandError, type SessionEvent } from "@atrium/protocol";
import { type ScriptedPiBehavior, createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { mkdir, readdir, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { PONG_ENTRIES as getEntries, PONG_TURN as turn } from "../../test/scripted-chat";
import { systemClock } from "../platform/clock";
import { SubscriptionRegistry } from "../sync/subscriptions";
import { type SessionManager, type SessionTools, createSessionManager } from "./session-manager";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/**
 * A manager whose tools are `tools`, or a scripted pi with `behavior` and `env` added to its
 * environment, with one registered connection.
 */
async function manage(tools: ScriptedPiBehavior | SessionTools | null, env: Record<string, string> = {}) {
  const home = await createTempDir("sessions-home");
  const recording = recordingTracing();
  cleanups.push(home.cleanup, recording.shutdown);
  let found: SessionTools | null;
  if (tools === null || "pi" in tools) {
    found = tools;
  } else {
    const scripted = await writeScriptedPi(home.path, tools);
    found = {
      env: { PATH: process.env["PATH"] ?? "", ...scripted.env, ...env },
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
  return { manager, received, home: home.path, records: recording.records, resources: recording.resources };
}

describe("createSessionManager", () => {
  it("creates a chat in its own directory under chats/, named by the session id pi reports", async () => {
    const { manager, home, records } = await manage({
      argvToStderr: true,
      rules: { get_state: { data: { sessionId: "pi-session-1" } }, get_entries: getEntries },
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
    const { manager, received, records } = await manage({
      rules: {
        get_state: { data: { sessionId: "pi-session-1" } },
        get_entries: getEntries,
        prompt: { data: { disposition: "started" }, events: turn },
      },
    });
    const { sessionId } = await manager.createChat("c1");

    await manager.subscribe("c1", [sessionId]);
    const answer = await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" });
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe("run_settled"));
    // The read after the run finds what was sent, so nothing follows it.
    await vi.waitFor(() => expect(records.filter((record) => record["name"] === "pi.rpc get_entries")).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(answer).toStrictEqual({ disposition: "started" });
    expect(received.map((event) => [event.type, event.seq])).toStrictEqual([
      ["session_snapshot", 0],
      ["run_started", 1],
      ["turn_started", 2],
      ["step_added", 3],
      ["step_delta", 4],
      ["turn_finished", 5],
      ["run_settled", 6],
    ]);
    expect(received[2]).toMatchObject({ turn: { user: { text: "ping", clientMessageId: "q1" } } });
  });

  it("logs a failed read of pi's entries by its command and reason, never pi's own text", async () => {
    const { manager, records } = await manage({
      rules: {
        get_state: { data: { sessionId: "pi-session-1" } },
        get_entries: { sequence: [{ data: { entries: [], leafId: null } }, { fail: "secret-in-pi-text" }] },
        prompt: { data: { disposition: "started" }, events: turn },
      },
    });
    const { sessionId } = await manager.createChat("c1");

    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" });

    const failure = await vi.waitFor(() =>
      present(
        records.find((record) => record["msg"] === "transcript refresh failed"),
        "the refresh failure",
      ),
    );
    expect(failure).toMatchObject({ command: "get_entries", reason: "rejected", sessionId });
    expect(JSON.stringify(records)).not.toContain("secret-in-pi-text");
  });

  it("sends a snapshot only for sessions a connection did not already watch", async () => {
    const { manager, received } = await manage({
      rules: { get_state: { data: { sessionId: "pi-session-1" } }, get_entries: getEntries },
    });
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
    const { manager, received } = await manage({
      rules: { get_state: { data: { sessionId: "pi-session-1" } }, get_entries: getEntries },
    });
    const { sessionId } = await manager.createChat("c1");
    await manager.subscribe("c1", [sessionId]);

    await manager.close();
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe("session_exited"));

    expect(received.at(-1)).toMatchObject({ reason: "requested", code: 0 });
  });

  it("stops a pi that cannot report its session, instead of leaving it running", async () => {
    const { manager, resources } = await manage({ rules: { get_state: { fail: "not ready" } } });

    await expect(manager.createChat("c1")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "unresponsive" }),
    );
    expect(resources.snapshot()["pi-process"]).toBe(0);
  });

  it("stops the pi of a chat whose creation finishes after the manager closed", async () => {
    const { manager, resources } = await manage({
      rules: { get_state: { data: { sessionId: "pi-session-1" } }, get_entries: getEntries },
    });

    await manager.close();

    await expect(manager.createChat("c1")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
    expect(resources.snapshot()["pi-process"]).toBe(0);
  });
});

/**
 * A pi session directory holding one file per session, `cwd` being its working directory.
 *
 * @remarks
 * Each file has a header and a first question; the first is changed most recently.
 */
async function sessionsDir(sessions: { readonly id: string; readonly prompt: string; readonly cwd: string }[]) {
  const dir = await createTempDir("pi-sessions");
  cleanups.push(dir.cleanup);
  const folder = join(dir.path, "--work--");
  await mkdir(folder);
  const files: string[] = [];
  for (const [index, session] of sessions.entries()) {
    const path = join(folder, `${session.id}.jsonl`);
    const header = {
      type: "session",
      version: 3,
      id: session.id,
      timestamp: "2026-10-08T00:00:00.000Z",
      cwd: session.cwd,
    };
    const user = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-10-08T00:00:00.001Z",
      message: { role: "user", content: [{ type: "text", text: session.prompt }], timestamp: 1 },
    };
    await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`);
    const time = 2_000_000 - index * 1000;
    await utimes(path, time, time);
    files.push(path);
  }
  return { dir: dir.path, files };
}

/** The pi processes that have ended, by their spans. */
function piStarts(records: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return records.filter((record) => record["kind"] === "span" && record["name"] === "pi.process");
}

describe("createSessionManager opening sessions from pi's files", () => {
  it("lists the sessions pi's session directory holds, newest first, with their first question", async () => {
    const cwd = await createTempDir("session-cwd");
    cleanups.push(cwd.cleanup);
    const { dir } = await sessionsDir([
      { id: "pi-session-1", prompt: "newest", cwd: cwd.path },
      { id: "pi-session-2", prompt: "older", cwd: cwd.path },
    ]);
    const { manager } = await manage({ rules: {} }, { PI_CODING_AGENT_SESSION_DIR: dir });

    expect(await manager.listRecentSessions(1)).toStrictEqual({
      sessions: [{ sessionId: "pi-session-1", firstPrompt: "newest", modifiedAt: 2_000_000_000 }],
    });
    expect((await manager.listRecentSessions(10)).sessions.map((session) => session.sessionId)).toStrictEqual([
      "pi-session-1",
      "pi-session-2",
    ]);
  });

  it("lists nothing while pi has not been looked for", async () => {
    const { manager } = await manage(null);

    expect(await manager.listRecentSessions(10)).toStrictEqual({ sessions: [] });
  });

  it("opens a session with pi --session in the directory it recorded, then returns it while its pi runs", async () => {
    const cwd = await createTempDir("session-cwd");
    cleanups.push(cwd.cleanup);
    const { dir, files } = await sessionsDir([{ id: "pi-session-1", prompt: "ping", cwd: cwd.path }]);
    const { manager, received, records } = await manage(
      { argvToStderr: true, rules: { get_state: { data: { sessionId: "pi-session-1" } }, get_entries: getEntries } },
      { PI_CODING_AGENT_SESSION_DIR: dir },
    );

    expect(await manager.openSession("pi-session-1")).toStrictEqual({ sessionId: "pi-session-1" });
    expect(await manager.openSession("pi-session-1")).toStrictEqual({ sessionId: "pi-session-1" });
    await manager.subscribe("c1", ["pi-session-1"]);

    const real = await realpath(cwd.path);
    await vi.waitFor(() =>
      expect(records.filter((record) => record["msg"] === "pi stderr").map((record) => record["line"])).toStrictEqual([
        JSON.stringify({ argv: ["--mode", "rpc", "--session", files[0]], cwd: real }),
      ]),
    );
    expect(received).toMatchObject([{ type: "session_snapshot", items: [], exited: false }]);
  });

  it("starts one pi when a session is opened twice at once, and another once that pi has exited", async () => {
    const cwd = await createTempDir("session-cwd");
    cleanups.push(cwd.cleanup);
    const { dir } = await sessionsDir([{ id: "pi-session-1", prompt: "ping", cwd: cwd.path }]);
    const { manager, received, records } = await manage(
      {
        rules: {
          get_state: { data: { sessionId: "pi-session-1" } },
          get_entries: getEntries,
          prompt: { data: { disposition: "started" }, exitAfter: 1 },
        },
      },
      { PI_CODING_AGENT_SESSION_DIR: dir },
    );
    const starts = () => piStarts(records);

    await Promise.all([manager.openSession("pi-session-1"), manager.openSession("pi-session-1")]);
    await manager.subscribe("c1", ["pi-session-1"]);
    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "bye" });
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe("session_exited"));
    expect(starts()).toHaveLength(1);

    expect(await manager.openSession("pi-session-1")).toStrictEqual({ sessionId: "pi-session-1" });
    await manager.subscribe("c1", []);
    await manager.subscribe("c1", ["pi-session-1"]);
    // The new pi's session continues in a new epoch, so a client showing the old one resyncs.
    expect(received.at(-1)).toMatchObject({ type: "session_snapshot", epoch: 2, seq: 0, exited: false });
    await manager.close();
    await vi.waitFor(() => expect(starts()).toHaveLength(2));
  });

  it("stops the pi of a session opened after the manager closed", async () => {
    const cwd = await createTempDir("session-cwd");
    cleanups.push(cwd.cleanup);
    const { dir } = await sessionsDir([{ id: "pi-session-1", prompt: "ping", cwd: cwd.path }]);
    const { manager, resources } = await manage({ rules: {} }, { PI_CODING_AGENT_SESSION_DIR: dir });
    // Listed first, so opening finds the file without scanning and gets as far as starting pi.
    await manager.listRecentSessions(10);

    await manager.close();

    await expect(manager.openSession("pi-session-1")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
    expect(resources.snapshot()["pi-process"]).toBe(0);
  });

  it("stops scanning pi's session directory once the manager closes", async () => {
    const { dir } = await sessionsDir([]);
    const { manager } = await manage({ rules: {} }, { PI_CODING_AGENT_SESSION_DIR: dir });

    await manager.close();

    await expect(manager.listRecentSessions(10)).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
    await expect(manager.openSession("anything")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
  });

  it("refuses a session whose recorded directory is gone, naming it, without starting pi", async () => {
    const gone = join(await realpath(tmpdir()), "atrium-removed-workspace");
    const { dir } = await sessionsDir([{ id: "pi-session-1", prompt: "ping", cwd: gone }]);
    const { manager, records } = await manage({ rules: {} }, { PI_CODING_AGENT_SESSION_DIR: dir });

    await expect(manager.openSession("pi-session-1")).rejects.toStrictEqual(
      new CommandError("session_cwd_missing", { cwd: gone }),
    );
    expect(piStarts(records)).toStrictEqual([]);
  });

  it("refuses a session it has no file for, and one when pi cannot be used", async () => {
    const { dir } = await sessionsDir([]);
    const { manager } = await manage({ rules: {} }, { PI_CODING_AGENT_SESSION_DIR: dir });
    const missing = await manage({ env: {}, pi: { status: "missing" } });

    await expect(manager.openSession("nope")).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "nope" }),
    );
    await expect(missing.manager.openSession("nope")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "missing" }),
    );
  });
});
