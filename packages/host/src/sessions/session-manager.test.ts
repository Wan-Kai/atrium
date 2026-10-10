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
import { appendFile, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
    tools: () => Promise.resolve(found),
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
    await vi.waitFor(() => expect(received.map((event) => event.type)).toContain("run_settled"));
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
    expect(manager.summaries()).toMatchObject([
      { sessionId: "pi-session-1", running: false, attention: { reason: "error", cleared: false } },
    ]);
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
    await vi.waitFor(() => expect(received.map((event) => event.type)).toContain("run_settled"));
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
    await vi.waitFor(() => expect(received.map((event) => event.type)).toContain("run_settled"));

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
  it("archives a session: stops its pi, closes its tabs everywhere and lets go of its controller", async () => {
    const { manager, catalog, layouts, received, resources } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createSession("client-1", WORKSPACE);
    await manager.subscribe("c1", [sessionId]);
    expect(resources.snapshot()["session.controller"]).toBe(1);

    await manager.archiveSession(sessionId);

    expect(catalog.find(sessionId)?.archived).toBe(true);
    expect(layouts.isOpen(sessionId)).toBe(false);
    expect(resources.snapshot()["session.controller"]).toBe(0);
    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({ type: "session_exited", reason: "requested" }));
  });

  it("stops the pi of a session archived while it started, keeping no controller", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const reading = Promise.withResolvers<void>();
    const read = Promise.withResolvers<TurnStarts>();
    const { manager, catalog, resources } = await manage({ rules: SESSION_ONE }, at, () => {
      reading.resolve();
      return read.promise;
    });
    await catalog.scan();
    const opening = manager.openSession("client-1", "pi-session-1").catch((error: unknown) => error);
    await reading.promise;

    const archiving = manager.archiveSession("pi-session-1");
    read.resolve({ opened: new Set(), auto: new Set(), record: async () => undefined });
    await archiving;
    await opening;

    expect(catalog.find("pi-session-1")?.archived).toBe(true);
    expect(resources.snapshot()["session.controller"]).toBe(0);
    expect(resources.snapshot()["pi-process"]).toBe(0);
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
  it("stops the sessions of workspaces that went away, lets go of their controllers and drops them from layouts", async () => {
    const { manager, layouts, received, resources } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createSession("client-1", WORKSPACE);
    await manager.subscribe("c1", [sessionId]);
    expect(resources.snapshot()["session.controller"]).toBe(1);

    await manager.forgetWorkspaces([WORKSPACE]);

    expect(layouts.of("client-1")).toStrictEqual({ container: null, tabs: {} });
    expect(resources.snapshot()["session.controller"]).toBe(0);
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
        attention: null,
        asking: null,
        handedOff: false,
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

  it("finds a draft's file as soon as pi has its first message, while the run goes on", async () => {
    const at = await place();
    const { manager, catalog } = await manage(
      { rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, events: turn.slice(0, 2) } } },
      at,
    );
    const { sessionId } = await manager.createSession("client-1", WORKSPACE);
    await catalog.ready();
    // pi writes the message to the file as it reports it.
    await terminalSession(at, sessionId, at.workspace);

    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" });

    await vi.waitFor(() => expect(catalog.find(sessionId)).toMatchObject({ state: "persisted", prompt: "hi" }));
    expect(manager.summaries().find((summary) => summary.sessionId === sessionId)?.running).toBe(true);
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

/**
 * What pi prints for a prompt whose run fails with `error` once pi's retries are used up.
 *
 * @remarks
 * pi reports the failure on the reply's `message_end` (pi-internals.md §3).
 *
 * @sideEffects none
 * @param error - pi's own text.
 * @returns The events.
 */
function failingTurn(error: string): readonly object[] {
  return [
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "ping" }], timestamp: 1 } },
    { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 2 } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: error,
        usage: { input: 3, output: 0 },
        timestamp: 2,
      },
    },
    { type: "agent_settled" },
  ];
}

/**
 * A terminal session opened and watched, whose pi answers successive prompts with `turns`.
 *
 * @remarks
 * The last of `turns` repeats.
 *
 * @sideEffects Writes the session's file; starts its pi.
 * @param turns - What pi prints for each prompt.
 * @param rules - More of pi's answers.
 * @param more - More of pi's behavior.
 * @returns The manager and what tests look at.
 */
