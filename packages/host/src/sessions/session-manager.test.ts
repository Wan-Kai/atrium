import { type SessionsLocation, createSessionFileReader, sessionFolder } from "@atrium/pi";
import {
  CommandError,
  type ForkSessionCommand,
  IDLE_CONTROL,
  type SessionEvent,
  type SessionModel,
  UNKNOWN_METRICS,
} from "@atrium/protocol";
import { type ScriptedPiBehavior, createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { appendFile, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { PONG_ENTRIES as getEntries, PONG_TURN as turn } from "../../test/scripted-chat";
import { systemClock } from "../platform/clock";
import { loadIndexFile } from "../store/index-file";
import { type ChatRecords, createChatRecords } from "../store/chat-records";
import { CHATS_FILE, layoutsFile, SESSIONS_FILE } from "../store/index-schema";
import { SubscriptionRegistry } from "../sync/subscriptions";
import { createLayouts } from "./layouts";
import { createSessionCatalog } from "./session-catalog";
import { type TurnStarts, loadTurnStarts } from "../store/turn-starts";
import { type SessionTools, createSessionManager } from "./session-manager";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const WORKSPACE = "wks_000000000000000a";

/** The chat the first `createChat` of a test makes: its directory is the first new id. */
const CHAT = "cht_id1";

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
 * Tools as detection reports them, with a scripted pi that keeps sessions where the test looks.
 *
 * @remarks
 * Each call writes its own pi, so two behaviors can share one home.
 *
 * @sideEffects Writes the scripted pi to a temporary directory.
 * @param at - The directories.
 * @param behavior - The pi's behavior.
 * @returns The tools.
 */
async function scriptedTools(
  at: Awaited<ReturnType<typeof place>>,
  behavior: ScriptedPiBehavior,
): Promise<SessionTools> {
  const own = await createTempDir("scripted");
  cleanups.push(own.cleanup);
  const scripted = await writeScriptedPi(own.path, behavior);
  return {
    env: { PATH: process.env["PATH"] ?? "", PI_CODING_AGENT_SESSION_DIR: at.piSessions, ...scripted.env },
    pi: { status: "ready", piPath: scripted.piPath, version: [1, 0, 2] },
  };
}

/**
 * A new session, once its pi has started.
 *
 * @remarks
 * Opened as the UI opens a session it shows, which waits for the start under way.
 *
 * @sideEffects Opens the session for `client-1`.
 * @param manager - The manager.
 * @param created - The creation.
 * @returns What the creation answered.
 */
async function started(manager: Manager, created: Promise<{ sessionId: string }>): Promise<{ sessionId: string }> {
  const answer = await created;
  await manager.openSession("client-1", answer.sessionId);
  return answer;
}

/**
 * A manager over real index files, catalog and layouts, with a scripted pi.
 *
 * @remarks
 * `tools` is a scripted pi's behavior, tools as detection would report them, or how to ask for
 * them each time. The workspace service is a stand-in that knows one workspace and records
 * refreshes.
 *
 * @sideEffects Creates files; starts nothing until a command.
 * @param tools - The pi.
 * @param where - The directories, to share between managers.
 * @param turnStarts - Where turn starts are read from, if not the default.
 * @param location - Where pi keeps sessions, when a test holds back the first scan.
 * @param models - The model new sessions start with and where choices go, if a test needs them.
 * @param files - The file search behind `@`, if a test needs it.
 * @param titleModel - The title model pi can use in a directory, if a test needs one.
 * @param fast - Fast's extension and the Fast of sessions without their own, if a test needs them.
 * @param chats - The chats' records, if a test needs them to fail; else over `chats.json`.
 * @returns The manager and what tests look at.
 */
async function manage(
  tools: ScriptedPiBehavior | SessionTools | null | (() => Promise<SessionTools | null>),
  where?: Awaited<ReturnType<typeof place>>,
  turnStarts?: (sessionId: string) => Promise<TurnStarts>,
  location?: Promise<SessionsLocation | null>,
  models?: Parameters<typeof createSessionManager>[0]["models"],
  files?: Parameters<typeof createSessionManager>[0]["files"],
  titleModel?: Parameters<typeof createSessionManager>[0]["titleModel"],
  fast?: Parameters<typeof createSessionManager>[0]["fast"],
  chats?: (records: ChatRecords) => ChatRecords,
  more: {
    readonly childWorktree?: Parameters<typeof createSessionManager>[0]["childWorktree"];
    readonly tempRoot?: string;
    /** Workspaces besides the test's one, as a new worktree adds them. */
    readonly workspaces?: { id: string; dir: string }[];
    /** How many session ids are taken already, so new ones do not meet a session on file. */
    readonly sessionsTaken?: number;
  } = {},
) {
  const at = where ?? (await place());
  const recording = recordingTracing();
  cleanups.push(recording.shutdown);
  let detected: () => Promise<SessionTools | null>;
  if (typeof tools === "function") {
    detected = tools;
  } else {
    const found = tools === null || "pi" in tools ? tools : await scriptedTools(at, tools);
    detected = () => Promise.resolve(found);
  }
  const subscriptions = new SubscriptionRegistry(recording.resources);
  const received: SessionEvent[] = [];
  subscriptions.connect("c1", (event) => received.push(event as SessionEvent), "client-1");
  const index = join(at.home, "index");
  const catalog = createSessionCatalog({
    file: (await loadIndexFile(index, SESSIONS_FILE, 0)).file,
    location: location ?? Promise.resolve({ directory: at.piSessions, perCwd: false }),
    chatsRoot: join(at.home, "chats"),
    workspaces: () => [{ id: WORKSPACE, dir: at.workspace }, ...(more.workspaces ?? [])],
    reader: createSessionFileReader(),
    clock: systemClock,
    logger: recording.logger,
  });
  const layouts = createLayouts({
    file: (await loadIndexFile(index, layoutsFile({ sessions: [] }), 0)).file,
    clock: systemClock,
  });
  const chatRecords = createChatRecords((await loadIndexFile(index, CHATS_FILE, 0)).file);
  const refreshed: string[] = [];
  let changes = 0;
  let next = 0;
  let sessionsMade = more.sessionsTaken ?? 0;
  const manager = createSessionManager({
    chatsRoot: join(at.home, "chats"),
    tools: detected,
    subscriptions,
    catalog,
    layouts,
    chats: chats === undefined ? chatRecords : chats(chatRecords),
    workspaces: {
      dirOf: (id) => (id === WORKSPACE ? at.workspace : more.workspaces?.find((other) => other.id === id)?.dir),
      refresh: (id) => refreshed.push(id),
    },
    onChange: () => (changes += 1),
    clock: systemClock,
    resources: recording.resources,
    tracer: recording.tracer,
    logger: recording.logger,
    newId: () => `id${++next}`,
    newSessionId: () => `pi-session-${++sessionsMade}`,
    ...(turnStarts === undefined ? {} : { turnStarts }),
    ...(models === undefined ? {} : { models }),
    ...(files === undefined ? {} : { files }),
    ...(titleModel === undefined ? {} : { titleModel }),
    ...(fast === undefined ? {} : { fast }),
    ...(more.childWorktree === undefined ? {} : { childWorktree: more.childWorktree }),
    ...(more.tempRoot === undefined ? {} : { tempRoot: more.tempRoot }),
  });
  cleanups.push(
    () => manager.close(),
    () => catalog.close(),
  );
  return {
    manager,
    catalog,
    layouts,
    chatRecords,
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

/**
 * What a command failed with, for a list of answers.
 *
 * @sideEffects none
 * @param error - The failure.
 * @returns It.
 */
function caught(error: unknown): unknown {
  return error;
}
describe("SessionManager creating sessions", () => {
  it("opens a new session's tab where it belongs but leaves the client where it went while pi started", async () => {
    const { manager, layouts } = await manage({ rules: SESSION_ONE });

    const creating = manager.createSession("client-1", WORKSPACE);
    await manager.selectContainer("client-1", CHAT);
    const { sessionId } = await creating;

    expect(layouts.of("client-1")).toStrictEqual({
      container: CHAT,
      tabs: { [WORKSPACE]: { open: [sessionId], active: sessionId } },
    });
  });

  it("opens a new session's tab without taking the client there when told not to go", async () => {
    const { manager, layouts } = await manage({ rules: SESSION_ONE });
    await manager.selectContainer("client-1", CHAT);

    const { sessionId } = await manager.createSession("client-1", WORKSPACE, false);

    expect(layouts.of("client-1")).toStrictEqual({
      container: CHAT,
      tabs: { [WORKSPACE]: { open: [sessionId], active: sessionId } },
    });
    const next = await manager.createSession("client-1", WORKSPACE);
    expect(layouts.of("client-1")).toStrictEqual({
      container: WORKSPACE,
      tabs: { [WORKSPACE]: { open: [sessionId, next.sessionId], active: next.sessionId } },
    });
  });

  it("creates a chat in its own directory, records and opens it before pi starts, then starts pi there with its id", async () => {
    const at = await place();
    const tools = Promise.withResolvers<SessionTools | null>();
    const { manager, catalog, layouts, starts, changes } = await manage(() => tools.promise, at);

    expect(await manager.createChat("client-1")).toStrictEqual({ sessionId: "pi-session-1" });

    const cwd = join(at.home, "chats", "id1");
    expect(catalog.find("pi-session-1")).toMatchObject({ containerId: CHAT, cwd, state: "draft" });
    expect(layouts.of("client-1")).toStrictEqual({
      container: CHAT,
      tabs: { [CHAT]: { open: ["pi-session-1"], active: "pi-session-1" } },
    });
    expect(changes()).toBeGreaterThan(0);
    tools.resolve(await scriptedTools(at, { argvToStderr: true, rules: SESSION_ONE }));
    await manager.openSession("client-1", "pi-session-1");
    expect(starts()).toStrictEqual([{ argv: ["--mode", "rpc", "--session-id", "pi-session-1"], cwd }]);
  });

  it("keeps each new session under the id it gave it, whatever pi reports", async () => {
    const { manager, received, resources } = await manage({ rules: SESSION_ONE });
    await started(manager, manager.createChat("client-1"));
    const { sessionId } = await started(manager, manager.createChat("client-1"));

    await manager.subscribe("c1", [sessionId]);

    expect(sessionId).toBe("pi-session-2");
    expect(received).toMatchObject([{ type: "session_snapshot", sessionId: "pi-session-2", epoch: 1 }]);
    expect(resources.snapshot()["pi-process"]).toBe(2);
  });

  it("turns pi's automatic retries on before reading the session, whatever pi's settings say", async () => {
    const { manager, sent } = await manage({ rules: SESSION_ONE });

    await started(manager, manager.createChat("client-1"));

    expect(sent()).toStrictEqual(["set_auto_retry", "get_state", "get_entries", "get_session_stats"]);
  });

  it("creates a session in a workspace's directory, and refuses an unknown workspace", async () => {
    const { manager, catalog, layouts, at, starts } = await manage({ argvToStderr: true, rules: SESSION_ONE });

    await started(manager, manager.createSession("client-1", WORKSPACE));

    expect(starts()).toStrictEqual([{ argv: ["--mode", "rpc", "--session-id", "pi-session-1"], cwd: at.workspace }]);
    expect(catalog.find("pi-session-1")).toMatchObject({ containerId: WORKSPACE, state: "draft" });
    expect(layouts.of("client-1").container).toBe(WORKSPACE);
    await expect(manager.createSession("client-1", "wks_ffffffffffffffff")).rejects.toStrictEqual(
      new CommandError("workspace_not_found", { workspaceId: "wks_ffffffffffffffff" }),
    );
  });

  it.each([
    ["detection did not finish", null, "unknown"],
    ["pi is missing", { env: {}, pi: { status: "missing" } } satisfies SessionTools, "missing"],
  ])("creates a chat when %s, logs its start failing, and says why when it is opened", async (_case, tools, status) => {
    const { manager, catalog, records } = await manage(tools);

    const { sessionId } = await manager.createChat("client-1");
    const opening = manager.openSession("client-1", sessionId);

    await expect(opening).rejects.toStrictEqual(new CommandError("pi_unavailable", { status }));
    expect(catalog.find(sessionId)?.state).toBe("draft");
    await vi.waitFor(() =>
      expect(records.filter((record) => record["msg"] === "session start failed")).toMatchObject([
        { level: "warn", err: { code: "pi_unavailable" } },
      ]),
    );
  });

  it("starts a new chat's pi again on its first message after its start failed", async () => {
    const at = await place();
    const tools = { current: null as SessionTools | null };
    const { manager, starts } = await manage(() => Promise.resolve(tools.current), at);
    const { sessionId } = await manager.createChat("client-1");
    await expect(manager.openSession("client-1", sessionId)).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "unknown" }),
    );

    tools.current = await scriptedTools(at, {
      argvToStderr: true,
      rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, events: turn } },
    });
    const answer = await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" });

    expect(answer).toStrictEqual({ disposition: "started" });
    expect(starts()).toStrictEqual([
      { argv: ["--mode", "rpc", "--session-id", sessionId], cwd: join(at.home, "chats", "id1") },
    ]);
  });

  it("fails the open of a new chat whose pi exits before reporting its session", async () => {
    const { manager } = await manage({ exitCode: 1 });
    const { sessionId } = await manager.createChat("client-1");

    await expect(manager.openSession("client-1", sessionId)).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
  });

  it("stops a pi that cannot report its session, instead of leaving it running", async () => {
    const { manager, resources } = await manage({ rules: { get_state: { fail: "not ready" } } });
    const { sessionId } = await manager.createChat("client-1");

    await expect(manager.openSession("client-1", sessionId)).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "unresponsive" }),
    );
    expect(resources.snapshot()["pi-process"]).toBe(0);
  });

  it("discards a new draft closed while its pi starts, stopping that pi", async () => {
    const at = await place();
    const tools = Promise.withResolvers<SessionTools | null>();
    const scanned = Promise.withResolvers<SessionsLocation | null>();
    const { manager, catalog, layouts, resources } = await manage(() => tools.promise, at, undefined, scanned.promise);
    const ready = await scriptedTools(at, { rules: SESSION_ONE });
    const { sessionId } = await manager.createChat("client-1");

    // The tab closes, and the draft is looked at again after the scan, while pi has not started.
    const closing = manager.closeTab("client-1", sessionId);
    await vi.waitFor(() => expect(layouts.isOpen(sessionId)).toBe(false));
    const looked = catalog.ready();
    scanned.resolve({ directory: at.piSessions, perCwd: false });
    await looked;
    tools.resolve(ready);
    await closing;

    expect(catalog.find(sessionId)).toBeUndefined();
    expect(await readdir(join(at.home, "chats"))).toStrictEqual([]);
    expect(resources.snapshot()["pi-process"]).toBe(0);
    expect(resources.snapshot()["session.controller"]).toBe(0);
  });

  it("keeps a new draft closed while its pi starts when a message comes meanwhile, and sends it", async () => {
    const at = await place();
    const tools = Promise.withResolvers<SessionTools | null>();
    const scanned = Promise.withResolvers<SessionsLocation | null>();
    const { manager, catalog, layouts, sent } = await manage(() => tools.promise, at, undefined, scanned.promise);
    const ready = await scriptedTools(at, {
      rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, events: turn } },
    });
    const { sessionId } = await manager.createChat("client-1");
    const closing = manager.closeTab("client-1", sessionId);
    await vi.waitFor(() => expect(layouts.isOpen(sessionId)).toBe(false));
    const looked = catalog.ready();
    scanned.resolve({ directory: at.piSessions, perCwd: false });
    await looked;
    // Once this scan ends, the discard has looked at the draft and waits for its pi to start.
    await catalog.scan();

    const sending = manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" });
    tools.resolve(ready);
    await closing;

    expect(await sending).toStrictEqual({ disposition: "started" });
    expect(catalog.find(sessionId)).toMatchObject({ containerId: CHAT });
    expect(await readdir(join(at.home, "chats"))).toStrictEqual(["id1"]);
    expect(sent().filter((command) => command === "prompt")).toStrictEqual(["prompt"]);
  });

  it("keeps a new draft closed while its pi starts when another client opens it meanwhile, starting its pi again", async () => {
    const at = await place();
    const tools = Promise.withResolvers<SessionTools | null>();
    const scanned = Promise.withResolvers<SessionsLocation | null>();
    const { manager, catalog, layouts, resources } = await manage(() => tools.promise, at, undefined, scanned.promise);
    const ready = await scriptedTools(at, { rules: SESSION_ONE });
    const { sessionId } = await manager.createChat("client-1");
    const closing = manager.closeTab("client-1", sessionId);
    await vi.waitFor(() => expect(layouts.isOpen(sessionId)).toBe(false));
    const looked = catalog.ready();
    scanned.resolve({ directory: at.piSessions, perCwd: false });
    await looked;
    // Once this scan ends, the discard has looked at the draft and waits for its pi to start.
    await catalog.scan();

    const opening = manager.openSession("client-2", sessionId);
    tools.resolve(ready);
    await closing;
    await opening;

    expect(catalog.find(sessionId)).toMatchObject({ containerId: CHAT, state: "draft" });
    expect(layouts.of("client-2")).toStrictEqual({
      container: CHAT,
      tabs: { [CHAT]: { open: [sessionId], active: sessionId } },
    });
    expect(await readdir(join(at.home, "chats"))).toStrictEqual(["id1"]);
    expect(resources.snapshot()["pi-process"]).toBe(1);
  });

  it("keeps a new chat's directory and draft when its tab cannot be written", async () => {
    const { manager, catalog, at } = await manage({ rules: SESSION_ONE });
    // A directory where the layouts file goes, so writing it fails.
    const file = join(at.home, "index", "layouts.json");
    await rm(file, { force: true });
    await mkdir(join(file, "taken"), { recursive: true });

    await expect(manager.createChat("client-1")).rejects.toMatchObject({ code: "EISDIR" });

    expect(await readdir(join(at.home, "chats"))).toStrictEqual(["id1"]);
    expect(catalog.find("pi-session-1")).toMatchObject({
      containerId: CHAT,
      state: "draft",
      cwd: join(at.home, "chats", "id1"),
    });
  });
});

