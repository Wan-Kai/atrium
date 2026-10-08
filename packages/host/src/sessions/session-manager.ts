import {
  type PiInspection,
  PiRequestError,
  type SessionFileInfo,
  listSessionFiles,
  sessionsDirectory,
  toLogEntry,
} from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import type { Tracer } from "@opentelemetry/api";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../platform/clock";
import type { Logger } from "../platform/logger";
import { createPiDeps } from "../platform/pi-deps";
import type { ResourceTracker } from "../platform/resources";
import type { SubscriptionRegistry } from "../sync/subscriptions";
import type { EntriesPage } from "../transcript/session-transcript";
import { type SessionController, createSessionController } from "./session-controller";
import type { SessionCommands } from "./session-commands";
import { startTracedPi } from "./traced-pi";

/** What the host found out about pi; `null` when detection did not finish. */
export interface SessionTools {
  readonly env: Readonly<Record<string, string>>;
  readonly pi: PiInspection;
}

/** The session layer: every session's controller, and the session commands. */
export interface SessionManager extends SessionCommands {
  /** Stops every pi; resolves once all have exited. */
  close(): Promise<void>;
}

/**
 * Creates the session manager.
 *
 * @remarks
 * `create_chat` makes a directory under `~/.atrium/chats/` and starts pi in it at once
 * (domain-model, "已决定 9"); recording chats in the index comes with M1.5. M1.4's temporary
 * entry to history (SPEC-0001, "打开历史会话"): `list_recent_sessions` reads pi's session
 * directory, `open_session` starts pi on a session's file, or returns the session if it is open
 * and its pi still runs. pi must have been found and be usable; otherwise the command fails with
 * `pi_unavailable` and pi's status, which the UI explains. Subscribing sends each newly watched
 * session's snapshot to that connection before any later event (domain-model §7).
 *
 * @sideEffects none until a command arrives; then reads pi's session directory, creates
 * directories, spawns pi and publishes.
 * @param options - Atrium's home, the detected tools, the subscription registry, and the host's
 * clock, resources, tracer, logger and id source.
 * @returns The manager.
 */