async function opened(
  turns: readonly (readonly object[])[],
  rules: Record<string, object> = {},
  more: Omit<ScriptedPiBehavior, "rules"> = {},
) {
  const at = await place();
  const file = await terminalSession(at, "pi-session-1", at.workspace);
  const managed = await manage(
    {
      argvToStderr: true,
      ...more,
      rules: {
        ...SESSION_ONE,
        prompt: { sequence: turns.map((events) => ({ data: { disposition: "started" }, events })) },
        ...rules,
      },
    },
    at,
  );
  await managed.catalog.scan();
  await managed.manager.openSession("client-1", "pi-session-1");
  await managed.manager.subscribe("c1", ["pi-session-1"]);
  /** Sends a message and waits for its run to end. */
  const run = async () => {
    const settled = managed.received.filter((event) => event.type === "run_settled").length;
    await managed.manager.prompt({
      type: "prompt",
      requestId: "q",
      traceparent,
      sessionId: "pi-session-1",
      text: "ping",
    });
    await vi.waitFor(() =>
      expect(managed.received.filter((event) => event.type === "run_settled")).toHaveLength(settled + 1),
    );
  };
  return { ...managed, file, run };
}

/**
 * pi's record of a user message it took.
 *
 * @remarks
 * As in `failingTurn`.
 *
 * @sideEffects none
 * @param text - The message.
 * @param timestamp - When.
 * @returns The `message_end` record.
 */
function userEnd(text: string, timestamp: number): object {
  return { type: "message_end", message: { role: "user", content: [{ type: "text", text }], timestamp } };
}

/**
 * pi's record of a reply that ended.
 *
 * @remarks
 * As in `failingTurn`; `ended` says how.
 *
 * @sideEffects none
 * @param timestamp - When.
 * @param ended - `stopReason`, and `errorMessage` for a failure.
 * @returns The `message_end` record.
 */
function replyEnd(timestamp: number, ended: Record<string, unknown>): object {
  return {
    type: "message_end",
    message: { role: "assistant", content: [], usage: { input: 3, output: 0 }, timestamp, ...ended },
  };
}

/**
 * An extension's confirmation dialog, as pi asks it.
 *
 * @remarks
 * Its title is its id, so tests can tell dialogs apart.
 *
 * @sideEffects none
 * @param id - The dialog's id.
 * @returns The `extension_ui_request` record.
 */
function confirmation(id: string): object {
  return { type: "extension_ui_request", id, method: "confirm", title: id, message: "?" };
}

/** The one session's summary fields this suite looks at. */
const marks = (manager: Manager) =>
  manager.summaries().map(({ attention, asking, handedOff }) => ({ attention, asking, handedOff }));