describe("SessionManager running sessions", () => {
  it("sends a subscriber the snapshot, then the session's events as pi works, and tracks the run", async () => {
    const { manager, received, records, refreshed, changes } = await manage({
      rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, events: turn } },
    });
    const { sessionId } = await started(manager, manager.createSession("client-1", WORKSPACE));
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
    const { sessionId } = await started(manager, manager.createChat("client-1"));
    await manager.subscribe("c1", [sessionId]);

    await manager.close();
    await vi.waitFor(() => expect(received.at(-1)?.type).toBe("session_exited"));

    expect(received.at(-1)).toMatchObject({ reason: "requested", code: 0 });
  });

  it("stops the pi of a chat created after the manager closed before asking it anything", async () => {
    const { manager, resources, sent } = await manage({ rules: SESSION_ONE });

    await manager.close();
    await manager.createChat("client-1");
    // Waits for the starts under way.
    await manager.stopIdle();

    expect(sent()).toStrictEqual([]);
    expect(resources.snapshot()["pi-process"]).toBe(0);
  });

  it("keeps no controller for a session whose pi came up as the manager closed", async () => {
    const read = Promise.withResolvers<TurnStarts>();
    const asked = Promise.withResolvers<void>();
    const { manager, resources } = await manage({ rules: SESSION_ONE }, undefined, () => {
      asked.resolve();
      return read.promise;
    });
    await manager.createChat("client-1");
    await asked.promise;

    const closing = manager.close();
    read.resolve({ opened: new Set(), auto: new Set(), record: () => Promise.resolve() });
    await closing;

    // None was ever kept.
    expect(resources.snapshot()["session.controller"]).toBeUndefined();
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
        fast: false,
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

describe("SessionManager sessions in a chat", () => {
  it("creates another session in a chat's directory, as a tab beside its first", async () => {
    const { manager, catalog, layouts, at } = await manage({ rules: SESSION_ONE });
    const first = await manager.createChat("client-1");

    const second = await manager.createSession("client-1", CHAT);

    const cwd = join(at.home, "chats", "id1");
    expect(catalog.find(second.sessionId)).toMatchObject({ containerId: CHAT, cwd, state: "draft" });
    expect(layouts.of("client-1")).toStrictEqual({
      container: CHAT,
      tabs: { [CHAT]: { open: [first.sessionId, second.sessionId], active: second.sessionId } },
    });
    expect(await readdir(join(at.home, "chats"))).toStrictEqual(["id1"]);
  });

  it("refuses a session in a chat that is not there, recording and opening nothing", async () => {
    const { manager, catalog, layouts } = await manage({ rules: SESSION_ONE });

    await expect(manager.createSession("client-1", "cht_gone")).rejects.toStrictEqual(
      new CommandError("chat_not_found", { chatId: "cht_gone" }),
    );
    expect(catalog.list()).toStrictEqual([]);
    expect(layouts.of("client-1")).toStrictEqual({ container: null, tabs: {} });
  });

  it("keeps a chat's directory when an empty draft goes while another session is in the chat", async () => {
    const { manager, catalog, at } = await manage({ rules: SESSION_ONE });
    const first = await manager.createChat("client-1");
    const second = await manager.createSession("client-1", CHAT);

    await manager.closeTab("client-1", second.sessionId);

    expect(catalog.find(second.sessionId)).toBeUndefined();
    expect(catalog.find(first.sessionId)).toMatchObject({ containerId: CHAT });
    expect(await readdir(join(at.home, "chats"))).toStrictEqual(["id1"]);
    expect(catalog.chats().map((chat) => chat.id)).toStrictEqual([CHAT]);
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
    // Neither client stays in the chat gone.
    expect([layouts.of("client-1"), layouts.of("client-2")]).toStrictEqual([
      { container: null, tabs: {} },
      { container: null, tabs: {} },
    ]);
    expect(await readdir(join(at.home, "chats"))).toStrictEqual([]);
    // The chat goes with its directory.
    await vi.waitFor(() => expect(catalog.chats()).toStrictEqual([]));
    await vi.waitFor(() => expect(resources.snapshot()["pi-process"]).toBe(0));
    await expect(manager.subscribe("c1", [sessionId])).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId }),
    );
  });

  it("keeps a session that got a message when its tab closes, though its file is not found yet", async () => {
    const { manager, catalog, at, received, refreshed } = await manage({
      rules: { ...SESSION_ONE, prompt: { data: { disposition: "started" }, events: turn } },
    });
    const chat = await manager.createChat("client-1");
    await manager.subscribe("c1", [chat.sessionId]);
    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: chat.sessionId, text: "ping" });
    await vi.waitFor(() => expect(received.map((event) => event.type)).toContain("run_settled"));

    await manager.closeTab("client-1", chat.sessionId);

    expect(catalog.find(chat.sessionId)).toMatchObject({ state: "draft" });
    expect(await readdir(join(at.home, "chats"))).toStrictEqual(["id1"]);
    // A chat has no git to look at after a run.
    expect(refreshed).toStrictEqual([]);
  });

  it("keeps a chat directory that holds files when its empty draft is discarded", async () => {
    const { manager, layouts, at } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createChat("client-1");
    await writeFile(join(at.home, "chats", "id1", "notes.md"), "kept");

    await manager.closeTab("client-1", sessionId);

    expect(await readdir(join(at.home, "chats", "id1"))).toStrictEqual(["notes.md"]);
    // The chat is still there, and so is the client.
    expect(layouts.of("client-1")).toStrictEqual({ container: CHAT, tabs: { [CHAT]: { open: [], active: null } } });
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

    // The draft was the chat's only session, so the chat went with it.
    expect(layouts.of("client-1")).toStrictEqual({ container: null, tabs: {} });
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
    await manager.selectContainer("client-1", CHAT);

    expect(layouts.of("client-1")).toStrictEqual({
      container: CHAT,
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
    const selecting = manager.selectContainer("client-1", CHAT);
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
    const selecting = manager.selectContainer("client-1", CHAT);
    scanned.resolve({ directory: at.piSessions, perCwd: false });

    await expect(opening).rejects.toStrictEqual(new CommandError("session_not_found", { sessionId: "nope" }));
    await selecting;

    expect(layouts.of("client-1")).toStrictEqual({ container: CHAT, tabs: {} });
  });

  it("goes to a container or nowhere, and closes a tab it does not have without complaint", async () => {
    const { manager, layouts, changes } = await manage(null);

    await manager.selectContainer("client-1", CHAT);
    expect(layouts.of("client-1").container).toBe(CHAT);
    await manager.closeTab("client-1", "nope");
    await manager.selectContainer("client-1", null);

    expect(layouts.of("client-1").container).toBeNull();
    expect(changes()).toBe(3);
  });
});

