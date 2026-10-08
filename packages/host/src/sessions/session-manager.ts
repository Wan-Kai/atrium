import { type PiInspection, PiRequestError, toLogEntry } from "@atrium/pi";
import {
  CHATS,
  CommandError,
  type SessionEvent,
  type SessionSnapshotEvent,
  type SessionSummary,
} from "@atrium/protocol";
import type { Tracer } from "@opentelemetry/api";
import { mkdir, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../platform/clock";
import type { Logger } from "../platform/logger";
import { createPiDeps } from "../platform/pi-deps";
import type { ResourceTracker } from "../platform/resources";
import type { SubscriptionRegistry } from "../sync/subscriptions";
import type { EntriesPage } from "../transcript/session-transcript";
import type { WorkspaceService } from "../workspaces/workspace-service";
import type { TurnStarts } from "../store/turn-starts";
import type { Layouts } from "./layouts";
import type { CatalogEntry, SessionCatalog } from "./session-catalog";
import type { SessionCommands } from "./session-commands";
import { type SessionController, createSessionController } from "./session-controller";
import { type TracedPi, startTracedPi } from "./traced-pi";

/** What the host found out about pi; `null` when detection did not finish. */
export interface SessionTools {
  readonly env: Readonly<Record<string, string>>;
  readonly pi: PiInspection;
}

/** The session layer: every session's controller, and the session commands. */
export interface SessionManager extends SessionCommands {
  /** Every session of a registered container, with whether it runs. */
  summaries(): SessionSummary[];
  /** Stops the sessions of workspaces that went away and drops them from every layout. */
  forgetWorkspaces(workspaceIds: readonly string[]): Promise<void>;
  /** Looks at the containers' session files again: the window gained focus, or containers changed. */
  rescan(): void;
  /** Stops every pi; resolves once all have exited and background scans have stopped. */
  close(): Promise<void>;
}

/** A pi that is running a session, with what the manager does with it. */
interface Running {
  readonly controller: SessionController;
  readonly pi: TracedPi;
}

/** pi, found and usable. */
type ReadyTools = SessionTools & { readonly pi: Extract<PiInspection, { status: "ready" }> };

/**
 * Creates the session manager.
 *
 * @remarks
 * Follows SPEC-0001 ("项目、工作区与会话") and domain-model §1:
 * - a new session or chat starts its pi at once (domain-model, "已决定 9, 14"), is recorded as a
 *   draft in its container, and opens as the client's active tab; a chat gets its own directory
 *   under the chats root;
 * - opening a session starts pi with `--session <file>` in the directory the session recorded,
 *   unless its pi runs; a draft restored after a restart starts with `--session-id <id>` on its
 *   first message (domain-model, "已决定 7");
 * - closing the last tab of a draft that never got a message discards it: its pi stops, its
 *   record goes, and a chat's empty directory is removed (domain-model, "已决定 13");
 * - archiving hides a session and stops its pi;
 * - pi must have been found and be usable; otherwise starting fails with `pi_unavailable` and
 *   pi's status, which the UI explains;
 * - which user messages opened turns is kept per session (`turnStarts`), so a later host
 *   rebuilds steers and turns as they were (SPEC-0001, `steer`).
 *
 * Subscribing sends each newly watched session's snapshot to that connection before any later
 * event (domain-model §7); a draft without pi has an empty one, and its subscribers get the real
 * one once pi starts. Runs starting and ending change the list; a run's end also has the catalog
 * and the workspace looked at again.
 *
 * @sideEffects none until a command arrives; then creates directories, spawns pi, writes the
 * index and publishes.
 * @param options - The chats root, the detected tools, the subscription registry, the catalog,
 * layouts and workspaces, a callback for list changes, and the host's clock, resources, tracer,
 * logger and id source.
 * @returns The manager.
 */
export function createSessionManager(options: {
  readonly chatsRoot: string;
  readonly tools: Promise<SessionTools | null>;
  readonly subscriptions: SubscriptionRegistry;
  readonly catalog: SessionCatalog;
  readonly layouts: Layouts;
  readonly workspaces: Pick<WorkspaceService, "dirOf" | "refresh">;
  readonly onChange: () => void;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly newId: () => string;
  /** Loads a session's turn starts (`turns/<session id>.json`); without it they live in memory. */
  readonly turnStarts?: (sessionId: string) => Promise<TurnStarts>;
}): SessionManager {
  const sessions = new Map<string, Running>();
  /** Every pi started, including one still reporting its session id, so `close` stops them all. */
  const running = new Set<{ stop(): Promise<unknown> }>();
  /** Sessions with a run in progress. */
  const busy = new Set<string>();
  /** `prompt`s on their way, by session, so a draft is not discarded under one. */
  const prompting = new Map<string, number>();
  /** Sessions being started, so a second start waits for the first. */
  const starting = new Map<string, Promise<Running>>();
  /** Background work, such as scans after a run, that `close` waits for. */
  const background = new Set<Promise<void>>();
  /** Set by `close`; a session being started then stops its pi instead of keeping it. */
  let closed = false;

  /**
   * Runs work in the background, logging a failure.
   *
   * @remarks
   * Kept so `close` can wait for it; nothing is left dangling.
   *
   * @sideEffects Starts the work; may log.
   * @param what - What the work is, for the log.
   * @param work - The work.
   */
  function inBackground(what: string, work: () => Promise<unknown>): void {
    const task = work().then(
      () => undefined,
      (error: unknown) => {
        if (!closed) options.logger.warn({ ...failureFields(error) }, `${what} failed`);
      },
    );
    background.add(task);
    // Fire and forget: removing itself cannot fail.
    void task.finally(() => background.delete(task));
  }

  /**
   * Finds what the catalog knows of a session.
   *
   * @remarks
   * Clients name sessions by id; an unknown id is the client's mistake, not a host failure.
   *
   * @sideEffects none
   * @param sessionId - The id.
   * @returns The entry.
   * @throws {CommandError} `session_not_found`.
   */
  function entryOf(sessionId: string): CatalogEntry {
    const entry = options.catalog.find(sessionId);
    if (entry === undefined) throw new CommandError("session_not_found", { sessionId });
    return entry;
  }

  /**
   * The session's live pi, unless it has exited.
   *
   * @remarks
   * An exited controller stays in the map so subscribers keep its state.
   *
   * @sideEffects none
   * @param sessionId - The id.
   * @returns The running session, or `undefined`.
   */
  function live(sessionId: string): Running | undefined {
    const found = sessions.get(sessionId);
    return found === undefined || found.controller.snapshot().exited ? undefined : found;
  }

  /**
   * The tools, when pi can be used.
   *
   * @remarks
   * pi must have been found and be usable; otherwise the UI explains the status.
   *
   * @sideEffects Waits for tool detection.
   * @returns The tools.
   * @throws {CommandError} `pi_unavailable` with pi's status otherwise.
   */
  async function readyTools(): Promise<ReadyTools> {
    const tools = await options.tools;
    if (tools?.pi.status !== "ready") {
      throw new CommandError("pi_unavailable", { status: tools?.pi.status ?? "unknown" });
    }
    return { env: tools.env, pi: tools.pi };
  }

  /**
   * Keeps track of runs for the list, and looks at the session's files once a run ends.
   *
   * @remarks
   * A run's end may have written the file, a name or commits in the workspace.
   *
   * @sideEffects Updates `busy`; calls `onChange`; may start background scans.
   * @param sessionId - The session.
   * @param event - An event it published.
   */
  function observe(sessionId: string, event: SessionEvent): void {
    if (event.type === "run_started") {
      busy.add(sessionId);
      options.onChange();
    } else if (event.type === "run_settled" || event.type === "session_exited") {
      if (busy.delete(sessionId)) options.onChange();
      if (event.type === "run_settled") {
        const containerId = options.catalog.find(sessionId)?.containerId;
        if (containerId !== undefined && containerId !== CHATS) options.workspaces.refresh(containerId);
        inBackground("session scan", () => options.catalog.scan());
      }
    }
  }

  /**
   * Starts pi for a session and puts a controller in charge of it.
   *
   * @remarks
   * The session's id is the one pi reports (domain-model, "已决定 2"); its entries are read at
   * once, so the first snapshot already holds the transcript, and the session's current
   * subscribers get it. A pi that cannot report its session is stopped, never left running
   * unowned; one started while the host closes stops itself.
   *
   * @sideEffects Spawns pi; registers the controller; sends snapshots to the session's viewers.
   * @param tools - The tools to start pi with.
   * @param launch - pi's arguments and working directory.
   * @returns The session.
   * @throws {CommandError} `pi_unavailable` when pi exits or does not answer.
   */
  async function startPi(tools: ReadyTools, launch: { readonly args: readonly string[]; readonly cwd: string }) {
    const traced = startTracedPi({
      launch: { piPath: tools.pi.piPath, args: [...launch.args], cwd: launch.cwd },
      deps: createPiDeps({
        clock: options.clock,
        resources: options.resources,
        logger: options.logger,
        env: tools.env,
      }),
      tracer: options.tracer,
    });
    const pi = traced.process;
    if (closed) {
      // The host began closing while this session was being set up; `close` has already stopped
      // every pi it knew of, so this one stops itself.
      await pi.stop();
      throw new CommandError("pi_unavailable", { status: "exited" });
    }
    running.add(pi);
    // Fire and forget: `exited` never rejects.
    void pi.exited.then(() => running.delete(pi));
    /**
     * Reads the session's entries after `since`, or all of them.
     *
     * @remarks
     * pi's leaf is the one it reports, not the last entry (domain-model §2).
     *
     * @sideEffects Calls pi.
     * @param since - The last entry already read.
     * @returns The entries, converted, and the leaf.
     */
    const getEntries = async (since: string | undefined): Promise<EntriesPage> => {
      const data = await traced.request(since === undefined ? { type: "get_entries" } : { type: "get_entries", since });
      return { entries: data.entries.map(toLogEntry), leafId: data.leafId };
    };
    let sessionId: string;
    let entries: EntriesPage;
    try {
      ({ sessionId } = await traced.request({ type: "get_state" }));
      entries = await getEntries(undefined);
    } catch (error) {
      await pi.stop();
      // pi exits at once when it has no model to use; the UI explains that from the status.
      if (error instanceof PiRequestError) {
        const exited = error.reason === "exited" || error.reason === "stopped";
        throw new CommandError("pi_unavailable", { status: exited ? "exited" : "unresponsive" });
      }
      throw error;
    }
    // A session started again continues past its old controller's epoch, so clients still
    // showing the old one see the change and take a fresh snapshot (domain-model §7).
    const previous = sessions.get(sessionId)?.controller.snapshot().epoch ?? 0;
    const starts = await options.turnStarts?.(sessionId).catch((error: unknown) => {
      options.logger.warn({ ...failureFields(error), sessionId }, "turn starts could not be read");
      return undefined;
    });
    const controller = createSessionController({
      sessionId,
      epoch: previous + 1,
      pi: {
        onEvent: (listener) => pi.onEvent(listener),
        exited: pi.exited,
        // No deadline: pi answers only after its preparations, which may include compacting.
        prompt: (message) => traced.request({ type: "prompt", message }, { timeoutMs: null }),
        getEntries,
        stop: () => pi.stop(),
      },
      entries,
      publish: (event) => {
        options.subscriptions.publish(event);
        observe(sessionId, event);
      },
      clock: options.clock,
      newId: options.newId,
      onRefreshFailed: (error) =>
        options.logger.warn({ ...failureFields(error), sessionId }, "transcript refresh failed"),
      ...(starts === undefined
        ? {}
        : {
            turnStarts: {
              opened: starts.opened,
              record: (entryIds: readonly string[]) => inBackground("turn starts", () => starts.record(entryIds)),
            },
          }),
    });
    const started: Running = { controller, pi: traced };
    sessions.set(sessionId, started);
    for (const viewer of options.subscriptions.viewers(sessionId)) {
      options.subscriptions.sendTo(viewer, controller.snapshot());
    }
    return { sessionId, started };
  }

  /**
   * Makes sure a known session's pi runs, starting it if needed.
   *
   * @remarks
   * A session on file starts with `--session <file>` in the directory it recorded, which must
   * still exist (domain-model §1); a draft starts with `--session-id <id>`. Concurrent calls for
   * one session share one start.
   *
   * @sideEffects May spawn pi.
   * @param sessionId - The session.
   * @returns The running session.
   * @throws {CommandError} `session_not_found` for an unknown or missing session,
   * `session_cwd_missing` when its directory is gone, `pi_unavailable` when pi cannot run it.
   */
  async function ensureRunning(sessionId: string): Promise<Running> {
    const now = live(sessionId);
    if (now !== undefined) return now;
    const going = starting.get(sessionId);
    if (going !== undefined) return going;
    /**
     * Starts the session's pi.
     *
     * @remarks
     * See `ensureRunning`.
     *
     * @sideEffects Spawns pi.
     * @returns The running session.
     */
    const start = async (): Promise<Running> => {
      const entry = entryOf(sessionId);
      const tools = await readyTools();
      if (entry.state === "missing") throw new CommandError("session_not_found", { sessionId });
      const directory = await stat(entry.cwd).catch(() => null);
      if (directory?.isDirectory() !== true) throw new CommandError("session_cwd_missing", { cwd: entry.cwd });
      const args = entry.file === null ? ["--session-id", sessionId] : ["--session", entry.file];
      return (await startPi(tools, { args, cwd: entry.cwd })).started;
    };
    const started = start().finally(() => starting.delete(sessionId));
    starting.set(sessionId, started);
    return started;
  }

  /**
   * Creates a session in a directory, records it and opens it as the client's active tab.
   *
   * @remarks
   * See `createSessionManager`.
   *
   * @sideEffects Spawns pi; writes the index.
   * @param clientId - The client.
   * @param containerId - Where the session goes.
   * @param cwd - Its working directory.
   * @returns The new session's id.
   */
  async function create(clientId: string, containerId: string, cwd: string): Promise<string> {
    const tools = await readyTools();
    const { sessionId } = await startPi(tools, { args: [], cwd });
    await options.catalog.record({ sessionId, containerId, cwd });
    await options.layouts.open(clientId, containerId, sessionId);
    options.onChange();
    return sessionId;
  }

  /**
   * Stops a session's pi, if it runs.
   *
   * @remarks
   * Subscribers see a requested exit.
   *
   * @sideEffects Stops pi.
   * @param sessionId - The session.
   */
  async function stopSession(sessionId: string): Promise<void> {
    await live(sessionId)?.controller.stop();
  }

  return {
    async createChat(clientId) {
      const cwd = join(options.chatsRoot, options.newId());
      await mkdir(cwd, { recursive: true });
      try {
        return { sessionId: await create(clientId, CHATS, cwd) };
      } catch (error) {
        // Only the directory just made, and only while empty.
        await rmdir(cwd).catch(() => undefined);
        throw error;
      }
    },
    async createSession(clientId, workspaceId) {
      const dir = options.workspaces.dirOf(workspaceId);
      if (dir === undefined) throw new CommandError("workspace_not_found", { workspaceId });
      return { sessionId: await create(clientId, workspaceId, dir) };
    },
    async openSession(clientId, sessionId) {
      await options.catalog.ready();
      const entry = entryOf(sessionId);
      // The tab opens first, so a session that cannot start explains why in its own tab.
      await options.layouts.open(clientId, entry.containerId, sessionId);
      options.onChange();
      if (entry.state !== "draft" || sessions.has(sessionId)) await ensureRunning(sessionId);
      return {};
    },
    async closeTab(clientId, sessionId) {
      await options.layouts.close(clientId, sessionId);
      options.onChange();
      if (options.catalog.find(sessionId)?.state !== "draft") return {};
      // A message may be on its way, or its file just written: look again before discarding.
      await options.catalog.scan();
      const entry = options.catalog.find(sessionId);
      const empty = (sessions.get(sessionId)?.controller.snapshot().items.length ?? 0) === 0;
      const busyNow = starting.has(sessionId) || (prompting.get(sessionId) ?? 0) > 0;
      if (entry?.state === "draft" && empty && !busyNow && !options.layouts.isOpen(sessionId)) {
        await stopSession(sessionId);
        sessions.delete(sessionId);
        await options.catalog.forget(sessionId);
        // Only a chat's own directory, and only while empty (domain-model, "已决定 13").
        if (entry.containerId === CHATS) await rmdir(entry.cwd).catch(() => undefined);
        options.onChange();
      }
      return {};
    },
    async selectContainer(clientId, containerId) {
      await options.layouts.select(clientId, containerId);
      options.onChange();
      return {};
    },
    async archiveSession(sessionId) {
      entryOf(sessionId);
      await stopSession(sessionId);
      await options.catalog.archive(sessionId);
      await options.layouts.forgetSessions([sessionId]);
      options.onChange();
      return {};
    },
    async renameSession(sessionId, name) {
      await options.catalog.ready();
      // pi writes no file before the first message, so a draft's name has nowhere to go.
      if (entryOf(sessionId).state === "draft") throw new CommandError("session_is_draft", { sessionId });
      const { pi } = await ensureRunning(sessionId);
      await pi.request({ type: "set_session_name", name });
      inBackground("session scan", () => options.catalog.scan());
      return {};
    },
    async subscribe(connectionId, sessionIds) {
      await options.catalog.ready();
      const snapshots = new Map<string, SessionSnapshotEvent>();
      for (const sessionId of sessionIds) {
        const controller = sessions.get(sessionId)?.controller;
        if (controller !== undefined) {
          snapshots.set(sessionId, controller.snapshot());
        } else if (entryOf(sessionId).state === "draft") {
          snapshots.set(sessionId, draftSnapshot(sessionId));
        }
        // A session on file whose pi has not started yet is watched already; its snapshot follows
        // once `open_session` or a message starts it (SPEC-0001, "项目、工作区与会话").
      }
      for (const sessionId of options.subscriptions.subscribe(connectionId, sessionIds)) {
        const snapshot = snapshots.get(sessionId);
        if (snapshot !== undefined) options.subscriptions.sendTo(connectionId, snapshot);
      }
      return {};
    },
    async prompt(command) {
      const { sessionId } = command;
      prompting.set(sessionId, (prompting.get(sessionId) ?? 0) + 1);
      try {
        await options.catalog.ready();
        entryOf(sessionId);
        // A session whose pi is not running, a restored draft among them, starts on its message.
        const session = live(sessionId) ?? (await ensureRunning(sessionId));
        return await session.controller.prompt(command);
      } finally {
        const left = (prompting.get(sessionId) ?? 1) - 1;
        if (left === 0) prompting.delete(sessionId);
        else prompting.set(sessionId, left);
      }
    },
    async fetchStep(command) {
      return controllerOf(command.sessionId).fetchStep(command);
    },
    async fetchTranscript(command) {
      return controllerOf(command.sessionId).fetchTranscript(command);
    },
    summaries() {
      return options.catalog
        .list()
        .map(({ cwd: _cwd, ...entry }) => ({ ...entry, running: busy.has(entry.sessionId) }));
    },
    async forgetWorkspaces(workspaceIds) {
      const gone = options.catalog.list().filter((entry) => workspaceIds.includes(entry.containerId));
      await Promise.all(gone.map((entry) => stopSession(entry.sessionId)));
      await options.layouts.forgetContainers(workspaceIds);
      options.onChange();
    },
    rescan() {
      inBackground("session scan", () => options.catalog.scan());
    },
    async close() {
      closed = true;
      await Promise.all([...running].map((pi) => pi.stop()));
      await Promise.all(background);
    },
  };

  /**
   * Finds a session's controller.
   *
   * @remarks
   * Only a session that has had a pi has one.
   *
   * @sideEffects none
   * @param sessionId - The id.
   * @returns The controller.
   * @throws {CommandError} `session_not_found` when there is none.
   */
  function controllerOf(sessionId: string): SessionController {
    const controller = sessions.get(sessionId)?.controller;
    if (controller === undefined) throw new CommandError("session_not_found", { sessionId });
    return controller;
  }
}

/**
 * The snapshot of a draft whose pi has not started.
 *
 * @remarks
 * Epoch 0, so the snapshot sent once pi starts (epoch 1) replaces it.
 *
 * @sideEffects none
 * @param sessionId - The draft.
 * @returns An empty snapshot.
 */
function draftSnapshot(sessionId: string): SessionSnapshotEvent {
  return {
    type: "session_snapshot",
    sessionId,
    epoch: 0,
    seq: 0,
    traceId: null,
    items: [],
    hasOlder: false,
    run: null,
    exited: false,
  };
}

/**
 * What to log about a failure in the background or a refresh.
 *
 * @remarks
 * A failed pi request is logged by its command and reason only: its `detail` holds pi's own text
 * or the end of its stderr, which may carry secrets (security.md, "凭据与日志"). Anything else is
 * a host bug and logged whole.
 *
 * @sideEffects none
 * @param error - What was thrown.
 * @returns The log fields.
 */
function failureFields(error: unknown): Record<string, unknown> {
  if (error instanceof PiRequestError) return { command: error.command, reason: error.reason };
  return { err: error };
}