describe("SessionManager attention (M1.9)", () => {
  it("marks a session whose run failed on credentials for sign-in, which a look does not clear, until its next run starts", async () => {
    const { manager, catalog, run, changes } = await opened([
      failingTurn("No API key found for anthropic. Use /login to sign in."),
      turn,
    ]);
    const before = Date.now();

    await run();
    const marked = marks(manager);
    await manager.clearAttention("pi-session-1");
    const looked = marks(manager);
    const changed = changes();
    await run();

    expect(marked).toStrictEqual([
      { attention: { reason: "auth", at: expect.any(Number), cleared: false }, asking: null, handedOff: false },
    ]);
    expect(marked[0]?.attention?.at).toBeGreaterThanOrEqual(before);
    expect(looked).toStrictEqual(marked);
    expect(marks(manager)).toStrictEqual([{ attention: null, asking: null, handedOff: false }]);
    expect(catalog.find("pi-session-1")?.attention).toBeNull();
    expect(changes()).toBeGreaterThan(changed);
  });

  it.each([
    "OAuth refresh failed for openai-codex",
    "401 Unauthorized",
    "Authentication failed",
    "invalid_api_key: Incorrect API key provided",
    "Invalid API Key",
    "Run `/login anthropic` to sign in again",
  ])("takes %s for a sign-in problem", async (error) => {
    const { manager, run } = await opened([failingTurn(error)]);

    await run();

    expect(marks(manager)[0]?.attention?.reason).toBe("auth");
  });

  it("marks any other failure as an error, which a look clears, kept in the index", async () => {
    const { manager, catalog, run } = await opened([failingTurn("overloaded")]);
    await run();
    const marked = marks(manager)[0]?.attention;

    expect(marked).toStrictEqual({ reason: "error", at: expect.any(Number), cleared: false });
    expect(await manager.clearAttention("pi-session-1")).toStrictEqual({});
    expect(marks(manager)[0]?.attention).toStrictEqual({ ...marked, cleared: true });
    expect(catalog.find("pi-session-1")?.attention).toStrictEqual({ ...marked, cleared: true });
  });

  it("does not mark a run that was stopped or completed, nor clear a session that needs no look", async () => {
    const { manager, run } = await opened([turn]);

    await run();
    await manager.clearAttention("pi-session-1");

    expect(marks(manager)).toStrictEqual([{ attention: null, asking: null, handedOff: false }]);
    await expect(manager.clearAttention("nope")).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "nope" }),
    );
  });

  it.each([
    ["completed", "stop", "done"],
    ["stopped", "aborted", "stopped"],
  ])("does not mark a run that %s after one of its turns failed", async (outcome, stopReason, last) => {
    const { manager, received } = await opened([
      [
        { type: "agent_start" },
        userEnd("ping", 1),
        replyEnd(2, { stopReason: "error", errorMessage: "overloaded" }),
        userEnd("again", 3),
        replyEnd(4, { stopReason }),
        { type: "agent_settled" },
      ],
    ]);

    await manager.prompt({ type: "prompt", requestId: "q", traceparent, sessionId: "pi-session-1", text: "ping" });
    await vi.waitFor(() => expect(received.map((event) => event.type)).toContain("run_settled"));

    expect(received.filter((event) => event.type === "turn_finished")).toMatchObject([
      { outcome: "failed" },
      { outcome: last },
    ]);
    expect(received.find((event) => event.type === "run_settled")).toMatchObject({ outcome });
    expect(marks(manager)).toStrictEqual([{ attention: null, asking: null, handedOff: false }]);
  });

  it("says since when a session waits for an answer, until it has none", async () => {
    const ask = { type: "extension_ui_request", id: "d1", method: "select", title: "Pick", options: ["a", "b"] };
    const { manager, received } = await opened([[{ type: "agent_start" }, ask]]);
    const before = Date.now();
    await manager.prompt({ type: "prompt", requestId: "q", traceparent, sessionId: "pi-session-1", text: "ping" });
    await vi.waitFor(() => expect(manager.summaries()[0]?.asking).not.toBeNull());
    const asking = marks(manager);

    await manager.answerInteraction("pi-session-1", "d1", { value: "a" });

    expect(asking).toStrictEqual([{ attention: null, asking: expect.any(Number), handedOff: false }]);
    expect(asking[0]?.asking).toBeGreaterThanOrEqual(before);
    expect(received.at(-1)).toMatchObject({ type: "control_updated", control: { interactions: [] } });
    expect(marks(manager)).toStrictEqual([{ attention: null, asking: null, handedOff: false }]);
  });

  it("says since when the oldest dialog still unanswered waits, once an older one is answered", async () => {
    const { manager, received } = await opened([[{ type: "agent_start" }, confirmation("d1")]], {
      steer: { data: { disposition: "queued" }, events: [confirmation("d2")] },
    });
    await manager.prompt({ type: "prompt", requestId: "q", traceparent, sessionId: "pi-session-1", text: "ping" });
    await vi.waitFor(() => expect(manager.summaries()[0]?.asking).not.toBeNull());
    const first = present(manager.summaries()[0]?.asking, "the time the first dialog appeared");
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(first));
    const before = Date.now();
    await manager.steer({ type: "steer", requestId: "s", traceparent, sessionId: "pi-session-1", text: "and" });
    await vi.waitFor(() =>
      expect(received.findLast((event) => event.type === "control_updated")).toMatchObject({
        control: { interactions: [{ id: "d1" }, { id: "d2" }] },
      }),
    );
    const both = manager.summaries()[0]?.asking;

    await manager.answerInteraction("pi-session-1", "d1", { confirmed: true });

    expect(both).toBe(first);
    expect(manager.summaries()[0]?.asking).toBeGreaterThanOrEqual(before);
  });
});