describe("SessionManager archiving and renaming", () => {
  it("archives a session: stops its pi, closes its tabs everywhere and lets go of its controller", async () => {
    const { manager, catalog, layouts, received, resources } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await started(manager, manager.createSession("client-1", WORKSPACE));
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

  it("starts no pi for a session archived: a message, an insert, an open or a command finds no session", async () => {
    const { manager, resources } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await started(manager, manager.createSession("client-1", WORKSPACE));
    await manager.archiveSession(sessionId);
    const notFound = new CommandError("session_not_found", { sessionId });

    const answers = await Promise.all([
      manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" }).catch(caught),
      manager.steer({ type: "steer", requestId: "q2", traceparent, sessionId, text: "and" }).catch(caught),
      manager.openSession("client-1", sessionId).catch(caught),
      manager.listCommands(sessionId).catch(caught),
    ]);

    expect([answers, resources.snapshot()["pi-process"]]).toStrictEqual([[notFound, notFound, notFound, notFound], 0]);
  });

  it("finds no session for a message or an insert sent while it is being archived", async () => {
    const { manager, catalog, sent } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await started(manager, manager.createSession("client-1", WORKSPACE));

    const archiving = manager.archiveSession(sessionId);
    const answers = await Promise.all([
      manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" }).catch(caught),
      manager.steer({ type: "steer", requestId: "q2", traceparent, sessionId, text: "and" }).catch(caught),
    ]);
    await archiving;

    const notFound = new CommandError("session_not_found", { sessionId });
    expect([
      answers,
      sent().filter((type) => ["prompt", "steer"].some((asked) => asked === type)),
      catalog.find(sessionId)?.archived,
    ]).toStrictEqual([[notFound, notFound], [], true]);
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

describe("SessionManager chats' archive", () => {
  it("archives a chat with its sessions, drafts too: records them and its first session, stops their pi and drops the chat from layouts", async () => {
    const { manager, catalog, layouts, chatRecords, resources, changes } = await manage({ rules: SESSION_ONE });
    const { sessionId: elsewhere } = await started(manager, manager.createSession("client-1", WORKSPACE));
    const { sessionId: first } = await started(manager, manager.createChat("client-1"));
    const { sessionId: gone } = await manager.createSession("client-1", CHAT);
    await manager.archiveSession(gone);
    const { sessionId: draft } = await manager.createSession("client-1", CHAT);
    await manager.subscribe("c1", [elsewhere, first]);
    const before = changes();
    const from = Date.now();

    expect(await manager.archiveChat(CHAT)).toStrictEqual({});

    const archive = present(chatRecords.archived(CHAT), CHAT);
    expect(archive).toStrictEqual({ at: archive.at, sessions: [first, draft], first });
    expect(archive.at).toBeGreaterThanOrEqual(from);
    expect(archive.at).toBeLessThanOrEqual(Date.now());
    const archived = (sessionId: string) => present(catalog.find(sessionId), sessionId).archived;
    expect([first, draft, gone, elsewhere].map(archived)).toStrictEqual([true, true, true, false]);
    expect(layouts.of("client-1")).toStrictEqual({
      container: null,
      tabs: { [WORKSPACE]: { open: [elsewhere], active: elsewhere } },
    });
    expect(resources.snapshot()["session.controller"]).toBe(1);
    expect(changes()).toBe(before + 1);
  });

  it("changes nothing archiving a chat archived already, and finds no chat that is not there", async () => {
    const { manager, chatRecords, changes } = await manage({ rules: SESSION_ONE });
    await manager.createChat("client-1");
    await manager.archiveChat(CHAT);
    const archive = chatRecords.archived(CHAT);
    const before = changes();

    expect(await manager.archiveChat(CHAT)).toStrictEqual({});

    expect([chatRecords.archived(CHAT), changes()]).toStrictEqual([archive, before]);
    await expect(manager.archiveChat("cht_none")).rejects.toStrictEqual(
      new CommandError("chat_not_found", { chatId: "cht_none" }),
    );
    await expect(manager.restoreChat("cht_none")).rejects.toStrictEqual(
      new CommandError("chat_not_found", { chatId: "cht_none" }),
    );
  });

  it("records the archive before its sessions: when it cannot be written, no session is archived", async () => {
    const { manager, catalog } = await manage(
      { rules: SESSION_ONE },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (records) => ({
        ...records,
        setArchived: () => Promise.reject(new Error("disk full")),
      }),
    );
    const { sessionId } = await manager.createChat("client-1");

    await expect(manager.archiveChat(CHAT)).rejects.toThrow("disk full");

    expect(present(catalog.find(sessionId), sessionId).archived).toBe(false);
  });

  it("restores the sessions archived with a chat, not one archived before, and goes nowhere", async () => {
    const { manager, catalog, layouts, chatRecords, changes } = await manage({ rules: SESSION_ONE });
    const { sessionId: first } = await manager.createChat("client-1");
    const { sessionId: gone } = await manager.createSession("client-1", CHAT);
    await manager.archiveSession(gone);
    const { sessionId: draft } = await manager.createSession("client-1", CHAT);
    await manager.archiveChat(CHAT);
    const layout = layouts.of("client-1");
    const before = changes();

    expect(await manager.restoreChat(CHAT)).toStrictEqual({});

    const archived = (sessionId: string) => present(catalog.find(sessionId), sessionId).archived;
    expect([first, draft, gone].map(archived)).toStrictEqual([false, false, true]);
    expect(chatRecords.archived(CHAT)).toBeNull();
    expect(layouts.of("client-1")).toStrictEqual(layout);
    expect(changes()).toBe(before + 1);
    expect(await manager.restoreChat(CHAT)).toStrictEqual({});
    expect(changes()).toBe(before + 1);
  });

  it("finds no session for a message sent while its chat is being archived, and creates none in it", async () => {
    const entered = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    const { manager, resources } = await manage(
      { rules: SESSION_ONE },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (records) => ({
        ...records,
        setArchived: async (chatId, archive) => {
          entered.resolve();
          await writing.promise;
          return records.setArchived(chatId, archive);
        },
      }),
    );
    const { sessionId } = await started(manager, manager.createChat("client-1"));

    const archiving = manager.archiveChat(CHAT);
    await entered.promise;
    const answers = await Promise.all([
      manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId, text: "ping" }).catch(caught),
      manager.createSession("client-1", CHAT).catch(caught),
    ]);
    writing.resolve();
    await archiving;

    expect([answers, resources.snapshot()["pi-process"]]).toStrictEqual([
      [new CommandError("session_not_found", { sessionId }), new CommandError("chat_not_found", { chatId: CHAT })],
      0,
    ]);
  });

  it("archives and restores a chat in the order asked, even while its archive still writes", async () => {
    const writing = Promise.withResolvers<void>();
    // Only the archive's write waits.
    const waits: Promise<void>[] = [writing.promise];
    const { manager, catalog, chatRecords } = await manage(
      { rules: SESSION_ONE },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (records) => ({
        ...records,
        setArchived: async (chatId, archive) => {
          await waits.shift();
          return records.setArchived(chatId, archive);
        },
      }),
    );
    const { sessionId } = await manager.createChat("client-1");

    const archiving = manager.archiveChat(CHAT);
    const restoring = manager.restoreChat(CHAT);
    writing.resolve();
    await Promise.all([archiving, restoring]);

    expect([chatRecords.archived(CHAT), catalog.find(sessionId)?.archived]).toStrictEqual([null, false]);
  });

  it("starts no session in an archived chat", async () => {
    const { manager } = await manage({ rules: SESSION_ONE });
    await manager.createChat("client-1");
    await manager.archiveChat(CHAT);

    await expect(manager.createSession("client-1", CHAT)).rejects.toStrictEqual(
      new CommandError("chat_not_found", { chatId: CHAT }),
    );
  });
});

describe("SessionManager workspaces", () => {
  it("stops the sessions of workspaces that went away, lets go of their controllers and drops them from layouts", async () => {
    const { manager, layouts, received, resources } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await started(manager, manager.createSession("client-1", WORKSPACE));
    await manager.subscribe("c1", [sessionId]);
    expect(resources.snapshot()["session.controller"]).toBe(1);

    await manager.forgetWorkspaces([WORKSPACE]);

    expect(layouts.of("client-1")).toStrictEqual({ container: null, tabs: {} });
    expect(resources.snapshot()["session.controller"]).toBe(0);
    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({ type: "session_exited" }));
  });

  it("archives every session of a workspace, drafts too: stops their pi, keeps no controller and drops the workspace from layouts", async () => {
    const { manager, catalog, layouts, resources, changes } = await manage({ rules: SESSION_ONE });
    const { sessionId: chat } = await started(manager, manager.createChat("client-1"));
    const { sessionId: running } = await started(manager, manager.createSession("client-1", WORKSPACE));
    const { sessionId: other } = await manager.createSession("client-1", WORKSPACE);
    await manager.subscribe("c1", [running, chat]);
    const before = changes();

    await manager.archiveWorkspace(WORKSPACE);

    const entry = (sessionId: string) => present(catalog.find(sessionId), sessionId);
    expect([running, other, chat].map((sessionId) => entry(sessionId).archived)).toStrictEqual([true, true, false]);
    expect(layouts.of("client-1")).toStrictEqual({
      container: null,
      tabs: { [entry(chat).containerId]: { open: [chat], active: chat } },
    });
    expect(resources.snapshot()["session.controller"]).toBe(1);
    expect(changes()).toBe(before + 1);
  });

  it("stops the pi of every session of a workspace, archiving nothing and keeping layouts", async () => {
    const { manager, catalog, layouts, resources } = await manage({ rules: SESSION_ONE });
    const { sessionId: chat } = await started(manager, manager.createChat("client-1"));
    const { sessionId } = await started(manager, manager.createSession("client-1", WORKSPACE));
    const layout = layouts.of("client-1");

    await manager.stopWorkspace(WORKSPACE);

    expect([sessionId, chat].map((id) => present(catalog.find(id), id).archived)).toStrictEqual([false, false]);
    expect(layouts.of("client-1")).toStrictEqual(layout);
    expect(resources.snapshot()["pi-process"]).toBe(1);
  });

  it("keeps a workspace's sessions from starting, and new ones from being created, from its stop until released", async () => {
    const { manager, catalog, resources } = await manage({ rules: SESSION_ONE });
    const { sessionId: running } = await started(manager, manager.createSession("client-1", WORKSPACE));
    const { sessionId: gone } = await manager.createSession("client-1", WORKSPACE);
    await manager.archiveSession(gone);
    const { sessionId: draft } = await manager.createSession("client-1", WORKSPACE);
    const stopped = await manager.stopWorkspace(WORKSPACE);
    const answers = await Promise.all([
      manager.openSession("client-1", running).catch(caught),
      manager.createSession("client-1", WORKSPACE).catch(caught),
    ]);
    manager.releaseWorkspace(WORKSPACE);

    expect([stopped, answers]).toStrictEqual([
      [running, draft],
      [
        new CommandError("session_not_found", { sessionId: running }),
        new CommandError("workspace_not_found", { workspaceId: WORKSPACE }),
      ],
    ]);
    expect(await manager.openSession("client-1", running)).toStrictEqual({});
    expect([catalog.find(running)?.archived, resources.snapshot()["pi-process"]]).toStrictEqual([false, 1]);
  });

  it("restores the sessions given, or all archived in the workspace", async () => {
    const { manager, catalog, changes } = await manage({ rules: SESSION_ONE });
    const ids: string[] = [];
    for (const _ of [1, 2, 3]) ids.push((await manager.createSession("client-1", WORKSPACE)).sessionId);
    const { sessionId: chat } = await manager.createChat("client-1");
    for (const sessionId of [...ids, chat]) await manager.archiveSession(sessionId);
    const archived = () => [...ids, chat].map((sessionId) => catalog.find(sessionId)?.archived);
    const before = changes();

    await manager.restoreWorkspace(WORKSPACE, [present(ids[1], "the second")]);
    const some = archived();
    await manager.restoreWorkspace(WORKSPACE, null);

    expect([some, archived(), changes()]).toStrictEqual([
      [true, false, true, true],
      [false, false, false, true],
      before + 2,
    ]);
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
        parent: null,
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

    const { sessionId } = await started(manager, manager.createChat("client-1"));

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

    expect(catalog.find(sessionId)).toMatchObject({ containerId: CHAT });
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

    await started(manager, manager.createChat("client-1"));

    expect(sent()).toStrictEqual(["set_auto_retry", "set_model", "get_state", "get_entries", "get_session_stats"]);
  });

  it("leaves pi's own model when none was chosen yet", async () => {
    const { models } = remembering(null);
    const { manager, sent } = await manage({ rules: SESSION_ONE }, undefined, undefined, undefined, models);

    await started(manager, manager.createChat("client-1"));

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

    expect(await started(manager, manager.createChat("client-1"))).toStrictEqual({ sessionId: "pi-session-1" });

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

/** Where the tests' Fast extension is said to be; the scripted pi only reports the path. */
const FAST_EXTENSION = "/Applications/Atrium.app/atrium-extension.mjs";

/** pi answering a session's commands, Atrium's Fast switch among them, and Fast switches, which it handles without a run. */
const FAST_PI = {
  ...SESSION_ONE,
  get_commands: {
    data: {
      commands: [
        { name: "review", description: "Reviews", source: "prompt", sourceInfo: {} },
        { name: "atrium-fast", description: "Atrium's Fast switch", source: "extension", sourceInfo: {} },
      ],
    },
  },
  prompt: { data: { disposition: "handled" } },
};

/** The Fast switches a manager reported, and the Fast sessions without their own start with. */
function fastMemory(initial: boolean) {
  const chosen: boolean[] = [];
  let last = initial;
  return {
    chosen,
    /** Remembers another Fast, as a switch in another session would. */
    prefer: (next: boolean) => {
      last = next;
    },
    fast: { extension: FAST_EXTENSION, preferred: () => last, chosen: (enabled: boolean) => chosen.push(enabled) },
  };
}

/** The messages among the commands pi received: the Fast switches, in these tests. */
function fastSwitches(received: readonly Record<string, unknown>[]): unknown[] {
  return received.filter((command) => command["type"] === "prompt").map((command) => command["message"]);
}

describe("SessionManager Fast", () => {
  it("loads the Fast extension in a session's pi and switches Fast on, as last chosen, before reading the session", async () => {
    const { fast } = fastMemory(true);
    const { manager, piReceived, starts, received } = await manage(
      { argvToStderr: true, receivedToStderr: true, rules: FAST_PI },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fast,
    );

    await started(manager, manager.createChat("client-1"));
    await manager.subscribe("c1", ["pi-session-1"]);

    // Lines with what pi received are on stderr too.
    expect(
      starts()
        .map(({ argv }) => argv)
        .filter((argv) => argv !== undefined),
    ).toStrictEqual([["--mode", "rpc", "--session-id", "pi-session-1", "--extension", FAST_EXTENSION]]);
    await vi.waitFor(() =>
      expect(withoutIds(piReceived()).slice(0, 5)).toStrictEqual([
        { type: "set_auto_retry", enabled: true },
        { type: "get_commands" },
        { type: "prompt", message: "/atrium-fast on" },
        { type: "get_state" },
        { type: "get_entries" },
      ]),
    );
    expect(received).toMatchObject([{ type: "session_snapshot", fast: true }]);
  });

  it("sends no switch while Fast is off", async () => {
    const { fast } = fastMemory(false);
    const { manager, sent, received } = await manage(
      { rules: FAST_PI },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fast,
    );

    await started(manager, manager.createChat("client-1"));
    await manager.subscribe("c1", ["pi-session-1"]);

    expect(sent()).toStrictEqual(["set_auto_retry", "get_commands", "get_state", "get_entries", "get_session_stats"]);
    expect(received).toMatchObject([{ type: "session_snapshot", fast: false }]);
  });

  it("switches a session's Fast, records it for the session and reports it; the session's pi starts so again", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const first = fastMemory(false);
    const one = await manage(
      { receivedToStderr: true, rules: FAST_PI },
      at,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      first.fast,
    );
    await one.catalog.scan();
    await one.manager.openSession("client-1", "pi-session-1");
    await one.manager.subscribe("c1", ["pi-session-1"]);

    expect(await one.manager.setFast("pi-session-1", false)).toStrictEqual({});
    expect(await one.manager.setFast("pi-session-1", true)).toStrictEqual({});

    await vi.waitFor(() =>
      expect(fastSwitches(withoutIds(one.piReceived()))).toStrictEqual(["/atrium-fast off", "/atrium-fast on"]),
    );
    expect(one.received.at(-1)).toMatchObject({ type: "fast_updated", fast: true });
    expect(first.chosen).toStrictEqual([false, true]);
    await vi.waitFor(() => expect(one.catalog.find("pi-session-1")?.fast).toBe(true));
    await one.manager.close();
    await one.catalog.close();

    const two = await manage(
      { receivedToStderr: true, rules: FAST_PI },
      at,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fastMemory(false).fast,
    );
    await two.catalog.scan();
    await two.manager.openSession("client-1", "pi-session-1");

    await vi.waitFor(() => expect(fastSwitches(withoutIds(two.piReceived()))).toStrictEqual(["/atrium-fast on"]));
  });

  it("switches Fast on again in the pi started after a crash, as the session had it", async () => {
    const memory = fastMemory(true);
    const { manager, piReceived, received } = await manage(
      {
        receivedToStderr: true,
        rules: {
          ...FAST_PI,
          prompt: {
            sequence: [{ data: { disposition: "handled" } }, { data: { disposition: "started" }, exitAfter: 1 }],
          },
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      memory.fast,
    );
    await started(manager, manager.createChat("client-1"));
    await manager.subscribe("c1", ["pi-session-1"]);
    // Switched off in another session since; this one keeps its own.
    memory.prefer(false);

    // Each pi answers its first prompt, the switch, as handled, and exits on the message after it.
    await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "bye" });
    await vi.waitFor(() =>
      expect(received.at(-1)).toMatchObject({ type: "control_updated", control: { failure: { attempts: 3 } } }),
    );

    // The switch at the start, then again in each of the three pi processes started after a crash.
    await vi.waitFor(() =>
      expect(fastSwitches(withoutIds(piReceived())).filter((message) => message === "/atrium-fast on")).toHaveLength(4),
    );
    expect(received.filter((event) => event.type === "session_snapshot").at(-1)).toMatchObject({ fast: true });
  });

  it("never sends the switch to a pi that does not list it: Fast is unavailable there, and a warning says so", async () => {
    const { fast, chosen } = fastMemory(true);
    const { manager, sent, records, received } = await manage(
      { rules: { ...FAST_PI, get_commands: { data: { commands: [] } } } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fast,
    );
    await started(manager, manager.createChat("client-1"));
    await manager.subscribe("c1", ["pi-session-1"]);

    await expect(manager.setFast("pi-session-1", false)).rejects.toStrictEqual(new CommandError("fast_unavailable"));

    expect(sent()).not.toContain("prompt");
    expect(records.filter((record) => record["msg"] === "fast extension not loaded")).toStrictEqual([
      expect.objectContaining({ level: "warn" }),
    ]);
    expect(chosen).toStrictEqual([]);
    expect(received).toMatchObject([{ type: "session_snapshot", fast: true }]);
  });

  it("without the extension, loads nothing, asks pi nothing and has no Fast", async () => {
    const { manager, starts, sent } = await manage({ argvToStderr: true, rules: FAST_PI });
    await started(manager, manager.createChat("client-1"));

    await expect(manager.setFast("pi-session-1", true)).rejects.toStrictEqual(new CommandError("fast_unavailable"));

    expect(starts().map(({ argv }) => argv)).toStrictEqual([["--mode", "rpc", "--session-id", "pi-session-1"]]);
    expect(sent()).toStrictEqual(["set_auto_retry", "get_state", "get_entries", "get_session_stats"]);
  });

  it("shows a draft without pi with Fast as its own, else as last chosen", async () => {
    const at = await place();
    const first = await manage({ rules: SESSION_ONE }, at);
    await first.manager.createSession("client-1", WORKSPACE);
    await first.manager.createSession("client-1", WORKSPACE);
    await first.catalog.mark("pi-session-2", { fast: false });
    await first.manager.close();
    await first.catalog.close();

    const { manager, received } = await manage(
      { rules: FAST_PI },
      at,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fastMemory(true).fast,
    );
    await manager.subscribe("c1", ["pi-session-1", "pi-session-2"]);

    expect(
      received.filter((event) => event.type === "session_snapshot").map((event) => [event.sessionId, event.fast]),
    ).toStrictEqual([
      ["pi-session-1", true],
      ["pi-session-2", false],
    ]);
  });

  it("refuses to switch Fast in an unknown session", async () => {
    const { manager } = await manage({ rules: SESSION_ONE });

    await expect(manager.setFast("nope", true)).rejects.toStrictEqual(
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

describe("SessionManager compacting", () => {
  it("compacts a session, with what to keep in mind when asked, starting its pi first", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog, piReceived } = await manage(
      { receivedToStderr: true, rules: { ...SESSION_ONE, compact: { data: { summary: "s", tokensBefore: 9 } } } },
      at,
    );
    await catalog.scan();

    expect(await manager.compactSession("pi-session-1", "keep the API")).toStrictEqual({});
    expect(await manager.compactSession("pi-session-1", undefined)).toStrictEqual({});

    // pi reports what it received on its stderr, which may come after its answer.
    await vi.waitFor(() =>
      expect(withoutIds(piReceived()).filter((command) => command.type === "compact")).toStrictEqual([
        { type: "compact", customInstructions: "keep the API" },
        { type: "compact" },
      ]),
    );
  });

  it("counts a compaction as busy: a hand-off is refused and stopping idle pi keeps it", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog, piReceived, resources } = await manage(
      { receivedToStderr: true, rules: { ...SESSION_ONE, compact: { silent: true } } },
      at,
    );
    await catalog.scan();
    const compacting = manager.compactSession("pi-session-1", undefined).catch(caught);
    await vi.waitFor(() =>
      expect(withoutIds(piReceived()).filter((command) => command.type === "compact")).toStrictEqual([
        { type: "compact" },
      ]),
    );

    const handedOff = await manager.handOff("pi-session-1").catch(caught);
    await manager.stopIdle();

    expect([handedOff, resources.snapshot()["pi-process"]]).toStrictEqual([new CommandError("session_busy"), 1]);
    await manager.close();
    await compacting;
  });

  it("answers pi having nothing to compact", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog } = await manage(
      { rules: { ...SESSION_ONE, compact: { fail: "Nothing to compact (session too small)" } } },
      at,
    );
    await catalog.scan();

    await expect(manager.compactSession("pi-session-1", undefined)).rejects.toStrictEqual(
      new CommandError("nothing_to_compact"),
    );
  });

  it("refuses to compact a draft, which has nothing to compact, and an unknown session", async () => {
    const { manager } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createChat("client-1");

    await expect(manager.compactSession(sessionId, undefined)).rejects.toStrictEqual(
      new CommandError("session_is_draft", { sessionId }),
    );
    await expect(manager.compactSession("nope", undefined)).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "nope" }),
    );
  });
});

/** Where pi was told to write the export, from what it received. */
function exportPaths(received: readonly Record<string, unknown>[]): string[] {
  return received.flatMap((command) => (command["type"] === "export_html" ? [String(command["outputPath"])] : []));
}

/**
 * The directory pi was told to write the one export into, once pi has said what it received.
 *
 * @sideEffects none; waits for pi's stderr.
 * @param piReceived - What pi received so far.
 * @returns The directory.
 */
async function exportDir(piReceived: () => Record<string, unknown>[]): Promise<string> {
  await vi.waitFor(() => expect(exportPaths(piReceived())).toHaveLength(1));
  return dirname(present(exportPaths(piReceived())[0], "the export's path"));
}

describe("SessionManager exporting", () => {
  it("hands over the page pi wrote in a directory of its own, and removes it", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog, piReceived } = await manage(
      { receivedToStderr: true, rules: { ...SESSION_ONE, export_html: { writes: "<html>会话</html>" } } },
      at,
    );
    await catalog.scan();

    expect(await manager.exportSession("pi-session-1")).toStrictEqual({ html: "<html>会话</html>" });

    const dir = await exportDir(piReceived);
    expect(dir.startsWith(join(tmpdir(), "atrium-export-"))).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses a page over 20 MB, removing it, and hands over one of exactly 20 MB", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const size = 20 * 1024 * 1024;
    const { manager, catalog, piReceived } = await manage(
      {
        receivedToStderr: true,
        rules: { ...SESSION_ONE, export_html: { sequence: [{ writes: size + 1 }, { writes: size }] } },
      },
      at,
    );
    await catalog.scan();

    await expect(manager.exportSession("pi-session-1")).rejects.toStrictEqual(
      new CommandError("export_failed", { reason: "too_large" }),
    );
    expect(existsSync(await exportDir(piReceived))).toBe(false);
    expect((await manager.exportSession("pi-session-1")).html).toHaveLength(size);
  });

  it("fails when pi does, removing the directory it was given", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog, piReceived } = await manage(
      { receivedToStderr: true, rules: { ...SESSION_ONE, export_html: { fail: "Nothing to export yet" } } },
      at,
    );
    await catalog.scan();

    await expect(manager.exportSession("pi-session-1")).rejects.toStrictEqual(
      new CommandError("export_failed", { reason: "failed" }),
    );
    expect(existsSync(await exportDir(piReceived))).toBe(false);
  });

  it("refuses to export a draft, which has no file yet, and an unknown session", async () => {
    const { manager } = await manage({ rules: SESSION_ONE });
    const { sessionId } = await manager.createChat("client-1");

    await expect(manager.exportSession(sessionId)).rejects.toStrictEqual(
      new CommandError("session_is_draft", { sessionId }),
    );
    await expect(manager.exportSession("nope")).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "nope" }),
    );
  });
});