export function createSessionManager(options: {
  readonly home: string;
  readonly tools: Promise<SessionTools | null>;
  readonly subscriptions: SubscriptionRegistry;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly newId: () => string;
}): SessionManager {
  const sessions = new Map<string, SessionController>();
  /** Every pi started, including one still reporting its session id, so `close` stops them all. */
  const running = new Set<{ stop(): Promise<unknown> }>();
  /** Set by `close`; a chat being created then stops its pi instead of keeping it. */
  let closed = false;
  /** Session files the recent list showed, by session id. */
  const listed = new Map<string, SessionFileInfo>();
  /** Sessions being opened, so a second `open_session` waits for the first. */
  const opening = new Map<string, Promise<string>>();

  /**
   * Finds a session.
   *
   * @remarks
   * Clients name sessions by id; an unknown id is the client's mistake, not a host failure.
   *
   * @sideEffects none
   * @param sessionId - The id.
   * @returns The controller.
   * @throws {CommandError} `session_not_found` when there is no such session.
   */
  function controllerOf(sessionId: string): SessionController {
    const controller = sessions.get(sessionId);
    if (controller === undefined) throw new CommandError("session_not_found", { sessionId });
    return controller;
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
  async function readyTools(): Promise<SessionTools & { readonly pi: Extract<PiInspection, { status: "ready" }> }> {
    const tools = await options.tools;
    if (tools?.pi.status !== "ready") {
      throw new CommandError("pi_unavailable", { status: tools?.pi.status ?? "unknown" });
    }
    return { env: tools.env, pi: tools.pi };
  }

  /**
   * Starts pi for a session and puts a controller in charge of it.
   *
   * @remarks
   * The session's id is the one pi reports (domain-model, "已决定 2"); its entries are read at
   * once, so the first snapshot already holds the transcript. A pi that cannot report its session
   * is stopped, never left running unowned; one started while the host closes stops itself.
   *
   * @sideEffects Spawns pi; registers the controller.
   * @param tools - The tools to start pi with.
   * @param launch - pi's arguments and working directory.
   * @returns The session's id.
   * @throws {CommandError} `pi_unavailable` when pi exits or does not answer.
   */
  async function startSession(
    tools: SessionTools & { readonly pi: Extract<PiInspection, { status: "ready" }> },
    launch: { readonly args: readonly string[]; readonly cwd: string },
  ): Promise<string> {
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
    sessions.set(
      sessionId,
      createSessionController({
        sessionId,
        pi: {
          onEvent: (listener) => pi.onEvent(listener),
          exited: pi.exited,
          // No deadline: pi answers only after its preparations, which may include compacting.
          prompt: (message) => traced.request({ type: "prompt", message }, { timeoutMs: null }),
          getEntries,
          stop: () => pi.stop(),
        },
        entries,
        publish: (event) => options.subscriptions.publish(event),
        clock: options.clock,
        newId: options.newId,
        onRefreshFailed: (error) => options.logger.warn({ err: error, sessionId }, "transcript refresh failed"),
      }),
    );
    return sessionId;
  }

  /**
   * Finds a session's file in pi's session directory.
   *
   * @remarks
   * The files the last list showed are known already; any other is looked for in the whole
   * directory.
   *
   * @sideEffects Reads pi's session directory when the file is not known.
   * @param env - pi's environment.
   * @param sessionId - The session.
   * @returns The file, or `undefined`.
   */
  async function findSessionFile(env: Readonly<Record<string, string>>, sessionId: string) {
    const known = listed.get(sessionId);
    if (known !== undefined) return known;
    const files = await listSessionFiles(await sessionsDirectory(env), Number.MAX_SAFE_INTEGER);
    return files.find((file) => file.sessionId === sessionId);
  }

  return {
    async createChat() {
      const tools = await readyTools();
      const cwd = join(options.home, "chats", options.newId());
      await mkdir(cwd, { recursive: true });
      return { sessionId: await startSession(tools, { args: [], cwd }) };
    },
    async listRecentSessions(limit) {
      const tools = await options.tools;
      if (tools === null) return { sessions: [] };
      const files = await listSessionFiles(await sessionsDirectory(tools.env), limit);
      for (const file of files) listed.set(file.sessionId, file);
      return {
        sessions: files.map((file) => ({
          sessionId: file.sessionId,
          firstPrompt: file.firstPrompt,
          modifiedAt: file.modifiedAt,
        })),
      };
    },
    async openSession(sessionId) {
      const open = sessions.get(sessionId);
      if (open !== undefined && !open.snapshot().exited) return { sessionId };
      const going = opening.get(sessionId);
      if (going !== undefined) return { sessionId: await going };
      /**
       * Starts pi on the session's file.
       *
       * @remarks
       * `pi --session <file>` in the directory the session recorded (SPEC-0001, "打开历史会话").
       *
       * @sideEffects Reads pi's session directory; spawns pi.
       * @returns The session's id.
       */
      const start = async (): Promise<string> => {
        const tools = await readyTools();
        const file = await findSessionFile(tools.env, sessionId);
        if (file === undefined) throw new CommandError("session_not_found", { sessionId });
        return startSession(tools, { args: ["--session", file.path], cwd: file.cwd });
      };
      const started = start().finally(() => opening.delete(sessionId));
      opening.set(sessionId, started);
      return { sessionId: await started };
    },
    async subscribe(connectionId, sessionIds) {
      const controllers = sessionIds.map((sessionId) => controllerOf(sessionId));
      for (const sessionId of options.subscriptions.subscribe(connectionId, sessionIds)) {
        const controller = controllers.find((candidate) => candidate.sessionId === sessionId);
        if (controller !== undefined) options.subscriptions.sendTo(connectionId, controller.snapshot());
      }
      return {};
    },
    async prompt(command) {
      return controllerOf(command.sessionId).prompt(command);
    },
    async fetchTranscript(command) {
      return controllerOf(command.sessionId).fetchTranscript(command);
    },
    async close() {
      closed = true;
      await Promise.all([...running].map((pi) => pi.stop()));
    },
  };
}