/** Every command that starts or writes pi, for a session handed off. */
const writes = (manager: Manager) => [
  manager.prompt({ type: "prompt", requestId: "q", traceparent, sessionId: "pi-session-1", text: "ping" }),
  manager.steer({ type: "steer", requestId: "q", traceparent, sessionId: "pi-session-1", text: "ping" }),
  manager.resumeQueue("pi-session-1"),
  manager.retryRun("pi-session-1"),
  manager.renameSession("pi-session-1", "x"),
  manager.setModel("pi-session-1", { providerId: "p", modelId: "m" }),
  manager.setThinkingLevel("pi-session-1", "low"),
  manager.listCommands("pi-session-1"),
];

describe("SessionManager handing off (M1.9)", () => {
  it("records the hand-off, stops pi and answers its file; then opens it without pi and refuses to write it", async () => {
    const { manager, catalog, received, starts, file, at } = await opened([turn]);

    expect(await manager.handOff("pi-session-1")).toStrictEqual({ file });
    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({ type: "session_exited", reason: "requested" }));
    await manager.openSession("client-1", "pi-session-1");

    expect(marks(manager)).toStrictEqual([{ attention: null, asking: null, handedOff: true }]);
    expect(catalog.find("pi-session-1")?.handedOff).toBe(true);
    for (const refused of await Promise.allSettled(writes(manager))) {
      expect(refused).toStrictEqual({
        status: "rejected",
        reason: new CommandError("session_handed_off", { sessionId: "pi-session-1" }),
      });
    }
    expect(starts()).toHaveLength(1);

    // A host started again keeps the hand-off, and opens the session without pi too.
    await manager.close();
    const again = await manage({ argvToStderr: true, rules: SESSION_ONE }, at);
    await again.manager.openSession("client-1", "pi-session-1");
    expect(marks(again.manager)).toStrictEqual([{ attention: null, asking: null, handedOff: true }]);
    expect(again.starts()).toStrictEqual([]);
  });

  it("refuses to hand off a session busy, or one it does not know", async () => {
    const { manager } = await opened([[{ type: "agent_start" }]]);
    await manager.prompt({ type: "prompt", requestId: "q", traceparent, sessionId: "pi-session-1", text: "ping" });
    await vi.waitFor(() => expect(manager.summaries()[0]?.running).toBe(true));

    await expect(manager.handOff("pi-session-1")).rejects.toStrictEqual(new CommandError("session_busy"));
    await expect(manager.handOff("nope")).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "nope" }),
    );
    expect(marks(manager)).toStrictEqual([{ attention: null, asking: null, handedOff: false }]);
  });

  it("refuses to hand off a session with messages in the host's queue, which only Atrium would send", async () => {
    const { manager, received } = await opened([[{ type: "agent_start" }]], {
      abort: { data: {}, events: [{ type: "agent_settled" }] },
    });
    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "one" });
    await vi.waitFor(() => expect(manager.summaries()[0]?.running).toBe(true));
    await manager.prompt({ type: "prompt", requestId: "q2", traceparent, sessionId: "pi-session-1", text: "two" });
    await manager.stop("pi-session-1");
    await vi.waitFor(() => expect(received.map((event) => event.type)).toContain("run_settled"));

    await expect(manager.handOff("pi-session-1")).rejects.toStrictEqual(new CommandError("session_busy"));
    expect(manager.summaries()[0]?.running).toBe(false);
    expect(received.findLast((event) => event.type === "control_updated")).toMatchObject({
      control: { queue: [{ text: "two" }], paused: "stopped" },
    });
  });

  it("refuses to hand off a session while a message is on its way to pi", async () => {
    const { manager } = await opened([], { prompt: { silent: true } });
    const sending = manager
      .prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "one" })
      .catch(() => undefined);

    await expect(manager.handOff("pi-session-1")).rejects.toStrictEqual(new CommandError("session_busy"));
    await manager.close();
    await sending;
  });

  it("refuses to hand off a session pi said it started a run for, before the run begins", async () => {
    const { manager } = await opened([[]]);
    expect(
      await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "one" }),
    ).toMatchObject({ disposition: "started" });

    await expect(manager.handOff("pi-session-1")).rejects.toStrictEqual(new CommandError("session_busy"));
    expect(manager.summaries()[0]?.running).toBe(false);
    expect(marks(manager)).toStrictEqual([{ attention: null, asking: null, handedOff: false }]);
  });

  it("refuses to hand off a session while pi starts again after a crash", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog, subscriptions } = await manage(
      { rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, exitAfter: 1 } } },
      at,
    );
    await catalog.scan();
    await manager.openSession("client-1", "pi-session-1");
    await manager.subscribe("c1", ["pi-session-1"]);
    const meanwhile = whenRestarting(subscriptions, () =>
      manager.handOff("pi-session-1").catch((error: unknown) => error),
    );
    await manager.subscribe("c2", ["pi-session-1"]);

    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "bye" });

    expect(await meanwhile).toStrictEqual(new CommandError("session_busy"));
  });

  it("refuses to hand off a draft, which has no file for pi to go on with", async () => {
    const { manager } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createSession("client-1", WORKSPACE);

    await expect(manager.handOff(sessionId)).rejects.toStrictEqual(new CommandError("session_is_draft", { sessionId }));
    expect(marks(manager)).toStrictEqual([{ attention: null, asking: null, handedOff: false }]);
  });

  it("takes a session back: clears the mark and starts pi on its file in a new epoch", async () => {
    const { manager, received, starts, file, at } = await opened([turn]);
    await manager.handOff("pi-session-1");
    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({ type: "session_exited" }));

    expect(await manager.takeBack("pi-session-1")).toStrictEqual({});

    expect(marks(manager)).toStrictEqual([{ attention: null, asking: null, handedOff: false }]);
    expect(starts()).toStrictEqual([
      { argv: ["--mode", "rpc", "--session", file], cwd: at.workspace },
      { argv: ["--mode", "rpc", "--session", file], cwd: at.workspace },
    ]);
    expect(received.at(-1)).toMatchObject({ type: "session_snapshot", epoch: 2, exited: false });
  });

  it("takes a session back only once its hand-off has stopped pi, then starts pi again", async () => {
    // pi stays after its stdin closes, so the hand-off's stop takes its grace time.
    const { manager, received, starts } = await opened([turn], {}, { ignoreStdinEnd: true });

    const handing = manager.handOff("pi-session-1");
    const taking = manager.takeBack("pi-session-1");
    await handing;
    expect(await taking).toStrictEqual({});

    expect(marks(manager)).toStrictEqual([{ attention: null, asking: null, handedOff: false }]);
    expect(starts()).toHaveLength(2);
    expect(received.at(-1)).toMatchObject({ type: "session_snapshot", epoch: 2, exited: false });
  });
});