/** What an assistant message carries besides its text; a user message has none of it, which pi ignores. */
const ASSISTANT_ENDS = { stopReason: "stop", usage: { input: 3, output: 1 } };

/** pi's entries of `pi-session-1` with two turns, `u1` and `u2`. */
const TWO_TURNS = {
  data: {
    entries: [
      ["u1", null, "user", "one"],
      ["a1", "u1", "assistant", "first"],
      ["u2", "a1", "user", "two"],
      ["a2", "u2", "assistant", "second"],
    ].map(([id, parentId, role, text]) => ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-10-13T00:00:00.000Z",
      message: { role, content: [{ type: "text", text }], timestamp: 1, ...ASSISTANT_ENDS },
    })),
    leafId: "a2",
  },
};

/**
 * A scripted pi that runs `pi-session-1` with two turns, and forks or clones it into `pi-session-2`.
 *
 * @remarks
 * The fork's file is written where the catalog looks, unless `elsewhere`.
 *
 * @sideEffects none
 * @param at - The directories.
 * @param rules - Rules over these.
 * @param elsewhere - Whether the fork's file goes where the catalog does not look.
 * @returns The behavior.
 */
function forking(
  at: Awaited<ReturnType<typeof place>>,
  rules: Readonly<Record<string, object>> = {},
  elsewhere = false,
): ScriptedPiBehavior {
  const file = elsewhere
    ? join(at.root, "elsewhere.jsonl")
    : join(sessionFolder({ directory: at.piSessions, perCwd: false }, at.workspace), "pi-session-2.jsonl");
  const header = { type: "session", id: "pi-session-2", timestamp: "", cwd: at.workspace };
  const user = { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: "one" } };
  const switchesTo = { sessionId: "pi-session-2", file, text: `${JSON.stringify(header)}\n${JSON.stringify(user)}\n` };
  return {
    receivedToStderr: true,
    argvToStderr: true,
    rules: {
      ...SESSION_ONE,
      get_entries: TWO_TURNS,
      fork: { switchesTo, data: { text: "two", cancelled: false } },
      clone: { switchesTo, data: { cancelled: false } },
      ...rules,
    },
  };
}

