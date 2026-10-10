import { type SessionsLocation, createSessionFileReader, sessionFolder } from "@atrium/pi";
import {
  CHATS,
  CommandError,
  IDLE_CONTROL,
  type SessionEvent,
  type SessionModel,
  UNKNOWN_METRICS,
} from "@atrium/protocol";
import { type ScriptedPiBehavior, createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { PONG_ENTRIES as getEntries, PONG_TURN as turn } from "../../test/scripted-chat";
import { systemClock } from "../platform/clock";
import { loadIndexFile } from "../store/index-file";
import { LAYOUTS_FILE, SESSIONS_FILE } from "../store/index-schema";
import { SubscriptionRegistry } from "../sync/subscriptions";
import { createLayouts } from "./layouts";
import { createSessionCatalog } from "./session-catalog";
import type { TurnStarts } from "../store/turn-starts";
import { type SessionTools, createSessionManager } from "./session-manager";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const WORKSPACE = "wks_000000000000000a";

/** pi's answers when it runs the session `pi-session-1`. */
const SESSION_ONE = { get_state: { data: { sessionId: "pi-session-1" } }, get_entries: getEntries };

/** A home, pi's session directory and a workspace directory, at real paths, shared by managers. */
async function place() {
  const temp = await createTempDir("sessions-home");
  cleanups.push(temp.cleanup);
  const root = await realpath(temp.path);
  const workspace = join(root, "app");
  await mkdir(workspace);
  return { root, home: join(root, "atrium"), piSessions: join(root, "pi-sessions"), workspace };
}

/**
 * A manager over real index files, catalog and layouts, with a scripted pi.
 *
 * @remarks
 * `tools` is a scripted pi's behavior, or tools as detection would report them. The workspace
 * service is a stand-in that knows one workspace and records refreshes.
 *
 * @sideEffects Creates files; starts nothing until a command.
 * @param tools - The pi.
 * @param where - The directories, to share between managers.
 * @param turnStarts - Where turn starts are read from, if not the default.
 * @param location - Where pi keeps sessions, when a test holds back the first scan.
 * @param models - The model new sessions start with and where choices go, if a test needs them.
 * @param files - The file search behind `@`, if a test needs it.
 * @returns The manager and what tests look at.
 */
async function manage(
  tools: ScriptedPiBehavior | SessionTools | null,
  where?: Awaited<ReturnType<typeof place>>,
  turnStarts?: (sessionId: string) => Promise<TurnStarts>,
  location?: Promise<SessionsLocation | null>,
  models?: Parameters<typeof createSessionManager>[0]["models"],
  files?: Parameters<typeof createSessionManager>[0]["files"],
) {
  const at = where ?? (await place());
  const recording = recordingTracing();
  cleanups.push(recording.shutdown);
  let found: SessionTools | null;
  if (tools === null || "pi" in tools) {
    found = tools;
  } else {
    const own = await createTempDir("scripted");
    cleanups.push(own.cleanup);
    const scripted = await writeScriptedPi(own.path, tools);
    found = {
      env: { PATH: process.env["PATH"] ?? "", PI_CODING_AGENT_SESSION_DIR: at.piSessions, ...scripted.env },
      pi: { status: "ready", piPath: scripted.piPath, version: [1, 0, 2] },
    };
  }
  const subscriptions = new SubscriptionRegistry(recording.resources);
  const received: SessionEvent[] = [];
  subscriptions.connect("c1", (event) => received.push(event as SessionEvent), "client-1");
  const index = join(at.home, "index");
  const catalog = createSessionCatalog({
    file: (await loadIndexFile(index, SESSIONS_FILE, 0)).file,
    location: location ?? Promise.resolve({ directory: at.piSessions, perCwd: false }),
    chatsRoot: join(at.home, "chats"),
    workspaces: () => [{ id: WORKSPACE, dir: at.workspace }],
    reader: createSessionFileReader(),
    clock: systemClock,
    logger: recording.logger,
  });
  const layouts = createLayouts({ file: (await loadIndexFile(index, LAYOUTS_FILE, 0)).file, clock: systemClock });
  const refreshed: string[] = [];
  let changes = 0;
  let next = 0;
  const manager = createSessionManager({
    chatsRoot: join(at.home, "chats"),
    tools: Promise.resolve(found),
    subscriptions,
    catalog,
    layouts,
    workspaces: {
      dirOf: (id) => (id === WORKSPACE ? at.workspace : undefined),
      refresh: (id) => refreshed.push(id),
    },
    onChange: () => (changes += 1),
    clock: systemClock,
    resources: recording.resources,
    tracer: recording.tracer,
    logger: recording.logger,
    newId: () => `id${++next}`,
    ...(turnStarts === undefined ? {} : { turnStarts }),
    ...(models === undefined ? {} : { models }),
    ...(files === undefined ? {} : { files }),
  });
  cleanups.push(
    () => manager.close(),
    () => catalog.close(),
  );
  return {
    manager,
    catalog,
    layouts,
    received,
    subscriptions,
    refreshed,
    at,
    records: recording.records,
    resources: recording.resources,
    changes: () => changes,
    /** The arguments and directory of every pi started, from the scripted pi's stderr. */
    starts: () =>
      recording.records
        .filter((record) => record["msg"] === "pi stderr")
        .map((record) => JSON.parse(String(record["line"])) as { argv: string[]; cwd: string }),
    /** The commands pi received, whole, when it writes them to stderr (`receivedToStderr`). */
    piReceived: () =>
      recording.records
        .filter((record) => record["msg"] === "pi stderr")
        .map((record) => JSON.parse(String(record["line"])) as { received?: Record<string, unknown> })
        .flatMap((line) => (line.received === undefined ? [] : [line.received])),
    /** The commands pi was sent, by type. */
    sent: () => recording.records.filter((record) => record["msg"] === "pi request").map((record) => record["command"]),
  };
}

type Manager = ReturnType<typeof createSessionManager>;

/**
 * Does something once, as a session's restart begins.
 *
 * @remarks
 * The restart begins before pi's crash is published, so `act` runs while the new pi starts.
 *
 * @sideEffects Connects client `c2`, which must then subscribe to the session.
 * @param subscriptions - Where sessions publish.
 * @param act - What to do.
 * @returns What `act` returned, once it is done.
 */
function whenRestarting(subscriptions: SubscriptionRegistry, act: () => Promise<unknown>): Promise<unknown> {
  const done = Promise.withResolvers<unknown>();
  let acted = false;
  subscriptions.connect(
    "c2",
    (raw) => {
      const event = raw as SessionEvent;
      if (acted || event.type !== "session_exited") return;
      acted = true;
      done.resolve(act());
    },
    "client-1",
  );
  return done.promise;
}

/**
 * Writes a session file where pi would, as a terminal session.
 *
 * @remarks
 * pi keeps them all in one directory here (`PI_CODING_AGENT_SESSION_DIR`).
 *
 * @sideEffects Writes the file.
 * @param at - The directories.
 * @param id - The session id.
 * @param cwd - Its working directory.
 * @returns The file's path.
 */
async function terminalSession(at: Awaited<ReturnType<typeof place>>, id: string, cwd: string): Promise<string> {
  const folder = sessionFolder({ directory: at.piSessions, perCwd: false }, cwd);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${id}.jsonl`);
  const user = { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: "hi" } };
  await writeFile(path, `${JSON.stringify({ type: "session", id, timestamp: "", cwd })}\n${JSON.stringify(user)}\n`);
  return path;
}

describe("SessionManager creating sessions", () => {
  it("opens a new session's tab where it belongs but leaves the client where it went while pi started", async () => {
    const { manager, layouts } = await manage({ rules: SESSION_ONE });

    const creating = manager.createSession("client-1", WORKSPACE);
    await manager.selectContainer("client-1", CHATS);
    const { sessionId } = await creating;

    expect(layouts.of("client-1")).toStrictEqual({
      container: CHATS,
      tabs: { [WORKSPACE]: { open: [sessionId], active: sessionId } },
    });
  });

  it("creates a chat in its own directory, starts its pi there, records it and opens it", async () => {
    const { manager, catalog, layouts, at, starts, changes } = await manage({ argvToStderr: true, rules: SESSION_ONE });

    expect(await manager.createChat("client-1")).toStrictEqual({ sessionId: "pi-session-1" });

    const cwd = join(at.home, "chats", "id1");
    await vi.waitFor(() => expect(starts()).toStrictEqual([{ argv: ["--mode", "rpc"], cwd }]));
    expect(catalog.find("pi-session-1")).toMatchObject({ containerId: "chats", cwd, state: "draft" });
    expect(layouts.of("client-1")).toStrictEqual({
      container: "chats",
      tabs: { chats: { open: ["pi-session-1"], active: "pi-session-1" } },
    });
    expect(changes()).toBeGreaterThan(0);
  });

  it("turns pi's automatic retries on before reading the session, whatever pi's settings say", async () => {
    const { manager, sent } = await manage({ rules: SESSION_ONE });

    await manager.createChat("client-1");

    expect(sent()).toStrictEqual(["set_auto_retry", "get_state", "get_entries", "get_session_stats"]);
  });

  it("creates a session in a workspace's directory, and refuses an unknown workspace", async () => {
    const { manager, catalog, layouts, at, starts } = await manage({ argvToStderr: true, rules: SESSION_ONE });

    await manager.createSession("client-1", WORKSPACE);

    await vi.waitFor(() => expect(starts()).toStrictEqual([{ argv: ["--mode", "rpc"], cwd: at.workspace }]));
    expect(catalog.find("pi-session-1")).toMatchObject({ containerId: WORKSPACE, state: "draft" });
    expect(layouts.of("client-1").container).toBe(WORKSPACE);
    await expect(manager.createSession("client-1", "wks_ffffffffffffffff")).rejects.toStrictEqual(
      new CommandError("workspace_not_found", { workspaceId: "wks_ffffffffffffffff" }),
    );
  });

  it.each([
    ["detection did not finish", null, "unknown"],
    ["pi is missing", { env: {}, pi: { status: "missing" } } satisfies SessionTools, "missing"],
  ])("refuses to create a chat when %s, leaving no directory behind", async (_case, tools, status) => {
    const { manager, at } = await manage(tools);

    await expect(manager.createChat("client-1")).rejects.toStrictEqual(new CommandError("pi_unavailable", { status }));
    expect(await readdir(join(at.home, "chats"))).toStrictEqual([]);
  });

  it("refuses to create a chat when pi exits before reporting its session", async () => {
    const { manager } = await manage({ exitCode: 1 });

    await expect(manager.createChat("client-1")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
  });

  it("stops a pi that cannot report its session, instead of leaving it running", async () => {
    const { manager, resources } = await manage({ rules: { get_state: { fail: "not ready" } } });

    await expect(manager.createChat("client-1")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "unresponsive" }),
    );
    expect(resources.snapshot()["pi-process"]).toBe(0);
  });
});

describe("SessionManager running sessions", () => {
  it("sends a subscriber the snapshot, then the session's events as pi works, and tracks the run", async () => {
    const { manager, received, records, refreshed, changes } = await manage({
      rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, events: turn } },
    });
    const { sessionId } = await manager.createSession("client-1", WORKSPACE);
    const runs: boolean[] = [];

    await manager.subscribe("c1", [sessionId]);
    const before = changes();
    const answer = await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" });
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe("run_settled"));
    runs.push(...manager.summaries().map((summary) => summary.running));
    // The read after the run finds what was sent, so nothing follows it.
    await vi.waitFor(() => expect(records.filter((record) => record["name"] === "pi.rpc get_entries")).toHaveLength(2));

    expect(answer).toStrictEqual({ disposition: "started" });
    expect(received.map((event) => [event.type, event.seq])).toStrictEqual([
      ["session_snapshot", 0],
      ["run_started", 1],
      ["turn_started", 2],
      ["step_added", 3],
      ["step_delta", 4],
      ["turn_finished", 5],
      ["run_settled", 6],
      // The entries read after the run hold the reply's tokens (SPEC-0001, "状态栏（M1.8）").
      ["metrics_updated", 7],
    ]);
    expect(runs).toStrictEqual([false]);
    expect(changes() - before).toBe(2);
    expect(refreshed).toStrictEqual([WORKSPACE]);
  });

  it("logs a failed read of pi's entries by its command and reason, never pi's own text", async () => {
    const { manager, records } = await manage({
      rules: {
        get_state: { data: { sessionId: "pi-session-1" } },
        get_entries: { sequence: [{ data: { entries: [], leafId: null } }, { fail: "secret-in-pi-text" }] },
        prompt: { data: { disposition: "started" }, events: turn },
      },
    });
    const { sessionId } = await manager.createChat("client-1");

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
    const { manager, received } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createChat("client-1");

    await manager.subscribe("c1", [sessionId]);
    await manager.subscribe("c1", [sessionId]);

    expect(received.map((event) => event.type)).toStrictEqual(["session_snapshot"]);
  });

  it("answers commands on sessions it does not know with session_not_found", async () => {
    const { manager } = await manage(null);
    const notFound = new CommandError("session_not_found", { sessionId: "nope" });

    await expect(manager.subscribe("c1", ["nope"])).rejects.toStrictEqual(notFound);
    await expect(
      manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "nope", text: "x" }),
    ).rejects.toStrictEqual(notFound);
    await expect(manager.openSession("client-1", "nope")).rejects.toStrictEqual(notFound);
    await expect(manager.archiveSession("nope")).rejects.toStrictEqual(notFound);
    await expect(manager.renameSession("nope", "x")).rejects.toStrictEqual(notFound);
    await expect(
      manager.fetchStep({
        type: "fetch_step",
        requestId: "r",
        traceparent,
        sessionId: "nope",
        epoch: 1,
        turnId: "t",
        stepId: "0",
      }),
    ).rejects.toStrictEqual(notFound);
  });

  it("stops every pi when it closes, which subscribers see as a requested exit", async () => {
    const { manager, received } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createChat("client-1");
    await manager.subscribe("c1", [sessionId]);

    await manager.close();
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe("session_exited"));

    expect(received.at(-1)).toMatchObject({ reason: "requested", code: 0 });
  });

  it("stops the pi of a chat whose creation finishes after the manager closed", async () => {
    const { manager, resources } = await manage({ rules: SESSION_ONE });

    await manager.close();

    await expect(manager.createChat("client-1")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
    expect(resources.snapshot()["pi-process"]).toBe(0);
  });
});

describe("SessionManager opening sessions", () => {
  it("opens a terminal session with pi --session in its directory, once, as the active tab", async () => {
    const at = await place();
    const file = await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog, layouts, starts, received } = await manage(
      { argvToStderr: true, rules: SESSION_ONE },
      at,
    );
    await catalog.scan();

    await Promise.all([
      manager.openSession("client-1", "pi-session-1"),
      manager.openSession("client-1", "pi-session-1"),
    ]);
    await manager.openSession("client-1", "pi-session-1");
    await manager.subscribe("c1", ["pi-session-1"]);

    await vi.waitFor(() =>
      expect(starts()).toStrictEqual([{ argv: ["--mode", "rpc", "--session", file], cwd: at.workspace }]),
    );
    expect(layouts.of("client-1")).toStrictEqual({
      container: WORKSPACE,
      tabs: { [WORKSPACE]: { open: ["pi-session-1"], active: "pi-session-1" } },
    });
    expect(received).toMatchObject([{ type: "session_snapshot", epoch: 1, exited: false }]);
  });

  it("starts pi again with the session's file after a crash, resending what pi had not taken, three times at most", async () => {
    const at = await place();
    const file = await terminalSession(at, "pi-session-1", at.workspace);
    // Each pi answers the prompt and dies before any run starts, so each restart sends it again.
    const { manager, catalog, received, starts } = await manage(
      { argvToStderr: true, rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, exitAfter: 1 } } },
      at,
    );
    await catalog.scan();
    await manager.openSession("client-1", "pi-session-1");
    await manager.subscribe("c1", ["pi-session-1"]);
    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "bye" });

    await vi.waitFor(() =>
      expect(received.at(-1)).toMatchObject({ type: "control_updated", control: { failure: { attempts: 3 } } }),
    );
    expect(received.filter((event) => event.type === "notice_added")).toMatchObject(
      [1, 2, 3].map((attempt) => ({ epoch: attempt + 1, notice: { notice: "restarted", attempt } })),
    );
    expect(received.filter((event) => event.type === "session_snapshot").map((event) => event.epoch)).toStrictEqual([
      1, 2, 3, 4,
    ]);
    expect(starts().map((start) => start.argv)).toStrictEqual(
      Array.from({ length: 4 }, () => ["--mode", "rpc", "--session", file]),
    );
    expect(manager.summaries()).toMatchObject([{ sessionId: "pi-session-1", running: false, failed: true }]);
  });

  it("starts pi for a session that gave up restarting when its queue is resumed", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog, received, starts } = await manage(
      { argvToStderr: true, rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, exitAfter: 1 } } },
      at,
    );
    await catalog.scan();
    await manager.openSession("client-1", "pi-session-1");
    await manager.subscribe("c1", ["pi-session-1"]);
    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "bye" });
    await vi.waitFor(() =>
      expect(received.at(-1)).toMatchObject({ type: "control_updated", control: { failure: { attempts: 3 } } }),
    );

    expect(await manager.resumeQueue("pi-session-1")).toStrictEqual({});

    expect(starts()).toHaveLength(5);
    expect(received.at(-1)).toMatchObject({ type: "session_snapshot", epoch: 5, exited: false });
  });

  it("starts no second pi for a message or an open while pi starts again, queueing the message", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog, received, starts, subscriptions } = await manage(
      { argvToStderr: true, rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, exitAfter: 1 } } },
      at,
    );
    await catalog.scan();
    await manager.openSession("client-1", "pi-session-1");
    await manager.subscribe("c1", ["pi-session-1"]);
    const meanwhile = whenRestarting(subscriptions, () =>
      Promise.all([
        manager.prompt({ type: "prompt", requestId: "q2", traceparent, sessionId: "pi-session-1", text: "two" }),
        manager.openSession("client-1", "pi-session-1"),
      ]),
    );
    await manager.subscribe("c2", ["pi-session-1"]);

    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "bye" });

    expect(await meanwhile).toMatchObject([{ disposition: "queued" }, {}]);
    await vi.waitFor(() =>
      expect(received.at(-1)).toMatchObject({ type: "control_updated", control: { failure: { attempts: 3 } } }),
    );
    expect(starts()).toHaveLength(4);
    expect(received.at(-1)).toMatchObject({ control: { queue: [{ text: "two" }] } });
  });

  it.each([
    { how: "archive", act: (manager: Manager) => manager.archiveSession("pi-session-1") },
    { how: "close", act: (manager: Manager) => manager.close() },
  ])("stops a restart under way when the session is closed by $how, starting no more pi", async ({ act }) => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog, received, starts, subscriptions, resources } = await manage(
      { argvToStderr: true, rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, exitAfter: 1 } } },
      at,
    );
    await catalog.scan();
    await manager.openSession("client-1", "pi-session-1");
    await manager.subscribe("c1", ["pi-session-1"]);
    const closed = whenRestarting(subscriptions, () => act(manager));
    await manager.subscribe("c2", ["pi-session-1"]);

    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "bye" });
    await closed;

    expect(starts()).toHaveLength(2);
    expect(resources.snapshot()["pi-process"]).toBe(0);
    expect(received.filter((event) => event.type === "session_snapshot").map((event) => event.epoch)).toStrictEqual([
      1,
    ]);
  });

  it("refuses a session whose directory is gone, or whose file went missing, without starting pi", async () => {
    const at = await place();
    await terminalSession(at, "gone-dir", at.workspace);
    const goneFile = await terminalSession(at, "gone-file", at.workspace);
    const { manager, catalog, starts } = await manage({ argvToStderr: true, rules: SESSION_ONE }, at);
    await catalog.record({ sessionId: "gone-file", containerId: WORKSPACE, cwd: at.workspace });
    await catalog.scan();
    await rm(goneFile);
    await catalog.scan();
    await rm(at.workspace, { recursive: true });

    await expect(manager.openSession("client-1", "gone-dir")).rejects.toStrictEqual(
      new CommandError("session_cwd_missing", { cwd: at.workspace }),
    );
    await expect(manager.openSession("client-1", "gone-file")).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "gone-file" }),
    );
    expect(starts()).toStrictEqual([]);
  });

  it("restores a draft without starting pi, and starts it with its id on the first message", async () => {
    const at = await place();
    const first = await manage({ rules: SESSION_ONE }, at);
    await first.manager.createSession("client-1", WORKSPACE);
    await first.manager.close();
    await first.catalog.close();

    const { manager, received, starts } = await manage(
      { argvToStderr: true, rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, events: turn } } },
      at,
    );
    await manager.openSession("client-1", "pi-session-1");
    await manager.subscribe("c1", ["pi-session-1"]);
    expect(starts()).toStrictEqual([]);
    expect(received).toStrictEqual([
      {
        type: "session_snapshot",
        sessionId: "pi-session-1",
        epoch: 0,
        seq: 0,
        traceId: null,
        items: [],
        hasOlder: false,
        run: null,
        exited: false,
        control: IDLE_CONTROL,
        model: null,
        metrics: UNKNOWN_METRICS,
      },
    ]);

    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "ping" });

    await vi.waitFor(() =>
      expect(starts()).toStrictEqual([{ argv: ["--mode", "rpc", "--session-id", "pi-session-1"], cwd: at.workspace }]),
    );
    expect(received[1]).toMatchObject({ type: "session_snapshot", epoch: 1 });
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe("run_settled"));
  });
});

describe("SessionManager tabs", () => {
  it("discards a draft that never got a message when its last tab closes, with its chat directory", async () => {
    const { manager, catalog, layouts, at, resources } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createChat("client-1");
    await manager.openSession("client-2", sessionId);

    await manager.closeTab("client-1", sessionId);
    expect(catalog.find(sessionId)?.state).toBe("draft");
    await manager.closeTab("client-2", sessionId);

    expect(catalog.find(sessionId)).toBeUndefined();
    expect(layouts.isOpen(sessionId)).toBe(false);
    expect(await readdir(join(at.home, "chats"))).toStrictEqual([]);
    await vi.waitFor(() => expect(resources.snapshot()["pi-process"]).toBe(0));
    await expect(manager.subscribe("c1", [sessionId])).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId }),
    );
  });

  it("keeps a session that got a message when its tab closes, though its file is not found yet", async () => {
    const { manager, catalog, at, received } = await manage({
      rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, events: turn } },
    });
    const chat = await manager.createChat("client-1");
    await manager.subscribe("c1", [chat.sessionId]);
    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: chat.sessionId, text: "ping" });
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe("run_settled"));

    await manager.closeTab("client-1", chat.sessionId);

    expect(catalog.find(chat.sessionId)).toMatchObject({ state: "draft" });
    expect(await readdir(join(at.home, "chats"))).toStrictEqual(["id1"]);
  });

  it("keeps a chat directory that holds files when its empty draft is discarded", async () => {
    const { manager, at } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createChat("client-1");
    await writeFile(join(at.home, "chats", "id1", "notes.md"), "kept");

    await manager.closeTab("client-1", sessionId);

    expect(await readdir(join(at.home, "chats", "id1"))).toStrictEqual(["notes.md"]);
  });

  it("closes a tab closed while its opening waited for the first scan, as the client asked last", async () => {
    const first = await manage({ rules: SESSION_ONE });
    const { sessionId } = await first.manager.createChat("client-1");
    await first.manager.close();
    const scanned = Promise.withResolvers<SessionsLocation | null>();
    const { manager, layouts, catalog } = await manage(null, first.at, undefined, scanned.promise);

    const opening = manager.openSession("client-1", sessionId);
    const closing = manager.closeTab("client-1", sessionId);
    scanned.resolve({ directory: first.at.piSessions, perCwd: false });
    await Promise.all([opening, closing]);

    expect(layouts.of("client-1")).toStrictEqual({ container: CHATS, tabs: { [CHATS]: { open: [], active: null } } });
    expect(catalog.find(sessionId)).toBeUndefined();
  });

  it("opens a session the index knows, and goes elsewhere, without waiting for the first scan", async () => {
    const first = await manage({ rules: SESSION_ONE });
    const { sessionId } = await first.manager.createSession("client-1", WORKSPACE);
    await first.manager.selectContainer("client-1", null);
    await first.manager.close();
    const scanned = Promise.withResolvers<SessionsLocation | null>();
    const { manager, layouts } = await manage(null, first.at, undefined, scanned.promise);

    // Answered once the scan tells whether its pi should start; the tab does not wait for that.
    const opening = manager.openSession("client-1", sessionId);
    await manager.selectContainer("client-1", CHATS);

    expect(layouts.of("client-1")).toStrictEqual({
      container: CHATS,
      tabs: { [WORKSPACE]: { open: [sessionId], active: sessionId } },
    });
    scanned.resolve({ directory: first.at.piSessions, perCwd: false });
    expect(await opening).toStrictEqual({});
  });

  it("does nothing more for a client's queued tab changes once it closes", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const scanned = Promise.withResolvers<SessionsLocation | null>();
    const { manager, layouts } = await manage(null, at, undefined, scanned.promise);

    const opening = manager.openSession("client-1", "pi-session-1");
    const selecting = manager.selectContainer("client-1", CHATS);
    await manager.close();
    scanned.resolve({ directory: at.piSessions, perCwd: false });

    expect(await opening).toStrictEqual({});
    expect(await selecting).toStrictEqual({});
    expect(layouts.of("client-1")).toStrictEqual({ container: null, tabs: {} });
  });

  it("goes on with a client's next tab change after one that failed", async () => {
    const at = await place();
    const scanned = Promise.withResolvers<SessionsLocation | null>();
    const { manager, layouts } = await manage(null, at, undefined, scanned.promise);

    const opening = manager.openSession("client-1", "nope");
    const selecting = manager.selectContainer("client-1", CHATS);
    scanned.resolve({ directory: at.piSessions, perCwd: false });

    await expect(opening).rejects.toStrictEqual(new CommandError("session_not_found", { sessionId: "nope" }));
    await selecting;

    expect(layouts.of("client-1")).toStrictEqual({ container: CHATS, tabs: {} });
  });

  it("goes to a container or nowhere, and closes a tab it does not have without complaint", async () => {
    const { manager, layouts, changes } = await manage(null);

    await manager.selectContainer("client-1", "chats");
    expect(layouts.of("client-1").container).toBe("chats");
    await manager.closeTab("client-1", "nope");
    await manager.selectContainer("client-1", null);

    expect(layouts.of("client-1").container).toBeNull();
    expect(changes()).toBe(3);
  });
});

describe("SessionManager archiving and renaming", () => {
  it("archives a session: stops its pi and closes its tabs everywhere", async () => {
    const { manager, catalog, layouts, received } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createSession("client-1", WORKSPACE);
    await manager.subscribe("c1", [sessionId]);

    await manager.archiveSession(sessionId);

    expect(catalog.find(sessionId)?.archived).toBe(true);
    expect(layouts.isOpen(sessionId)).toBe(false);
    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({ type: "session_exited", reason: "requested" }));
  });

  it("renames a session in pi, starting its pi first when it is not running", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog, sent } = await manage({ rules: { ...SESSION_ONE, set_session_name: { data: {} } } }, at);
    await catalog.scan();

    expect(await manager.renameSession("pi-session-1", "重构")).toStrictEqual({});

    expect(sent()).toContain("set_session_name");
  });
});

describe("SessionManager workspaces", () => {
  it("stops the sessions of workspaces that went away and drops them from layouts", async () => {
    const { manager, layouts, received } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createSession("client-1", WORKSPACE);
    await manager.subscribe("c1", [sessionId]);

    await manager.forgetWorkspaces([WORKSPACE]);

    expect(layouts.of("client-1")).toStrictEqual({ container: null, tabs: {} });
    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({ type: "session_exited" }));
  });

  it("lists its sessions with whether they run", async () => {
    const { manager } = await manage({ rules: SESSION_ONE });
    await manager.createSession("client-1", WORKSPACE);

    expect(manager.summaries()).toStrictEqual([
      {
        sessionId: "pi-session-1",
        containerId: WORKSPACE,
        name: null,
        prompt: null,
        file: null,
        state: "draft",
        updatedAt: expect.any(Number),
        archived: false,
        running: false,
        failed: false,
      },
    ]);
  });

  it("looks for terminal sessions when asked, logging a scan that fails", async () => {
    const at = await place();
    const { manager, catalog, records } = await manage(null, at);
    await terminalSession(at, "pi-session-1", at.workspace);

    manager.rescan();
    await vi.waitFor(() => expect(catalog.find("pi-session-1")).toMatchObject({ prompt: "hi" }));
    await catalog.close();
    manager.rescan();

    await vi.waitFor(() => expect(records.filter((record) => record["msg"] === "session scan failed")).toHaveLength(1));
  });
});

describe("SessionManager turn starts", () => {
  it("reads a session's turn starts when its pi starts, and adds the turns it sees", async () => {
    const asked: string[] = [];
    const recorded: string[][] = [];
    const { manager } = await manage(
      { rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, events: turn } } },
      undefined,
      async (sessionId) => {
        asked.push(sessionId);
        return { opened: new Set(), auto: new Set(), record: async (entryIds) => void recorded.push([...entryIds]) };
      },
    );
    const { sessionId } = await manager.createChat("client-1");

    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" });

    await vi.waitFor(() => expect(recorded).toStrictEqual([["u1"]]));
    expect(asked).toStrictEqual(["pi-session-1"]);
  });

  it("goes on without turn starts it cannot read, logging it", async () => {
    const { manager, records } = await manage({ rules: SESSION_ONE }, undefined, () =>
      Promise.reject(new Error("disk gone")),
    );

    const { sessionId } = await manager.createChat("client-1");

    expect(sessionId).toBe("pi-session-1");
    expect(records.filter((record) => record["msg"] === "turn starts could not be read")).toMatchObject([
      { level: "warn", sessionId: "pi-session-1", err: { message: "disk gone" } },
    ]);
  });

  it("logs a failed write of turn starts", async () => {
    const { manager, records } = await manage(
      { rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, events: turn } } },
      undefined,
      async () => ({ opened: new Set(), auto: new Set(), record: () => Promise.reject(new Error("disk full")) }),
    );
    const { sessionId } = await manager.createChat("client-1");

    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" });

    await vi.waitFor(() =>
      expect(records.filter((record) => record["msg"] === "turn starts failed")).toMatchObject([
        { level: "warn", err: { message: "disk full" } },
      ]),
    );
  });
});

describe("SessionManager after the review (2026-10-08)", () => {
  it("lets a client watch a session on file before its pi starts, and sends the snapshot once it has", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, received } = await manage({ rules: SESSION_ONE }, at);

    // As the UI does: the tab shows at once, and its view subscribes before the open has finished.
    const opening = manager.openSession("client-1", "pi-session-1");
    await manager.subscribe("c1", ["pi-session-1"]);
    expect(received).toStrictEqual([]);
    await opening;

    expect(received).toMatchObject([{ type: "session_snapshot", sessionId: "pi-session-1", epoch: 1 }]);
  });

  it("starts the pi of a session on file when a message comes before anyone opened it", async () => {
    const at = await place();
    const file = await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, starts } = await manage(
      { argvToStderr: true, rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" } } } },
      at,
    );

    const answer = await manager.prompt({
      type: "prompt",
      requestId: "q1",
      traceparent,
      sessionId: "pi-session-1",
      text: "hi",
    });

    expect(answer).toStrictEqual({ disposition: "started" });
    await vi.waitFor(() =>
      expect(starts()).toStrictEqual([{ argv: ["--mode", "rpc", "--session", file], cwd: at.workspace }]),
    );
  });

  it("keeps the tab of a session that cannot start, so the failure shows there", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog, layouts } = await manage({ rules: SESSION_ONE }, at);
    await catalog.scan();
    await rm(at.workspace, { recursive: true });

    await expect(manager.openSession("client-1", "pi-session-1")).rejects.toStrictEqual(
      new CommandError("session_cwd_missing", { cwd: at.workspace }),
    );

    expect(layouts.of("client-1").tabs).toStrictEqual({
      [WORKSPACE]: { open: ["pi-session-1"], active: "pi-session-1" },
    });
  });

  it("does not discard a restored draft whose first message is on its way", async () => {
    const at = await place();
    const first = await manage({ rules: SESSION_ONE }, at);
    const { sessionId } = await first.manager.createChat("client-1");
    await first.manager.close();
    await first.catalog.close();
    const { manager, catalog } = await manage(
      { rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, events: turn } } },
      at,
    );

    const sending = manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" });
    await manager.closeTab("client-1", sessionId);
    await sending;

    expect(catalog.find(sessionId)).toMatchObject({ containerId: "chats" });
    expect(await readdir(join(at.home, "chats"))).toStrictEqual(["id1"]);
  });

  it("does not discard a draft whose file pi has written since the last scan", async () => {
    const at = await place();
    const { manager, catalog } = await manage({ rules: SESSION_ONE }, at);
    const { sessionId } = await manager.createSession("client-1", WORKSPACE);
    // pi wrote the file, say just before the host last stopped; no scan has seen it yet.
    await terminalSession(at, sessionId, at.workspace);

    await manager.closeTab("client-1", sessionId);

    expect(catalog.find(sessionId)).toMatchObject({ state: "persisted" });
  });

  it("refuses to rename a draft, which has no file to keep the name in", async () => {
    const { manager } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createChat("client-1");

    await expect(manager.renameSession(sessionId, "名字")).rejects.toStrictEqual(
      new CommandError("session_is_draft", { sessionId }),
    );
  });
});

/** A model as pi's `get_state` reports it; the host reads only its provider and id. */
const HAIKU = { id: "haiku", provider: "anthropic" };

/** The choices a manager reported, and a remembered model to start new sessions with. */
function remembering(
  preferred: { providerId: string; modelId: string; thinkingLevel: SessionModel["thinkingLevel"] | null } | null,
) {
  const chosen: SessionModel[] = [];
  let remembered = preferred;
  return {
    chosen,
    /** Remembers another model, as a choice in another session would. */
    prefer: (next: typeof preferred) => {
      remembered = next;
    },
    models: {
      preferred: () =>
        remembered === null
          ? null
          : {
              model: { providerId: remembered.providerId, modelId: remembered.modelId },
              thinkingLevel: remembered.thinkingLevel,
            },
      chosen: (model: SessionModel) => chosen.push(model),
    },
  };
}

/** The commands pi received, without their ids. */
function withoutIds(commands: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return commands.map(({ id: _id, ...rest }) => rest);
}

/** What the host reads from pi in the background, after runs and changes. */
const BACKGROUND_READS = ["get_entries", "get_session_stats"];

describe("SessionManager models", () => {
  it("starts a new session on the model chosen last, with its thinking level, before reading the session", async () => {
    const { models } = remembering({ providerId: "anthropic", modelId: "haiku", thinkingLevel: "low" });
    const { manager, piReceived, received } = await manage(
      {
        receivedToStderr: true,
        rules: {
          ...SESSION_ONE,
          get_state: { data: { sessionId: "pi-session-1", model: HAIKU, thinkingLevel: "low" } },
        },
      },
      undefined,
      undefined,
      undefined,
      models,
    );

    await manager.createChat("client-1");

    await vi.waitFor(() =>
      expect(withoutIds(piReceived())).toStrictEqual([
        { type: "set_auto_retry", enabled: true },
        { type: "set_model", provider: "anthropic", modelId: "haiku" },
        { type: "set_thinking_level", level: "low" },
        { type: "get_state" },
        { type: "get_entries" },
        { type: "get_session_stats" },
      ]),
    );
    await manager.subscribe("c1", ["pi-session-1"]);
    expect(received).toMatchObject([
      { type: "session_snapshot", model: { providerId: "anthropic", modelId: "haiku", thinkingLevel: "low" } },
    ]);
  });

  it("sets no thinking level when none was remembered for the model", async () => {
    const { models } = remembering({ providerId: "anthropic", modelId: "haiku", thinkingLevel: null });
    const { manager, sent } = await manage({ rules: SESSION_ONE }, undefined, undefined, undefined, models);

    await manager.createChat("client-1");

    expect(sent()).toStrictEqual(["set_auto_retry", "set_model", "get_state", "get_entries", "get_session_stats"]);
  });

  it("leaves pi's own model when none was chosen yet", async () => {
    const { models } = remembering(null);
    const { manager, sent } = await manage({ rules: SESSION_ONE }, undefined, undefined, undefined, models);

    await manager.createChat("client-1");

    expect(sent()).toStrictEqual(["set_auto_retry", "get_state", "get_entries", "get_session_stats"]);
  });

  it("starts the session on pi's own model when the remembered one is gone, logging only that", async () => {
    const { models } = remembering({ providerId: "anthropic", modelId: "gone", thinkingLevel: "low" });
    const { manager, sent, records } = await manage(
      { rules: { ...SESSION_ONE, set_model: { fail: "Model not found: anthropic/gone" } } },
      undefined,
      undefined,
      undefined,
      models,
    );

    expect(await manager.createChat("client-1")).toStrictEqual({ sessionId: "pi-session-1" });

    expect(sent()).toStrictEqual(["set_auto_retry", "set_model", "get_state", "get_entries", "get_session_stats"]);
    expect(records.filter((record) => record["msg"] === "remembered model not set")).toStrictEqual([
      expect.objectContaining({ level: "warn", command: "set_model", reason: "rejected" }),
    ]);
    expect(JSON.stringify(records)).not.toContain("Model not found");
  });

  it("opens a session on file on its own model", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { models } = remembering({ providerId: "anthropic", modelId: "haiku", thinkingLevel: "low" });
    const { manager, catalog, sent } = await manage({ rules: SESSION_ONE }, at, undefined, undefined, models);
    await catalog.scan();

    await manager.openSession("client-1", "pi-session-1");

    expect(sent()).toStrictEqual(["set_auto_retry", "get_state", "get_entries", "get_session_stats"]);
  });

  it("switches a session's model and thinking level, reporting what pi then uses", async () => {
    const { models, chosen } = remembering(null);
    const { manager, piReceived } = await manage(
      {
        receivedToStderr: true,
        rules: {
          ...SESSION_ONE,
          get_state: { data: { sessionId: "pi-session-1", model: HAIKU, thinkingLevel: "off" } },
        },
      },
      undefined,
      undefined,
      undefined,
      models,
    );
    await manager.createChat("client-1");

    expect(await manager.setModel("pi-session-1", { providerId: "anthropic", modelId: "haiku" })).toStrictEqual({});
    expect(await manager.setThinkingLevel("pi-session-1", "off")).toStrictEqual({});

    // Entries are read after each change too, in the background; stderr may lag behind the answers.
    await vi.waitFor(() =>
      expect(
        withoutIds(piReceived().filter((command) => !BACKGROUND_READS.includes(String(command["type"])))).slice(2),
      ).toStrictEqual([
        { type: "set_model", provider: "anthropic", modelId: "haiku" },
        { type: "get_state" },
        { type: "set_thinking_level", level: "off" },
        { type: "get_state" },
      ]),
    );
    expect(chosen).toStrictEqual([
      { providerId: "anthropic", modelId: "haiku", thinkingLevel: "off" },
      { providerId: "anthropic", modelId: "haiku", thinkingLevel: "off" },
    ]);
  });

  it("starts a draft's pi again on the model it had, not one chosen since elsewhere, and goes on reporting it", async () => {
    const memory = remembering(null);
    const { manager, received, piReceived } = await manage(
      {
        receivedToStderr: true,
        rules: {
          ...SESSION_ONE,
          get_state: { data: { sessionId: "pi-session-1", model: HAIKU, thinkingLevel: "low" } },
          prompt: { data: { disposition: "started" }, exitAfter: 1 },
        },
      },
      undefined,
      undefined,
      undefined,
      memory.models,
    );
    await manager.createChat("client-1");
    await manager.subscribe("c1", ["pi-session-1"]);
    memory.prefer({ providerId: "openai", modelId: "gpt", thinkingLevel: null });

    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "bye" });
    await vi.waitFor(() =>
      expect(received.at(-1)).toMatchObject({ type: "control_updated", control: { failure: { attempts: 3 } } }),
    );
    expect(await manager.resumeQueue("pi-session-1")).toStrictEqual({});

    await vi.waitFor(() =>
      expect(
        withoutIds(piReceived()).filter((command) =>
          ["set_model", "set_thinking_level"].includes(String(command["type"])),
        ),
      ).toStrictEqual(
        Array.from({ length: 4 }, () => [
          { type: "set_model", provider: "anthropic", modelId: "haiku" },
          { type: "set_thinking_level", level: "low" },
        ]).flat(),
      ),
    );
    expect(received.at(-1)).toMatchObject({
      type: "session_snapshot",
      model: { providerId: "anthropic", modelId: "haiku", thinkingLevel: "low" },
    });
  });

  it("refuses to switch the model of an unknown session", async () => {
    const { manager } = await manage({ rules: SESSION_ONE });

    await expect(manager.setModel("nope", { providerId: "a", modelId: "b" })).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "nope" }),
    );
    await expect(manager.setThinkingLevel("nope", "low")).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "nope" }),
    );
  });
});

describe("SessionManager commands", () => {
  it("lists a restored draft's commands by starting its pi with its id", async () => {
    const at = await place();
    const first = await manage({ rules: SESSION_ONE }, at);
    await first.manager.createSession("client-1", WORKSPACE);
    await first.manager.close();
    await first.catalog.close();
    const listed = {
      commands: [
        { name: "review", description: "Reviews", source: "prompt", sourceInfo: {} },
        { name: "skill:tdd", source: "skill", sourceInfo: {} },
      ],
    };
    const { manager, starts } = await manage(
      { argvToStderr: true, rules: { ...SESSION_ONE, get_commands: { data: listed } } },
      at,
    );

    expect(await manager.listCommands("pi-session-1")).toStrictEqual({
      commands: [
        { name: "review", description: "Reviews", source: "prompt" },
        { name: "skill:tdd", description: null, source: "skill" },
      ],
    });
    await vi.waitFor(() =>
      expect(starts()).toStrictEqual([{ argv: ["--mode", "rpc", "--session-id", "pi-session-1"], cwd: at.workspace }]),
    );
  });

  it("refuses the commands of an unknown session", async () => {
    const { manager } = await manage({ rules: SESSION_ONE });

    await expect(manager.listCommands("nope")).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "nope" }),
    );
  });
});

/** A search that records what it was asked, answering only when told. */
function recordingSearch() {
  const asked: { readonly cwd: string; readonly query: string; readonly signal: AbortSignal }[] = [];
  const answers: ((files: { path: string; directory: boolean }[]) => void)[] = [];
  return {
    asked,
    answers,
    files: {
      search: (cwd: string, query: string, signal: AbortSignal) =>
        new Promise<{ path: string; directory: boolean }[]>((resolve) => {
          asked.push({ cwd, query, signal });
          answers.push(resolve);
        }),
    },
  };
}

describe("SessionManager file search", () => {
  it("searches the session's directory, calling off the session's previous search", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { files, asked, answers } = recordingSearch();
    const { manager, catalog } = await manage({ rules: SESSION_ONE }, at, undefined, undefined, undefined, files);
    await catalog.scan();

    const first = manager.searchFiles("pi-session-1", "se");
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    const second = manager.searchFiles("pi-session-1", "ses");
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    answers[1]?.([{ path: "session.ts", directory: false }]);
    answers[0]?.([]);

    expect(await second).toStrictEqual({ files: [{ path: "session.ts", directory: false }] });
    expect(await first).toStrictEqual({ files: [] });
    expect(asked.map(({ cwd, query }) => [cwd, query])).toStrictEqual([
      [at.workspace, "se"],
      [at.workspace, "ses"],
    ]);
    expect(asked.map(({ signal }) => signal.aborted)).toStrictEqual([true, false]);
  });

  it("refuses an unknown session, and answers fd_missing with no search", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog } = await manage({ rules: SESSION_ONE }, at);
    await catalog.scan();

    await expect(manager.searchFiles("nope", "x")).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "nope" }),
    );
    await expect(manager.searchFiles("pi-session-1", "x")).rejects.toStrictEqual(new CommandError("fd_missing"));
  });
});