/** pi's answers that give the session a model and take its name. */
const NAMEABLE = {
  get_state: { data: { sessionId: "pi-session-1", model: HAIKU, thinkingLevel: "low" } },
  set_session_name: { data: {} },
};

/**
 * A one-shot pi's reply in json mode.
 *
 * @remarks
 * See `runOneShot` in `packages/pi`.
 *
 * @sideEffects none
 * @param text - The reply's text.
 * @returns The `message_end` record.
 */
function titleReply(text: string): object {
  return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } };
}

/**
 * A watched session on file whose pi answers one-shot calls with `title`, held until released.
 *
 * @remarks
 * The one-shot pi writes what it was started with to `seen.json` and waits for `release.flag`.
 *
 * @sideEffects Writes the session's file; starts its pi.
 * @param title - The model's answer.
 * @param rules - More of pi's answers.
 * @returns The manager, what tests look at, what the one-shot pi saw and how to release it.
 */
async function titled(title: string, rules: Record<string, object> = NAMEABLE) {
  const gates = await createTempDir("titles");
  cleanups.push(gates.cleanup);
  const seenAt = join(gates.path, "seen.json");
  const gate = join(gates.path, "release.flag");
  const managed = await opened([turn], rules, {
    receivedToStderr: true,
    print: { lines: [titleReply(title)], recordTo: seenAt, waitFor: gate },
  });
  return {
    ...managed,
    /** What the one-shot pi was started with, once it runs. */
    seen: () => vi.waitFor(async () => JSON.parse(await readFile(seenAt, "utf8")) as Record<string, unknown>),
    /** Whether a one-shot pi was started. */
    asked: () =>
      readFile(seenAt).then(
        () => true,
        () => false,
      ),
    /** Lets the one-shot pi answer. */
    release: () => writeFile(gate, ""),
    /** The names pi was told to take. */
    names: () =>
      managed.piReceived().flatMap((command) => (command["type"] === "set_session_name" ? [command["name"]] : [])),
  };
}