/** A `fork_session` command for a turn of `pi-session-1`. */
function forkCommand(entry: string, sessionId = "pi-session-1"): ForkSessionCommand {
  return {
    type: "fork_session",
    requestId: "r1",
    traceparent,
    sessionId,
    turnId: `${sessionId}:${entry}`,
    name: "one（分叉）",
  };
}

/** The fork commands pi received, without request ids. */
function forkCommands(received: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const types = new Set(["fork", "clone", "set_session_name"]);
  return withoutIds(received.filter((command) => types.has(String(command["type"]))));
}

/** A manager running `pi-session-1`, with its tab open, over the scripted pi `forking` makes. */
async function forkable(
  rules: Readonly<Record<string, object>> = {},
  elsewhere = false,
  turnStarts?: (sessionId: string) => Promise<TurnStarts>,
) {
  const at = await place();
  const original = await terminalSession(at, "pi-session-1", at.workspace);
  const managed = await manage(forking(at, rules, elsewhere), at, turnStarts);
  await managed.catalog.scan();
  await managed.manager.openSession("client-1", "pi-session-1");
  return { ...managed, original };
}

describe("SessionManager forking", () => {
  it("forks before the next turn with a pi of its own on the session's file, names the fork and opens it as the active tab", async () => {
    const { manager, layouts, piReceived, starts, resources, original, at } = await forkable();

    expect(await manager.forkSession("client-1", forkCommand("u1"))).toStrictEqual({ sessionId: "pi-session-2" });

    expect(forkCommands(piReceived())).toStrictEqual([
      { type: "fork", entryId: "u2" },
      { type: "set_session_name", name: "one（分叉）" },
    ]);
    expect(
      starts()
        .filter((line) => "argv" in line)
        .map(({ argv, cwd }) => [argv.slice(2), cwd]),
    ).toStrictEqual([
      [["--session", original], at.workspace],
      [["--session", original], at.workspace],
    ]);
    expect(layouts.of("client-1")).toStrictEqual({
      container: WORKSPACE,
      tabs: { [WORKSPACE]: { open: ["pi-session-1", "pi-session-2"], active: "pi-session-2" } },
    });
    expect(resources.snapshot()["pi-process"]).toBe(1);
    expect(resources.snapshot()["timer"]).toBe(0);
  });

  it("clones the whole branch after the last turn, opening the fork without taking a client that went elsewhere there", async () => {
    const { manager, layouts, piReceived } = await forkable();

    const pending = manager.forkSession("client-1", forkCommand("u2"));
    await manager.selectContainer("client-1", CHAT);
    await pending;

    expect(forkCommands(piReceived())).toStrictEqual([
      { type: "clone" },
      { type: "set_session_name", name: "one（分叉）" },
    ]);
    expect(layouts.of("client-1")).toStrictEqual({
      container: CHAT,
      tabs: { [WORKSPACE]: { open: ["pi-session-1", "pi-session-2"], active: "pi-session-2" } },
    });
  });

  it("gives the fork the record of which messages opened turns", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const turns = join(at.home, "turn-starts");
    const load = async (sessionId: string) => (await loadTurnStarts(turns, sessionId, 0)).starts;
    await (await load("pi-session-1")).record(["u1", "u2"], ["u2"]);
    const { manager, catalog } = await manage(forking(at), at, load);
    await catalog.scan();
    await manager.openSession("client-1", "pi-session-1");

    await manager.forkSession("client-1", forkCommand("u1"));

    const copied = await load("pi-session-2");
    expect([[...copied.opened], [...copied.auto]]).toStrictEqual([["u1", "u2"], ["u2"]]);
  });

  it.each([
    ["pi refuses", { fork: { fail: "Invalid entry ID for forking" } }, false, "rejected"],
    ["an extension calls it off", { fork: { data: { text: "two", cancelled: true } } }, false, "cancelled"],
    ["pi exits", { fork: { exit: 1 } }, false, "exited"],
    ["the fork's file is not where sessions are", {}, true, "not_found"],
  ])(
    "fails when %s, logging only why, stopping its pi and opening nothing",
    async (_case, rules, elsewhere, reason) => {
      const { manager, layouts, records, resources } = await forkable(rules, elsewhere);

      await expect(manager.forkSession("client-1", forkCommand("u1"))).rejects.toStrictEqual(
        new CommandError("fork_failed"),
      );
      expect(records.filter((record) => record["msg"] === "fork failed")).toMatchObject([
        { sessionId: "pi-session-1", reason },
      ]);
      expect(layouts.of("client-1").tabs[WORKSPACE]).toStrictEqual({ open: ["pi-session-1"], active: "pi-session-1" });
      await vi.waitFor(() => expect(resources.snapshot()["pi-process"]).toBe(1));
    },
  );

  it("calls a fork under way off when the host closes", async () => {
    const { manager, records, resources, piReceived } = await forkable({ fork: { silent: true } });

    const failed = manager.forkSession("client-1", forkCommand("u1")).catch((error: unknown) => error);
    await vi.waitFor(() => expect(forkCommands(piReceived())).toStrictEqual([{ type: "fork", entryId: "u2" }]));
    await manager.close();

    expect(await failed).toStrictEqual(new CommandError("fork_failed"));
    expect(records.filter((record) => record["msg"] === "fork failed")).toMatchObject([
      { sessionId: "pi-session-1", reason: "aborted" },
    ]);
    expect(resources.snapshot()["pi-process"]).toBe(0);
  });

  it("holds the session busy until the fork's pi is done: a message queues, a fork, a compaction or a hand-off is refused", async () => {
    const { manager, piReceived } = await forkable({ fork: { silent: true } });
    const pending = manager.forkSession("client-1", forkCommand("u1")).catch(caught);
    await vi.waitFor(() => expect(forkCommands(piReceived())).toStrictEqual([{ type: "fork", entryId: "u2" }]));
    const busy = new CommandError("session_busy");

    // The hand-off first: a message in the queue would keep it back on its own.
    const answers = [
      await manager.handOff("pi-session-1").catch(caught),
      await manager.forkSession("client-1", forkCommand("u1")).catch(caught),
      await manager.compactSession("pi-session-1", undefined).catch(caught),
      await manager.prompt({ type: "prompt", requestId: "q1", traceparent, sessionId: "pi-session-1", text: "ping" }),
    ];
    await manager.close();
    await pending;

    expect(answers).toMatchObject([busy, busy, busy, { disposition: "queued" }]);
  });

  it("refuses a draft, and a session unknown, gone, handed off or never started here", async () => {
    const at = await place();
    const gone = await terminalSession(at, "pi-session-3", at.workspace);
    await terminalSession(at, "pi-session-4", at.workspace);
    await terminalSession(at, "pi-session-5", at.workspace);
    const { manager, catalog } = await manage(forking(at), at);
    // Recorded, so its file going leaves it missing rather than unknown.
    await catalog.record({ sessionId: "pi-session-3", containerId: WORKSPACE, cwd: at.workspace });
    await catalog.scan();
    await rm(gone);
    await catalog.scan();
    await manager.handOff("pi-session-4");
    const { sessionId: draft } = await manager.createChat("client-1");

    const refusals = [draft, "nope", "pi-session-3", "pi-session-4", "pi-session-5"].map((sessionId) =>
      manager.forkSession("client-1", forkCommand("u1", sessionId)).catch((error: unknown) => error),
    );

    expect(await Promise.all(refusals)).toStrictEqual([
      new CommandError("session_is_draft", { sessionId: draft }),
      new CommandError("session_not_found", { sessionId: "nope" }),
      new CommandError("session_not_found", { sessionId: "pi-session-3" }),
      new CommandError("session_handed_off", { sessionId: "pi-session-4" }),
      new CommandError("turn_not_found"),
    ]);
  });

  it("forks all the same when the record cannot be copied, logging that", async () => {
    const { manager, records } = await forkable({}, false, () => Promise.reject(new Error("disk full")));

    expect(await manager.forkSession("client-1", forkCommand("u1"))).toStrictEqual({ sessionId: "pi-session-2" });
    expect(records.filter((record) => record["msg"] === "turn starts could not be copied")).toMatchObject([
      { sessionId: "pi-session-2", err: { message: "disk full" } },
    ]);
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
 * @param titleModel - The title model pi can use in a directory, if a test needs one.
 * @returns The manager and what tests look at.
 */
async function opened(
  turns: readonly (readonly object[])[],
  rules: Record<string, object> = {},
  more: Omit<ScriptedPiBehavior, "rules"> = {},
  titleModel?: Parameters<typeof createSessionManager>[0]["titleModel"],
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
    undefined,
    undefined,
    undefined,
    undefined,
    titleModel,
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

describe("SessionManager message images (M1.11)", () => {
  it("reads a turn's image from the session file, and answers image_unavailable for one that is not there", async () => {
    const at = await place();
    const file = await terminalSession(at, "pi-session-1", at.workspace);
    const user = {
      type: "message",
      id: "u2",
      parentId: "u1",
      timestamp: "2026-10-12T00:00:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", mimeType: "image/png", data: "eA==" },
        ],
        timestamp: 0,
      },
    };
    await appendFile(file, `${JSON.stringify(user)}\n`);
    const { manager, catalog } = await manage(
      { rules: { ...SESSION_ONE, get_entries: { data: { entries: [user], leafId: "u2" } } } },
      at,
    );
    await catalog.scan();
    await manager.openSession("client-1", "pi-session-1");
    const fetch = (sessionId: string, turnId: string, index: number) =>
      manager.fetchImage({ type: "fetch_image", requestId: "r", traceparent, sessionId, turnId, index });
    const unavailable = new CommandError("image_unavailable");

    await vi.waitFor(() =>
      expect(fetch("pi-session-1", "pi-session-1:u2", 0)).resolves.toStrictEqual({
        mimeType: "image/png",
        data: "eA==",
      }),
    );
    await expect(fetch("pi-session-1", "pi-session-1:u2", 1)).rejects.toStrictEqual(unavailable);
    await expect(fetch("pi-session-1", "pi-session-1:u1", 0)).rejects.toStrictEqual(unavailable);
    await expect(fetch("nope", "pi-session-1:u2", 0)).rejects.toStrictEqual(
      new CommandError("session_not_found", { sessionId: "nope" }),
    );
  });

  it("answers image_unavailable for a turn of a session that has no file yet", async () => {
    const user = {
      type: "message",
      id: "u2",
      parentId: null,
      timestamp: "2026-10-12T00:00:00.000Z",
      message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "eA==" }], timestamp: 0 },
    };
    const { manager, received } = await manage({
      rules: { ...SESSION_ONE, get_entries: { data: { entries: [user], leafId: "u2" } } },
    });
    const { sessionId } = await started(manager, manager.createChat("client-1"));
    await manager.subscribe("c1", [sessionId]);
    await vi.waitFor(() => expect(JSON.stringify(received)).toContain(`"${sessionId}:u2"`));

    await expect(
      manager.fetchImage({
        type: "fetch_image",
        requestId: "r",
        traceparent,
        sessionId,
        turnId: `${sessionId}:u2`,
        index: 0,
      }),
    ).rejects.toStrictEqual(new CommandError("image_unavailable"));
  });
});

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
 * @param titleModel - The title model pi can use in a directory, if a test needs one.
 * @returns The manager, what tests look at, what the one-shot pi saw and how to release it.
 */
