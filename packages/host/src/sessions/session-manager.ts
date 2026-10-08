import { type PiInspection, PiRequestError, toLogEntry } from "@atrium/pi";
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
 * M1.3's minimal form (SPEC-0001, "M1.3 先做的部分"): `create_chat` makes a directory under
 * `~/.atrium/chats/` and starts pi in it at once (domain-model, "已决定 9"); the session's id is
 * the one pi reports (domain-model, "已决定 2"). Recording chats in the index comes with M1.5.
 * pi must have been found and be usable; otherwise the command fails with `pi_unavailable` and
 * pi's status, which the UI explains. Subscribing sends each newly watched session's snapshot to
 * that connection before any later event (domain-model §7).
 *
 * @sideEffects none until a command arrives; then creates directories, spawns pi and publishes.
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

  return {
    async createChat() {
      const tools = await options.tools;
      if (tools?.pi.status !== "ready") {
        throw new CommandError("pi_unavailable", { status: tools?.pi.status ?? "unknown" });
      }
      const cwd = join(options.home, "chats", options.newId());
      await mkdir(cwd, { recursive: true });
      const traced = startTracedPi({
        launch: { piPath: tools.pi.piPath, args: [], cwd },
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
        // The host began closing while this chat was being set up; `close` has already stopped
        // every pi it knew of, so this one stops itself.
        await pi.stop();
        throw new CommandError("pi_unavailable", { status: "exited" });
      }
      running.add(pi);
      // Fire and forget: `exited` never rejects.
      void pi.exited.then(() => running.delete(pi));
      let sessionId: string;
      let entries: EntriesPage;
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
        const data = await traced.request(
          since === undefined ? { type: "get_entries" } : { type: "get_entries", since },
        );
        return { entries: data.entries.map(toLogEntry), leafId: data.leafId };
      };
      try {
        ({ sessionId } = await traced.request({ type: "get_state" }));
        entries = await getEntries(undefined);
      } catch (error) {
        // A pi that cannot report its session is of no use; it must not keep running unowned.
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
      return { sessionId };
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