describe("SessionManager titles (M1.9)", () => {
  it("names a session once its run ends: asks a one-shot pi in its directory on its model, and writes the title through its pi", async () => {
    const { run, seen, release, names, resources, at, records } = await titled("“修复 ping”。");

    await run();
    const asked = await seen();
    await release();
    await vi.waitFor(() => expect(names()).toStrictEqual(["修复 ping"]));
    await vi.waitFor(() => expect(resources.snapshot()["pi-oneshot"]).toBe(0));

    expect(asked).toMatchObject({
      argv: expect.arrayContaining(["-p", "--no-session", "--model", "anthropic/haiku"]),
      cwd: at.workspace,
      stdin: "User:\nping\n\nAssistant:\npong",
    });
    expect(records.filter((record) => record["msg"] === "session title not made")).toStrictEqual([]);
  });

  it("asks for no title for a session pi reports no model for", async () => {
    const plain = await titled("Ping", { set_session_name: { data: {} } });
    await plain.run();
    await plain.manager.close();

    expect(await plain.asked()).toBe(false);
  });

  it("asks for no title for a session that has a name", async () => {
    const { run, asked, manager, file, catalog } = await titled("Ping");
    await appendFile(
      file,
      `${JSON.stringify({ type: "session_info", id: "i1", parentId: null, timestamp: "", name: "Mine" })}\n`,
    );
    await catalog.scan();

    await run();
    await manager.close();

    expect(await asked()).toBe(false);
  });

  it.each([
    [
      "the session got a name meanwhile",
      async (file: string, managed: Awaited<ReturnType<typeof titled>>) => {
        await appendFile(
          file,
          `${JSON.stringify({ type: "session_info", id: "i1", parentId: null, timestamp: "", name: "Mine" })}\n`,
        );
        await managed.catalog.scan();
      },
    ],
    [
      "it was handed off meanwhile",
      async (_: string, managed: Awaited<ReturnType<typeof titled>>) => managed.manager.handOff("pi-session-1"),
    ],
  ])("discards the title when %s", async (_, act) => {
    const managed = await titled("Ping");
    await managed.run();
    await managed.seen();

    await act(managed.file, managed);
    await managed.release();
    await vi.waitFor(() =>
      expect(managed.records.filter((record) => record["msg"] === "session title not made")).toMatchObject([
        { sessionId: "pi-session-1", reason: "discarded" },
      ]),
    );

    expect(managed.names()).toStrictEqual([]);
  });

  it("discards the title when the session was renamed meanwhile, though its file does not show the name yet", async () => {
    // The scripted pi takes the name without writing it, as if the scan had not seen it yet.
    const managed = await titled("Ping");
    await managed.run();
    await managed.seen();

    await managed.manager.renameSession("pi-session-1", "Mine");
    await managed.release();
    await vi.waitFor(() =>
      expect(managed.records.filter((record) => record["msg"] === "session title not made")).toMatchObject([
        { sessionId: "pi-session-1", reason: "discarded" },
      ]),
    );

    expect(managed.names()).toStrictEqual(["Mine"]);
  });

  it("stops a one-shot pi under way when it closes", async () => {
    const { run, seen, manager, resources } = await titled("Ping");
    await run();
    await seen();

    await manager.close();

    expect(resources.snapshot()["pi-oneshot"]).toBe(0);
  });
});

describe("SessionManager after pi is updated (M1.10)", () => {
  it("stops the pi of idle sessions, and starts it again when the session is next opened", async () => {
    const { manager, received, starts, run } = await opened([turn]);
    await run();

    await manager.stopIdle();
    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({ type: "session_exited", reason: "requested" }));
    await manager.stopIdle();
    await manager.openSession("client-1", "pi-session-1");

    expect(starts()).toHaveLength(2);
    expect(received.filter((event) => event.type === "session_exited")).toHaveLength(1);
    expect(manager.summaries()).toMatchObject([{ sessionId: "pi-session-1", running: false }]);
  });

  it("leaves running sessions alone", async () => {
    const { manager, received, starts } = await opened([[{ type: "agent_start" }]]);
    await manager.prompt({ type: "prompt", requestId: "q", traceparent, sessionId: "pi-session-1", text: "ping" });
    await vi.waitFor(() => expect(manager.summaries()[0]?.running).toBe(true));

    await manager.stopIdle();

    expect(received.map((event) => event.type)).not.toContain("session_exited");
    expect(manager.summaries()[0]?.running).toBe(true);
    expect(starts()).toHaveLength(1);
  });
});