async function titled(
  title: string,
  rules: Record<string, object> = NAMEABLE,
  titleModel?: Parameters<typeof createSessionManager>[0]["titleModel"],
) {
  const gates = await createTempDir("titles");
  cleanups.push(gates.cleanup);
  const seenAt = join(gates.path, "seen.json");
  const gate = join(gates.path, "release.flag");
  const managed = await opened(
    [turn],
    rules,
    { receivedToStderr: true, print: { lines: [titleReply(title)], recordTo: seenAt, waitFor: gate } },
    titleModel,
  );
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

  it("asks on the title model chosen when pi can use it in the session's directory", async () => {
    const asks: string[] = [];
    const { run, seen, release, names, at } = await titled("Ping", NAMEABLE, async (cwd) => {
      asks.push(cwd);
      return { providerId: "openai", modelId: "gpt-5-mini" };
    });

    await run();
    const asked = await seen();
    await release();
    await vi.waitFor(() => expect(names()).toStrictEqual(["Ping"]));

    expect(asked).toMatchObject({ argv: expect.arrayContaining(["--model", "openai/gpt-5-mini"]) });
    expect(asks).toStrictEqual([at.workspace]);
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

  it("leaves a session alone while one of its dialogs waits for an answer", async () => {
    const { manager, received, starts, run } = await opened([[...turn, confirmation("d1")]]);
    await run();
    await vi.waitFor(() => expect(manager.summaries()[0]?.asking).not.toBeNull());

    await manager.stopIdle();

    expect(received.map((event) => event.type)).not.toContain("session_exited");
    expect(manager.summaries()).toMatchObject([{ sessionId: "pi-session-1", running: false }]);
    expect(starts()).toHaveLength(1);
  });

  it("waits for a session's pi starting meanwhile, which may be the old one, and stops it once idle", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const reading = Promise.withResolvers<void>();
    const read = Promise.withResolvers<TurnStarts>();
    const { manager, catalog, starts, resources } = await manage({ argvToStderr: true, rules: SESSION_ONE }, at, () => {
      reading.resolve();
      return read.promise;
    });
    await catalog.scan();
    const opening = manager.openSession("client-1", "pi-session-1");
    await reading.promise;

    const stopping = manager.stopIdle();
    read.resolve({ opened: new Set(), auto: new Set(), record: async () => undefined });
    await stopping;
    await opening;

    expect(resources.snapshot()["pi-process"]).toBe(0);
    expect(manager.summaries()).toMatchObject([{ sessionId: "pi-session-1", running: false }]);
    expect(starts()).toHaveLength(1);
  });

  it("waits for a new chat's pi starting meanwhile, and stops it once idle", async () => {
    const reading = Promise.withResolvers<void>();
    const read = Promise.withResolvers<TurnStarts>();
    const { manager, starts, resources } = await manage({ argvToStderr: true, rules: SESSION_ONE }, undefined, () => {
      reading.resolve();
      return read.promise;
    });
    const creating = manager.createChat("client-1");
    await reading.promise;

    const stopping = manager.stopIdle();
    read.resolve({ opened: new Set(), auto: new Set(), record: async () => undefined });
    await stopping;

    expect(await creating).toStrictEqual({ sessionId: "pi-session-1" });
    expect(resources.snapshot()["pi-process"]).toBe(0);
    expect(starts()).toHaveLength(1);
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

/** The child of `pi-session-1` the user opens empty, in its workspace. */
const CHILD = { parentSessionId: "pi-session-1", name: "补测试", place: "same" } as const;

/** A workspace a new worktree adds. */
const NEW_WORKSPACE = "wks_000000000000000b";

/**
 * A manager with `pi-session-1` on file and open, that can make new worktrees for child conversations.
 *
 * @remarks
 * Making a worktree creates its directory and lists its workspace, as the worktree creator and
 * the project's scan would; what it was asked is kept. Forks into a new worktree go to a
 * temporary directory of the test's.
 *
 * @sideEffects Creates files; starts pi for `pi-session-1`.
 * @param rules - The scripted pi's rules, over those of `forking`.
 * @param missing - Whether a new worktree's directory is left out, so no pi starts there.
 * @returns The manager, what tests look at, the worktrees asked for and the temporary root.
 */
async function withWorktrees(rules: Readonly<Record<string, object>> = {}, missing = false) {
  const at = await place();
  await terminalSession(at, "pi-session-1", at.workspace);
  const workspaces: { id: string; dir: string }[] = [];
  const asked: string[] = [];
  const tempRoot = join(at.root, "tmp");
  await mkdir(tempRoot);
  const managed = await manage(
    forking(at, rules),
    at,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      workspaces,
      tempRoot,
      sessionsTaken: 1,
      childWorktree: async (workspaceId, wanted) => {
        asked.push(`${workspaceId} ${wanted}`);
        const dir = join(at.root, "app.worktrees", "tests");
        if (!missing) await mkdir(dir, { recursive: true });
        workspaces.push({ id: NEW_WORKSPACE, dir });
        return { workspaceId: NEW_WORKSPACE, dir };
      },
    },
  );
  await managed.catalog.scan();
  await managed.manager.openSession("client-1", "pi-session-1");
  return { ...managed, asked, tempRoot, worktree: join(at.root, "app.worktrees", "tests") };
}

/**
 * The children's figures last published for a session.
 *
 * @sideEffects none
 * @param received - The events published.
 * @param sessionId - The session.
 * @returns The figures, or `undefined` before any.
 */
function childrenFigures(received: readonly SessionEvent[], sessionId: string): unknown {
  const updates = received.filter(
    (event): event is Extract<SessionEvent, { type: "metrics_updated" }> => event.type === "metrics_updated",
  );
  return updates.filter((event) => event.sessionId === sessionId).at(-1)?.metrics.children;
}

/**
 * A session file line: a reply with only input tokens.
 *
 * @sideEffects none
 * @param id - The entry's id.
 * @param input - Its input tokens.
 * @param cost - Its cost in US dollars.
 * @returns The line.
 */
function replyLine(id: string, input: number, cost = 0): string {
  const usage = { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } };
  return `${JSON.stringify({ type: "message", id, message: { role: "assistant", usage } })}\n`;
}

describe("SessionManager child conversations (SPEC-0002)", () => {
  it("creates an empty child under a session in its workspace, named before pi writes a file, and starts its pi with the name", async () => {
    const { manager, catalog, layouts, starts } = await withWorktrees();

    expect(await manager.createSession("client-1", WORKSPACE, true, CHILD)).toStrictEqual({
      sessionId: "pi-session-2",
    });

    expect(catalog.find("pi-session-2")).toMatchObject({
      containerId: WORKSPACE,
      name: "补测试",
      state: "draft",
      parent: { sessionId: "pi-session-1", by: "user" },
      usageAfter: null,
    });
    expect(manager.summaries().find((summary) => summary.sessionId === "pi-session-2")?.parent).toStrictEqual({
      sessionId: "pi-session-1",
      by: "user",
    });
    expect(layouts.of("client-1").tabs[WORKSPACE]).toStrictEqual({
      open: ["pi-session-1", "pi-session-2"],
      active: "pi-session-2",
    });
    await vi.waitFor(() =>
      expect(
        starts()
          .filter((line) => "argv" in line)
          .map(({ argv }) => argv.slice(2)),
      ).toContainEqual(["--session-id", "pi-session-2", "--name", "补测试"]),
    );
  });

  it("names a draft child in its record, and in its pi once that runs, so its file carries the new name", async () => {
    const { manager, catalog, sent, starts, at } = await withWorktrees({ set_session_name: { data: {} } });
    await catalog.record({
      sessionId: "idle-child",
      containerId: WORKSPACE,
      cwd: at.workspace,
      parent: { sessionId: "pi-session-1", by: "user" },
      name: "旧名字",
    });

    expect(await manager.renameSession("idle-child", "边界用例")).toStrictEqual({});
    expect(catalog.find("idle-child")).toMatchObject({ name: "边界用例", state: "draft" });
    expect(JSON.stringify(starts())).not.toContain("idle-child");
    expect(sent()).not.toContain("set_session_name");

    const { sessionId } = await started(manager, manager.createSession("client-1", WORKSPACE, true, CHILD));
    await vi.waitFor(() => expect(sent()).toContain("get_state"));
    expect(await manager.renameSession(sessionId, "补测试二")).toStrictEqual({});
    expect(catalog.find(sessionId)).toMatchObject({ name: "补测试二", state: "draft" });
    expect(sent()).toContain("set_session_name");
  });

  it("refuses a child elsewhere than its parent's container, under a draft, under a session archived or unknown", async () => {
    const { manager } = await withWorktrees();
    const { sessionId: draft } = await manager.createSession("client-1", WORKSPACE);
    await manager.createSession("client-1", WORKSPACE, true, CHILD);
    const { sessionId: gone } = await manager.createSession("client-1", WORKSPACE, true, CHILD);
    await manager.archiveSession(gone);

    const answers = [
      await manager.createSession("client-1", CHAT, true, CHILD).catch(caught),
      await manager.createSession("client-1", WORKSPACE, true, { ...CHILD, parentSessionId: draft }).catch(caught),
      await manager.createSession("client-1", WORKSPACE, true, { ...CHILD, parentSessionId: gone }).catch(caught),
      await manager.createSession("client-1", WORKSPACE, true, { ...CHILD, parentSessionId: "nobody" }).catch(caught),
    ];

    expect(answers).toStrictEqual([
      new CommandError("child_place_invalid"),
      new CommandError("session_is_draft", { sessionId: draft }),
      new CommandError("session_not_found", { sessionId: gone }),
      new CommandError("session_not_found", { sessionId: "nobody" }),
    ]);
  });

  it("puts an empty child in a new worktree from the parent's workspace and opens it there", async () => {
    const { manager, catalog, layouts, asked, worktree } = await withWorktrees();

    const { sessionId } = await manager.createSession("client-1", WORKSPACE, true, {
      ...CHILD,
      place: "worktree",
      branch: "atrium/tests",
    });

    expect(asked).toStrictEqual([`${WORKSPACE} atrium/tests`]);
    expect(catalog.find(sessionId)).toMatchObject({
      containerId: NEW_WORKSPACE,
      cwd: worktree,
      parent: { sessionId: "pi-session-1", by: "user" },
    });
    expect(layouts.of("client-1")).toMatchObject({
      container: NEW_WORKSPACE,
      tabs: { [NEW_WORKSPACE]: { open: [sessionId], active: sessionId } },
    });
  });

  it("refuses a new worktree for a host that cannot make one", async () => {
    const at = await place();
    await terminalSession(at, "pi-session-1", at.workspace);
    const { manager, catalog } = await manage(forking(at), at);
    await catalog.scan();

    await expect(
      manager.createSession("client-1", WORKSPACE, true, { ...CHILD, place: "worktree", branch: "x" }),
    ).rejects.toStrictEqual(new CommandError("child_place_invalid"));
  });

  it("forks a child from a turn into the same workspace, under the session, counting only what follows the copy", async () => {
    const { manager, catalog } = await forkable();

    await manager.forkSession("client-1", { ...forkCommand("u1"), name: "查日志", child: { place: "same" } });

    expect(catalog.find("pi-session-2")).toMatchObject({
      containerId: WORKSPACE,
      state: "persisted",
      parent: { sessionId: "pi-session-1", by: "user" },
      usageAfter: "u1",
    });
  });

  it("forks a child into a new worktree: the fork goes to a temporary directory, the child's pi starts there with --fork, and is told where it works", async () => {
    const { manager, catalog, layouts, starts, piReceived, tempRoot, worktree } = await withWorktrees({
      fork: {
        switchesTo: {
          sessionId: "pi-session-x",
          file: "<session-dir>/fork.jsonl",
          text: `${JSON.stringify({ type: "session", id: "pi-session-x", cwd: "/" })}\n${JSON.stringify({ type: "message", id: "u1" })}\n`,
        },
        data: { text: "two", cancelled: false },
      },
      get_commands: { data: { commands: [{ name: "atrium-agent", source: "extension", sourceInfo: {} }] } },
    });

    const { sessionId } = await manager.forkSession("client-1", {
      ...forkCommand("u1"),
      name: "查日志",
      child: { place: "worktree", branch: "atrium/logs" },
    });

    const launched = starts().filter((line) => "argv" in line);
    const forkStart = present(
      launched.find(({ argv }) => argv.includes("--session-dir")),
      "the fork's start",
    );
    const childStart = present(
      launched.find(({ argv }) => argv.includes("--fork")),
      "the child's start",
    );
    const forkDir = present(forkStart.argv[5], "the fork's directory");
    expect(forkStart.argv.slice(2, 5)).toStrictEqual(["--session", expect.any(String), "--session-dir"]);
    expect(dirname(forkDir)).toBe(tempRoot);
    expect(childStart).toStrictEqual({
      argv: [
        "--mode",
        "rpc",
        "--fork",
        join(forkDir, "fork.jsonl"),
        "--session-id",
        sessionId,
        ...childStart.argv.slice(6),
      ],
      cwd: worktree,
    });
    expect(catalog.find(sessionId)).toMatchObject({
      containerId: NEW_WORKSPACE,
      parent: { sessionId: "pi-session-1", by: "user" },
      usageAfter: "u1",
    });
    const note = piReceived().find((command) => String(command["message"]).startsWith("/atrium-agent note "));
    expect(
      JSON.parse(Buffer.from(String(note?.["message"]).slice("/atrium-agent note ".length), "base64url").toString()),
    ).toStrictEqual({
      v: 1,
      kind: "note",
      note: "worktree_moved",
      from: catalog.find("pi-session-1")?.cwd,
      to: worktree,
    });
    expect(await readdir(tempRoot)).toStrictEqual([]);
    expect(layouts.of("client-1").tabs[NEW_WORKSPACE]).toStrictEqual({ open: [sessionId], active: sessionId });
  });

  it("forgets a child forked into a new worktree whose pi did not start, but keeps one whose file pi wrote, naming it", async () => {
    const { manager, catalog, tempRoot, worktree, at } = await withWorktrees(
      {
        fork: {
          switchesTo: {
            sessionId: "pi-session-x",
            file: "<session-dir>/fork.jsonl",
            text: `${JSON.stringify({ type: "session", id: "pi-session-x", cwd: "/" })}\n${JSON.stringify({ type: "message", id: "u1" })}\n`,
          },
          data: { text: "two", cancelled: false },
        },
      },
      true,
    );
    const fork = { ...forkCommand("u1"), name: "查日志", child: { place: "worktree", branch: "atrium/logs" } } as const;

    await expect(manager.forkSession("client-1", fork)).rejects.toStrictEqual(new CommandError("fork_failed"));
    expect(catalog.find("pi-session-2")).toBeUndefined();
    const folder = sessionFolder({ directory: at.piSessions, perCwd: false }, worktree);
    await writeFile(
      join(folder, "pi-session-3.jsonl"),
      `${JSON.stringify({ type: "session", id: "pi-session-3", timestamp: "", cwd: worktree })}\n`,
    );
    await expect(manager.forkSession("client-1", fork)).rejects.toStrictEqual(
      new CommandError("fork_failed", { sessionId: "pi-session-3" }),
    );

    expect(catalog.find("pi-session-3")).toMatchObject({
      state: "persisted",
      name: "查日志",
      parent: { sessionId: "pi-session-1", by: "user" },
    });
    expect(await readdir(tempRoot)).toStrictEqual([]);
  });

  it("removes only its own marked temporary directories of forks a stop cut short", async () => {
    const at = await place();
    const tempRoot = join(at.root, "tmp");
    await mkdir(join(tempRoot, "atrium-fork-left"), { recursive: true });
    await writeFile(join(tempRoot, "atrium-fork-left", ".atrium-fork"), "");
    await mkdir(join(tempRoot, "atrium-fork-unmarked"), { recursive: true });
    await mkdir(join(tempRoot, "someone-else"), { recursive: true });
    await writeFile(join(tempRoot, "someone-else", ".atrium-fork"), "");

    const { manager } = await manage(
      { rules: SESSION_ONE },
      at,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { tempRoot },
    );
    await vi.waitFor(async () =>
      expect((await readdir(tempRoot)).toSorted()).toStrictEqual(["atrium-fork-unmarked", "someone-else"]),
    );
    await manager.close();
  });

  it("detaches a child, leaving its own children under it, and does nothing for a session without a parent", async () => {
    const { manager, catalog } = await withWorktrees();
    const { sessionId: child } = await manager.createSession("client-1", WORKSPACE, true, CHILD);
    await catalog.record({
      sessionId: "pi-grandchild",
      containerId: WORKSPACE,
      cwd: "/",
      parent: { sessionId: child, by: "user" },
    });

    expect(await manager.detachSession(child)).toStrictEqual({});
    expect(await manager.detachSession("pi-session-1")).toStrictEqual({});

    expect([catalog.find(child)?.parent, catalog.find("pi-grandchild")?.parent]).toStrictEqual([
      null,
      { sessionId: child, by: "user" },
    ]);
  });

  it("archives a session with its children in the same workspace, and detaches a child in another", async () => {
    const { manager, catalog, layouts } = await withWorktrees();
    const { sessionId: same } = await manager.createSession("client-1", WORKSPACE, true, CHILD);
    // A draft has no children; the record stands for one on file below it.
    const below = "pi-below";
    await catalog.record({
      sessionId: below,
      containerId: WORKSPACE,
      cwd: "/",
      parent: { sessionId: same, by: "user" },
    });
    const { sessionId: elsewhere } = await manager.createSession("client-1", WORKSPACE, true, {
      ...CHILD,
      place: "worktree",
      branch: "atrium/tests",
    });

    await manager.archiveSession("pi-session-1");

    expect(
      [same, below, elsewhere].map((id) => {
        const { archived, parent } = present(catalog.find(id), id);
        return [archived, parent];
      }),
    ).toStrictEqual([
      [true, { sessionId: "pi-session-1", by: "user" }],
      [true, { sessionId: same, by: "user" }],
      [false, null],
    ]);
    expect(layouts.of("client-1").tabs[WORKSPACE]).toStrictEqual({ open: [], active: null });
  });

  it("detaches a child elsewhere when its parent's workspace is archived", async () => {
    const { manager, catalog } = await withWorktrees();
    const { sessionId: elsewhere } = await manager.createSession("client-1", WORKSPACE, true, {
      ...CHILD,
      place: "worktree",
      branch: "atrium/tests",
    });
    await manager.stopWorkspace(WORKSPACE);

    await manager.archiveWorkspace(WORKSPACE);
    manager.releaseWorkspace(WORKSPACE);

    expect([catalog.find("pi-session-1")?.archived, catalog.find(elsewhere)?.parent]).toStrictEqual([true, null]);
  });

  it("updates a session's children figures when a child's own figures change, before any scan", async () => {
    const { manager, catalog, received, at } = await withWorktrees({
      get_session_stats: {
        data: {
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          totalMessages: 2,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
          cost: 0,
        },
      },
    });
    await manager.subscribe("c1", ["pi-session-1"]);
    const file = join(sessionFolder({ directory: at.piSessions, perCwd: false }, at.workspace), "pi-kid.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", id: "pi-kid", cwd: at.workspace })}\n${replyLine("a1", 100)}`,
    );
    await catalog.record({
      sessionId: "pi-kid",
      containerId: WORKSPACE,
      cwd: at.workspace,
      parent: { sessionId: "pi-session-1", by: "user" },
      persisted: true,
    });
    await catalog.scan();
    /** The last children's figures published for `pi-session-1`. */
    const children = () => childrenFigures(received, "pi-session-1");
    await vi.waitFor(() => expect(children()).toStrictEqual({ tokens: 100, cost: 0 }));

    await appendFile(file, replyLine("a2", 20));
    // Opening the child starts its pi, whose figures are read and published; no scan comes.
    await manager.openSession("client-1", "pi-kid");

    await vi.waitFor(() => expect(children()).toStrictEqual({ tokens: 120, cost: 0 }));
  });

  it("archives a chat with its sessions, and detaches a child of one that is elsewhere", async () => {
    const { manager, catalog } = await withWorktrees();
    const { sessionId: inChat } = await manager.createChat("client-1");
    await catalog.record({
      sessionId: "pi-away",
      containerId: WORKSPACE,
      cwd: "/",
      parent: { sessionId: inChat, by: "user" },
    });

    await manager.archiveChat(CHAT);

    expect([
      catalog.find(inChat)?.archived,
      catalog.find("pi-away")?.archived,
      catalog.find("pi-away")?.parent,
    ]).toStrictEqual([true, false, null]);
  });

  it("refuses a message, a steer or a queue edit that opens with /atrium-", async () => {
    const { manager } = await withWorktrees();
    const message = { requestId: "q1", traceparent, sessionId: "pi-session-1" } as const;

    const answers = [
      await manager.prompt({ type: "prompt", ...message, text: "/atrium-agent note x" }).catch(caught),
      await manager.steer({ type: "steer", ...message, text: "  /atrium-fast on" }).catch(caught),
      await manager.updateQueued("pi-session-1", "item", "/atrium-plan xai").catch(caught),
    ];

    expect(answers).toStrictEqual([
      new CommandError("command_reserved"),
      new CommandError("command_reserved"),
      new CommandError("command_reserved"),
    ]);
  });

  it("gives a session the usage its children produced after their copies, and updates it as a child's file grows", async () => {
    const { manager, catalog, received, at } = await withWorktrees();
    await manager.subscribe("c1", ["pi-session-1"]);
    const { sessionId: child } = await manager.createSession("client-1", WORKSPACE, true, CHILD);
    const folder = sessionFolder({ directory: at.piSessions, perCwd: false }, at.workspace);
    const file = join(folder, `${child}.jsonl`);
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", id: child, cwd: at.workspace })}\n${replyLine("a1", 100, 0.5)}`,
    );
    await catalog.scan();

    /** The last children's figures published for `pi-session-1`. */
    const children = () => childrenFigures(received, "pi-session-1");
    await vi.waitFor(() => expect(children()).toStrictEqual({ tokens: 100, cost: 0.5 }));

    await appendFile(file, replyLine("a2", 20, 0.25));
    await catalog.scan();
    await vi.waitFor(() => expect(children()).toStrictEqual({ tokens: 120, cost: 0.75 }));
    await manager.detachSession(child);
    await vi.waitFor(() => expect(children()).toBeNull());
  });
});
