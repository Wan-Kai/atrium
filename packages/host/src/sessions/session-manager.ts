import {
  FAST_COMMAND,
  type PiInspection,
  PiRequestError,
  isFastSwitch,
  piStatsOf,
  runOneShot,
  sessionModelOf,
  toLogEntry,
  toSlashCommand,
} from "@atrium/pi";
import {
  type Attention,
  CommandError,
  IDLE_CONTROL,
  type ModelRef,
  type SessionEvent,
  type SessionModel,
  type SessionSnapshotEvent,
  type SessionSummary,
  type ThinkingLevel,
  UNKNOWN_METRICS,
  isChatId,
} from "@atrium/protocol";
import type { Tracer } from "@opentelemetry/api";
import { mkdir, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import { createPiDeps } from "../platform/pi-deps";
import type { ResourceTracker } from "../platform/resources";
import type { SubscriptionRegistry } from "../sync/subscriptions";
import type { EntriesPage } from "../transcript/session-transcript";
import type { WorkspaceService } from "../workspaces/workspace-service";
import type { TurnStarts } from "../store/turn-starts";
import type { FileSearch } from "../files/file-search";
import type { Layouts } from "./layouts";
import { type CatalogEntry, chatIdOf, type SessionCatalog } from "./session-catalog";
import type { SessionCommands } from "./session-commands";
import {
  type PromptImage,
  type Respawned,
  type SessionController,
  type SessionPi,
  createSessionController,
} from "./session-controller";
import { type TitleSubject, createTitleGenerator, firstExchange, titleInput } from "./titles";
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
  /** Stops the pi of every session with nothing going on; resolves once they have exited. */
  stopIdle(): Promise<void>;
  /** Stops every pi; resolves once all have exited and background scans have stopped. */
  close(): Promise<void>;
}

/** A pi that is running a session, with what the manager does with it. */
interface Running {
  readonly controller: SessionController;
  /** The session's current pi; replaced when it starts again. */
  pi: TracedPi;
}

/** A model to set on a pi just started, with its thinking level when one is known. */
interface StartModel {
  readonly model: ModelRef;
  readonly thinkingLevel: ThinkingLevel | null;
}

/** How to start pi for a session. */
interface Launch {
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * The model to set once pi runs: the one chosen last for a session pi has written nothing of
   * yet, the session's own when such a session starts again, or `null` for pi's own.
   */
  readonly startOn: StartModel | null;
  /** Whether to switch Fast on once pi runs. */
  readonly fast: boolean;
}

/** The model new sessions start with, and where the model you choose in a session goes. */
export interface SessionModels {
  /** The model chosen last, with the thinking level remembered for it; `null` before any was chosen. */
  preferred(): StartModel | null;
  /** Told the model and level pi uses after you chose one in a session. */
  chosen(model: SessionModel): void;
}

/** Atrium's Fast extension, and the Fast sessions without their own start with (SPEC-0001, "Fast"). */
export interface SessionFast {
  /** The extension's file, which every session's pi loads with `--extension` (ADR-0008). */
  readonly extension: string;
  /** Fast as last switched in any session. */
  preferred(): boolean;
  /** Told Fast was switched in a session. */
  chosen(enabled: boolean): void;
}

/** pi, found and usable. */
type ReadyTools = SessionTools & { readonly pi: Extract<PiInspection, { status: "ready" }> };

/**
 * Switches Fast in a pi that lists Atrium's Fast switch.
 *
 * @remarks
 * pi runs an extension's command at once, even during a run, and answers `handled` with no turn
 * and no entry (pi-internals.md §5). Only for a pi that lists the switch: to any other the words
 * would be a message to the model (SPEC-0001, "Fast").
 *
 * @sideEffects Calls pi.
 * @param traced - The pi.
 * @param enabled - On or off.
 * @throws {PiRequestError} When pi does not answer, exits or refuses.
 */
async function switchFast(traced: TracedPi, enabled: boolean): Promise<void> {
  await traced.request({ type: "prompt", message: `/${FAST_COMMAND} ${enabled ? "on" : "off"}` });
}

/**
 * Creates the session manager.
 *
 * @remarks
 * Follows SPEC-0001 ("项目、工作区与会话") and domain-model §1:
 * - a new session or chat gets its id here, is recorded as a draft in its container and opens as
 *   the client's active tab at once; its pi starts in the background with `--session-id <id>`,
 *   and whatever needs it waits for that start (domain-model, "已决定 9, 14"); a new chat gets its
 *   own directory under the chats root, and later sessions of the chat start there too (ADR-0007);
 * - opening a session starts pi with `--session <file>` in the directory the session recorded,
 *   unless its pi runs; a draft restored after a restart starts with `--session-id <id>` on its
 *   first message (domain-model, "已决定 7");
 * - closing the last tab of a draft that never got a message discards it: its pi stops, its
 *   record goes, and when it was its chat's only session the chat's empty directory is removed
 *   (domain-model, "已决定 13");
 * - archiving hides a session and stops its pi;
 * - a client's tab and place changes take effect in the order its commands came, at once for a
 *   session the index knows; one it does not know yet waits for the first scan, and a tab closed
 *   meanwhile must not open again; once closing, queued changes do nothing;
 * - the client goes to a new session's tab only if it stayed where it was when it asked;
 * - pi must have been found and be usable; otherwise starting fails with `pi_unavailable` and
 *   pi's status, which the UI explains; a new session's start in the background failing is only
 *   logged, and its next open, message or command starts it again;
 * - which user messages opened turns is kept per session (`turnStarts`), so a later host
 *   rebuilds steers and turns as they were (SPEC-0001, `steer`);
 * - a session pi has written nothing of starts on the model chosen last, with the thinking level
 *   remembered for it, set through pi's commands rather than `--model`, which makes pi exit when it
 *   cannot find the model; a remembered model pi refuses leaves pi's own; such a session started
 *   again goes back to the model it had, which its new pi would not know; a model chosen in any
 *   session is reported to `models` (SPEC-0001, "模型与输入框");
 * - every session's pi loads Atrium's Fast extension, given `fast`; once it runs, the host checks
 *   pi lists the extension's switch and, if the session's Fast is on, switches it on. Without the
 *   switch, which is logged, nothing is sent and Fast is unavailable on that pi, as it is without
 *   `fast`: words pi does not know as a command would go to the model. A session's Fast is its
 *   controller's, else its record's, else the one last chosen; a switch is recorded for the
 *   session and reported to `fast` (SPEC-0001, "Fast").
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
 * logger and id sources.
 * @returns The manager.
 */
export function createSessionManager(options: {
  readonly chatsRoot: string;
  /** The tools as last detected; asked again whenever pi starts, so a refresh reaches new pi processes. */
  readonly tools: () => Promise<SessionTools | null>;
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
  /** Makes a new session's id, which pi takes with `--session-id` (pi-internals §1). */
  readonly newSessionId: () => string;
  /** Loads a session's turn starts (`turns/<session id>.json`); without it they live in memory. */
  readonly turnStarts?: (sessionId: string) => Promise<TurnStarts>;
  /** The model new sessions start with; without it pi picks its own and choices go nowhere. */
  readonly models?: SessionModels;
  /** The file search behind `@`; without it every search answers `fd_missing`. */
  readonly files?: FileSearch;
  /**
   * The title model chosen in the settings, if pi can use it in a directory (`createTitleGenerator`);
   * without it titles are made on each session's own model.
   */
  readonly titleModel?: (cwd: string, signal: AbortSignal) => Promise<ModelRef | null>;
  /** Atrium's Fast extension and the Fast new sessions start with; without it pi loads none and there is no Fast. */
  readonly fast?: SessionFast;
}): SessionManager {
  const sessions = new Map<string, Running>();
  /** Releases each held controller's count, so a leak test sees controllers nobody lets go of. */
  const held = new Map<string, () => void>();
  /** The clock for controllers, whose timers count as open resources (testing.md, "泄漏"). */
  const timers: Clock = {
    now: () => options.clock.now(),
    setTimeout: (callback, ms) => trackedTimeout(options.clock, options.resources, callback, ms),
  };
  /** Every pi started, including one still reading its session, so `close` stops them all. */
  const running = new Set<{ stop(): Promise<unknown> }>();
  /** Sessions with a run in progress. */
  const busy = new Set<string>();
  /** pi's text of each session's last failed turn in the run in progress. */
  const failures = new Map<string, string>();
  /** Sessions marked for attention since their last run started, so a mark is set once. */
  const marked = new Set<string>();
  /** Sessions renamed here, which have a name before a scan finds it in their files. */
  const renamed = new Set<string>();
  /** When each of a session's unanswered dialogs appeared, as the host saw it, by dialog id. */
  const asking = new Map<string, ReadonlyMap<string, number>>();
  /** `prompt`s on their way, by session, so a draft is not discarded under one. */
  const prompting = new Map<string, number>();
  /** Drafts created by this host, which start on open, unlike drafts restored (domain-model, "已决定 7, 9"). */
  const created = new Set<string>();
  /** Sessions being started, so a second start waits for the first. */
  const starting = new Map<string, Promise<Running>>();
  /** Background work, such as scans after a run, that `close` waits for. */
  const background = new Set<Promise<void>>();
  /** Set by `close`; a session being started then stops its pi instead of keeping it. */
  let closed = false;
  /** Each session's `@` search under way, which the next one calls off. */
  const searches = new Map<string, AbortController>();
  /** Each client's last tab or place change, which the next one waits for. */
  const clientTurns = new Map<string, Promise<unknown>>();
  /** Each session's last hand-off or take-back, which the next one waits for. */
  const handTurns = new Map<string, Promise<unknown>>();

  /**
   * Runs a change to a client's tabs or place after the changes it asked for earlier.
   *
   * @remarks
   * Commands run at once, and opening a session the index does not know yet waits for the first
   * scan; without this a tab the client closed during that wait would open again when it ends. A
   * failed change does not hold up the next. Once the manager closes, a change that has not
   * started does nothing, so nothing is written after the index's last write.
   *
   * @sideEffects Runs `change` once the client's earlier changes are done, unless closed by then.
   * @param clientId - The client.
   * @param change - The change.
   * @returns What the change returns, or `undefined` when closed first.
   */
  async function inClientOrder<T>(clientId: string, change: () => Promise<T>): Promise<T | undefined> {
    const turn = (clientTurns.get(clientId) ?? Promise.resolve()).then(() => (closed ? undefined : change()));
    const settled = turn.catch(() => undefined);
    clientTurns.set(clientId, settled);
    try {
      return await turn;
    } finally {
      // Stryker disable next-line ConditionalExpression,BlockStatement: only frees memory; a settled turn holds up nothing.
      if (clientTurns.get(clientId) === settled) clientTurns.delete(clientId);
    }
  }

  /**
   * Runs a session's hand-off or take-back after the one asked for before it.
   *
   * @remarks
   * SPEC-0001 ("交给终端"): a take-back while the hand-off still stops pi would find that pi
   * running, start none, and let the next message start one beside pi in the terminal. A failed
   * one does not hold up the next.
   *
   * @sideEffects Runs `work` once the session's earlier hand-off or take-back is done.
   * @param sessionId - The session.
   * @param work - The hand-off or take-back.
   * @returns What `work` returns.
   */
  async function inHandOrder<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const turn = (handTurns.get(sessionId) ?? Promise.resolve()).then(work);
    const settled = turn.catch(() => undefined);
    handTurns.set(sessionId, settled);
    try {
      return await turn;
    } finally {
      // Stryker disable next-line ConditionalExpression,BlockStatement: only frees memory; a settled turn holds up nothing.
      if (handTurns.get(sessionId) === settled) handTurns.delete(sessionId);
    }
  }

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
    // A session whose pi is being started again counts as running: nothing else may start one.
    return found === undefined || (found.controller.exited && !found.controller.restarting) ? undefined : found;
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
    const tools = await options.tools();
    if (tools?.pi.status !== "ready") {
      throw new CommandError("pi_unavailable", { status: tools?.pi.status ?? "unknown" });
    }
    return { env: tools.env, pi: tools.pi };
  }

  /**
   * Since when a session's oldest unanswered dialog waits.
   *
   * @remarks
   * SPEC-0001 ("会话状态"): once an older dialog is answered, the oldest still open counts.
   *
   * @sideEffects none
   * @param sessionId - The session.
   * @returns The time, or `null` when no dialog waits.
   */
  function askingSince(sessionId: string): number | null {
    const open = asking.get(sessionId);
    return open === undefined ? null : Math.min(...open.values());
  }

  /**
   * Sets or removes a session's attention in the index, in the background.
   *
   * @remarks
   * The catalog tells the list; a write that fails is logged.
   *
   * @sideEffects Writes `sessions.json` in the background.
   * @param sessionId - The session.
   * @param attention - The attention, or `null` to remove it.
   */
  function attend(sessionId: string, attention: Attention | null): void {
    inBackground("attention", () => options.catalog.mark(sessionId, { attention }));
  }

  /**
   * A session that needs a title now, if it does.
   *
   * @remarks
   * SPEC-0001 ("自动生成标题"): a session on file, without a name, not handed off, whose pi runs
   * on a known model, and whose first turn has text. The title is written through the same pi
   * only if, when it comes, the session still has no name, is not handed off and that pi still
   * runs; the list then learns the name from the session's file. A session renamed here counts as
   * named from then on, though no scan has found the name yet.
   *
   * @sideEffects none; the subject's `write` calls pi and scans the session files.
   * @param sessionId - The session.
   * @returns The subject, or `null`.
   */
  function titleSubject(sessionId: string): TitleSubject | null {
    const entry = options.catalog.find(sessionId);
    const found = live(sessionId);
    if (entry?.name !== null || entry.state !== "persisted" || entry.handedOff || found === undefined) return null;
    const model = found.controller.snapshot().model;
    const exchange = firstExchange(found.controller.items());
    if (model === null || exchange === null) return null;
    const { pi } = found;
    return {
      cwd: entry.cwd,
      model: { providerId: model.providerId, modelId: model.modelId },
      input: titleInput(exchange.user, exchange.reply),
      async write(title) {
        const now = options.catalog.find(sessionId);
        if (now?.name !== null || now.handedOff || renamed.has(sessionId) || live(sessionId)?.pi !== pi) return false;
        await pi.request({ type: "set_session_name", name: title });
        await options.catalog.scan();
        return true;
      },
    };
  }

  const titles = createTitleGenerator({
    subject: titleSubject,
    titleModel: options.titleModel ?? (async () => null),
    oneShot: async (request, signal) => {
      const tools = await readyTools();
      const deps = createPiDeps({
        clock: options.clock,
        resources: options.resources,
        logger: options.logger,
        env: tools.env,
      });
      return runOneShot({ piPath: tools.pi.piPath, ...request }, deps, { signal });
    },
    logger: options.logger,
  });

  /**
   * Keeps track of runs, failures and dialogs for the list, and looks at the session's files once
   * a run ends.
   *
   * @remarks
   * A draft's first message is in its file once pi reports it (SPEC-0001, "新建会话"), so the
   * list shows the session by its first message while that run goes on. A run's end may have
   * written the file, a name or commits in the workspace. A session needs a look from a run that
   * failed after pi's retries, or pi crashing too often, until its next run starts; a failure
   * whose text looks like a credentials problem asks to sign in (SPEC-0001, "会话状态"). A crash
   * also ends its run as failed but is not marked until the restarts are used up, so only a turn's
   * own failure marks a run. Once the scan after a run is done, the session may be given a title
   * (`titleSubject`).
   *
   * @sideEffects Updates the run, failure and dialog records; writes attention to the index; calls
   * `onChange`; may start background scans.
   * @param sessionId - The session.
   * @param event - An event it published.
   */
  function observe(sessionId: string, event: SessionEvent): void {
    if (event.type === "run_started") {
      busy.add(sessionId);
      failures.delete(sessionId);
      marked.delete(sessionId);
      if ((options.catalog.find(sessionId)?.attention ?? null) !== null) attend(sessionId, null);
      options.onChange();
    } else if (event.type === "turn_started") {
      // pi writes the message to the file before it reports it; the draft becomes a session now.
      if (options.catalog.find(sessionId)?.state === "draft")
        inBackground("session scan", () => options.catalog.scan());
    } else if (event.type === "turn_finished") {
      if (event.outcome === "failed" && event.error !== null) failures.set(sessionId, event.error);
    } else if (event.type === "control_updated") {
      if (event.control.failure !== null && !marked.has(sessionId)) {
        marked.add(sessionId);
        attend(sessionId, { reason: "error", at: options.clock.now(), cleared: false });
      }
      const shown = askingSince(sessionId);
      const seen = asking.get(sessionId);
      const open = new Map(event.control.interactions.map(({ id }) => [id, seen?.get(id) ?? options.clock.now()]));
      if (open.size > 0) asking.set(sessionId, open);
      else asking.delete(sessionId);
      if (askingSince(sessionId) !== shown) options.onChange();
    } else if (event.type === "run_settled" || event.type === "session_exited") {
      const ran = busy.delete(sessionId);
      const failure = failures.get(sessionId);
      if (
        event.type === "run_settled" &&
        event.outcome === "failed" &&
        failure !== undefined &&
        !marked.has(sessionId)
      ) {
        marked.add(sessionId);
        attend(sessionId, {
          reason: isAuthFailure(failure) ? "auth" : "error",
          at: options.clock.now(),
          cleared: false,
        });
      }
      if (event.type === "session_exited" && asking.delete(sessionId)) options.onChange();
      if (ran || event.type === "run_settled") options.onChange();
      if (event.type === "run_settled") {
        const containerId = options.catalog.find(sessionId)?.containerId;
        if (containerId !== undefined && !isChatId(containerId)) options.workspaces.refresh(containerId);
        inBackground("session scan", async () => {
          await options.catalog.scan();
          // After the scan, which finds the file a first run wrote.
          titles.settled(sessionId);
        });
      }
    }
  }

  /**
   * Starts pi and reads what it knows of its session.
   *
   * @remarks
   * pi is started for a session the host knows, by its file or its id (domain-model, "已决定 2");
   * automatic retries are turned on; its entries are read at once, so the first snapshot already
   * holds the transcript. A pi that cannot report its session is stopped, never left running
   * unowned; one started while the host closes stops itself.
   *
   * @sideEffects Spawns pi.
   * @param tools - The tools to start pi with.
   * @param launch - pi's arguments and working directory.
   * @returns The traced pi, the controller's view of it, its model and its entries.
   * @throws {CommandError} `pi_unavailable` when pi exits or does not answer.
   */
  async function spawn(tools: ReadyTools, launch: Launch) {
    const traced = startTracedPi({
      launch: {
        piPath: tools.pi.piPath,
        args: [...launch.args, ...(options.fast === undefined ? [] : ["--extension", options.fast.extension])],
        cwd: launch.cwd,
      },
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
    let model: SessionModel | null;
    let entries: EntriesPage;
    let fastSwitch = false;
    try {
      // pi retries failed model calls itself unless the user's settings turned that off; the host
      // counts on it (SPEC-0001, "运行出错与停止").
      await traced.request({ type: "set_auto_retry", enabled: true });
      if (options.fast !== undefined) {
        fastSwitch = (await traced.request({ type: "get_commands" })).commands.some(isFastSwitch);
        if (!fastSwitch) options.logger.warn({}, "fast extension not loaded");
        if (fastSwitch && launch.fast) await switchFast(traced, true);
      }
      if (launch.startOn !== null) await startOnModel(traced, launch.startOn);
      model = sessionModelOf(await traced.request({ type: "get_state" }));
      entries = await getEntries(undefined);
    } catch (error) {
      await pi.stop();
      if (error instanceof PiRequestError) {
        const exited = error.reason === "exited" || error.reason === "stopped";
        throw new CommandError("pi_unavailable", { status: exited ? "exited" : "unresponsive" });
      }
      throw error;
    }
    const view: SessionPi = {
      onEvent: (listener) => pi.onEvent(listener),
      exited: pi.exited,
      // No deadline: pi answers only after its preparations, which may include compacting.
      prompt: (message, images) =>
        traced.request({ type: "prompt", message, ...piImages(images) }, { timeoutMs: null }),
      steer: (message, images) => traced.request({ type: "steer", message, ...piImages(images) }),
      clearQueue: () => traced.request({ type: "clear_queue" }),
      // No deadline: pi answers once it has stopped, which the controller waits for (SPEC-0001, "中断").
      abort: async () => {
        await traced.request({ type: "abort" }, { timeoutMs: null });
      },
      respond: (response) => pi.respond({ type: "extension_ui_response", ...response }),
      getEntries,
      model: async () => sessionModelOf(await traced.request({ type: "get_state" })),
      setModel: async ({ providerId, modelId }) => {
        await traced.request({ type: "set_model", provider: providerId, modelId });
      },
      setThinkingLevel: async (level) => {
        await traced.request({ type: "set_thinking_level", level });
      },
      setFast: async (enabled) => {
        if (!fastSwitch) throw new CommandError("fast_unavailable");
        await switchFast(traced, enabled);
      },
      commands: async () =>
        (await traced.request({ type: "get_commands" })).commands.flatMap((command) => toSlashCommand(command) ?? []),
      stats: async () => piStatsOf(await traced.request({ type: "get_session_stats" })),
      stop: () => pi.stop(),
    };
    return { traced, view, entries, model, fast: launch.fast };
  }

  /**
   * Sets a new pi to a model, with its thinking level when one is given.
   *
   * @remarks
   * Through pi's commands, not `--model`: pi exits when it cannot find a model named on its
   * command line, and a remembered model may have lost its credentials since. pi refusing it
   * leaves pi's own model; only the command and reason are logged, as pi's text may carry
   * secrets (security.md, "凭据与日志").
   *
   * @sideEffects Calls pi; may log.
   * @param traced - The new pi.
   * @param start - The model and level.
   * @throws {PiRequestError} When pi does not answer or exits.
   */
  async function startOnModel(traced: TracedPi, start: StartModel): Promise<void> {
    try {
      const { providerId, modelId } = start.model;
      await traced.request({ type: "set_model", provider: providerId, modelId });
      if (start.thinkingLevel !== null) {
        await traced.request({ type: "set_thinking_level", level: start.thinkingLevel });
      }
    } catch (error) {
      if (!(error instanceof PiRequestError) || error.reason !== "rejected") throw error;
      options.logger.warn({ ...failureFields(error) }, "remembered model not set");
    }
  }

  /**
   * Hands a started pi to its session: a new controller, or the one the session already has.
   *
   * @remarks
   * A session started again keeps its controller, which carries on in a new epoch so clients
   * still showing the old one take a fresh snapshot (domain-model §3, §7). A new controller's
   * snapshot goes to the session's current subscribers.
   *
   * @sideEffects Registers or updates the session; sends snapshots to its viewers.
   * @param sessionId - The session.
   * @param spawned - What `spawn` returned.
   * @returns The session.
   */
  async function connect(sessionId: string, spawned: Awaited<ReturnType<typeof spawn>>): Promise<Running> {
    const { traced, view, entries, model, fast } = spawned;
    const known = sessions.get(sessionId);
    if (known !== undefined) {
      if (!known.controller.exited) {
        // Another start handed the session its pi first; one session, one pi (pi-internals.md §3).
        await traced.process.stop();
        return known;
      }
      known.pi = traced;
      known.controller.attach({ pi: view, entries, model });
      return known;
    }
    const starts = await options.turnStarts?.(sessionId).catch((error: unknown) => {
      options.logger.warn({ ...failureFields(error), sessionId }, "turn starts could not be read");
      return undefined;
    });
    if (closed) {
      // The host began closing meanwhile: it stops this pi with every other it started, and a
      // controller made now would be kept by no one.
      throw new CommandError("pi_unavailable", { status: "exited" });
    }
    const controller = createSessionController({
      sessionId,
      pi: view,
      entries,
      publish: (event) => {
        options.subscriptions.publish(event);
        observe(sessionId, event);
      },
      clock: timers,
      newId: options.newId,
      onRefreshFailed: (error) =>
        options.logger.warn({ ...failureFields(error), sessionId }, "transcript refresh failed"),
      log: (level, message, fields) => options.logger[level]({ ...fields }, message),
      respawn: () => respawn(sessionId),
      model,
      onModelChosen: (chosen) => options.models?.chosen(chosen),
      fast,
      onFastChosen: (enabled) => {
        options.fast?.chosen(enabled);
        inBackground("fast record", () => options.catalog.mark(sessionId, { fast: enabled }));
      },
      ...(starts === undefined
        ? {}
        : {
            turnStarts: {
              opened: starts.opened,
              auto: starts.auto,
              record: (entryIds: readonly string[], autoIds: readonly string[]) =>
                inBackground("turn starts", () => starts.record(entryIds, autoIds)),
            },
          }),
    });
    const started: Running = { controller, pi: traced };
    hold(sessionId, started);
    for (const viewer of options.subscriptions.viewers(sessionId)) {
      options.subscriptions.sendTo(viewer, controller.snapshot());
    }
    return started;
  }

  /**
   * Starts a known session's pi again for its controller, after a crash or for "重试".
   *
   * @remarks
   * Started as `ensureRunning` would, and registered with it, so only one start per session is
   * ever under way (SPEC-0001, "运行控制"). When a start is already under way the controller gets
   * `null`: that start hands it its pi.
   *
   * @sideEffects Spawns pi; updates the session's pi.
   * @param sessionId - The session.
   * @returns The pi and its entries, or `null`.
   */
  async function respawn(sessionId: string): Promise<Respawned | null> {
    const going = starting.get(sessionId);
    if (going !== undefined) {
      await going.catch(() => undefined);
      return null;
    }
    const started = (async () => {
      const spawned = await spawn(await readyTools(), await launchOf(sessionId));
      const known = sessions.get(sessionId);
      if (known === undefined) throw new CommandError("session_not_found", { sessionId });
      known.pi = spawned.traced;
      return { running: known, spawned };
    })();
    const registered = started.then(({ running: known }) => known);
    starting.set(sessionId, registered);
    // Fire and forget: removing itself cannot fail.
    void registered.then(
      () => starting.delete(sessionId),
      () => starting.delete(sessionId),
    );
    const { spawned } = await started;
    return { pi: spawned.view, entries: spawned.entries, model: spawned.model };
  }

  /**
   * How to start pi for a known session.
   *
   * @remarks
   * A session on file starts with `--session <file>` in the directory it recorded, which must
   * still exist (domain-model §1); a draft starts with `--session-id <id>`. Its Fast is the one its
   * controller holds, else its record's, else the one last chosen (SPEC-0001, "Fast").
   *
   * @sideEffects Looks at the directory.
   * @param sessionId - The session.
   * @returns pi's arguments, working directory, the model to start on and whether Fast is on.
   * @throws {CommandError} `session_not_found` for an unknown or missing session,
   * `session_cwd_missing` when its directory is gone.
   */
  async function launchOf(sessionId: string): Promise<Launch> {
    const entry = entryOf(sessionId);
    if (entry.state === "missing") throw new CommandError("session_not_found", { sessionId });
    const directory = await stat(entry.cwd).catch(() => null);
    if (directory?.isDirectory() !== true) throw new CommandError("session_cwd_missing", { cwd: entry.cwd });
    const snapshot = sessions.get(sessionId)?.controller.snapshot();
    const fast = snapshot?.fast ?? fastOf(entry);
    if (entry.file !== null) return { args: ["--session", entry.file], cwd: entry.cwd, startOn: null, fast };
    // pi has written nothing of the session, so a new pi would not know the model it had.
    const had = snapshot?.model ?? null;
    const startOn =
      had === null
        ? (options.models?.preferred() ?? null)
        : { model: { providerId: had.providerId, modelId: had.modelId }, thinkingLevel: had.thinkingLevel };
    return { args: ["--session-id", sessionId], cwd: entry.cwd, startOn, fast };
  }

  /**
   * A session's Fast before its controller holds one.
   *
   * @remarks
   * Its record's, else the one last chosen; off without Fast (SPEC-0001, "Fast").
   *
   * @sideEffects none
   * @param entry - What the catalog knows of the session.
   * @returns Whether Fast is on.
   */
  function fastOf(entry: CatalogEntry): boolean {
    return entry.fast ?? options.fast?.preferred() ?? false;
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
      entryOf(sessionId);
      const tools = await readyTools();
      return connect(sessionId, await spawn(tools, await launchOf(sessionId)));
    };
    const started = start().finally(() => starting.delete(sessionId));
    starting.set(sessionId, started);
    return started;
  }

  /**
   * Creates a session in a directory, records it and opens it as the active tab of its container.
   *
   * @remarks
   * See `createSessionManager`.
   *
   * @sideEffects Writes the index; starts pi in the background.
   * @param clientId - The client.
   * @param containerId - Where the session goes.
   * @param cwd - Its working directory.
   * @returns The new session's id.
   */
  async function create(clientId: string, containerId: string, cwd: string): Promise<string> {
    const asked = options.layouts.of(clientId).container;
    const sessionId = options.newSessionId();
    await options.catalog.record({ sessionId, containerId, cwd });
    created.add(sessionId);
    // Started as a draft's: whatever needs pi meanwhile waits for this start.
    inBackground("session start", () => ensureRunning(sessionId));
    // In order from here: the client could not name the session before.
    await inClientOrder(clientId, async () => {
      const stayed = options.layouts.of(clientId).container === asked;
      await options.layouts.open(clientId, containerId, sessionId, stayed);
      options.onChange();
    });
    return sessionId;
  }

  /**
   * Keeps a session's controller, in place of any it had before.
   *
   * @remarks
   * Counted as `session.controller` (testing.md, "泄漏测试"): a controller holds the session's
   * transcript and its pi's process object, so one kept after the session went shows up there.
   *
   * @sideEffects Updates the sessions held and the resource counts.
   * @param sessionId - The session.
   * @param started - Its controller and pi.
   */
  function hold(sessionId: string, started: Running): void {
    held.get(sessionId)?.();
    held.set(sessionId, options.resources.acquire("session.controller"));
    sessions.set(sessionId, started);
  }

  /**
   * Lets go of a session's controller.
   *
   * @remarks
   * For a session no one will see again here: discarded, archived, or its workspace gone. An
   * exited controller is otherwise kept, so subscribers keep its state. What was kept of its runs
   * and names goes with it.
   *
   * @sideEffects Updates the sessions held, the run and name records and the resource counts.
   * @param sessionId - The session.
   */
  function forget(sessionId: string): void {
    held.get(sessionId)?.();
    held.delete(sessionId);
    sessions.delete(sessionId);
    // Stryker disable next-line all: only frees memory; a session forgotten here runs no more, and its next run would clear them first.
    for (const kept of [failures, marked, renamed, created]) kept.delete(sessionId);
  }

  /**
   * Stops a session's pi, if it runs.
   *
   * @remarks
   * Subscribers see a requested exit. A restart under way stops instead of carrying on; any other
   * start under way is waited for and its pi stopped, or it would come up for a session already
   * archived or gone (SPEC-0001, "项目、工作区与会话" and "一个会话只有一个 pi").
   *
   * @sideEffects Waits for a start under way; stops pi.
   * @param sessionId - The session.
   */
  async function stopSession(sessionId: string): Promise<void> {
    if (sessions.get(sessionId)?.controller.restarting !== true) {
      // A start that fails leaves nothing to stop.
      await starting.get(sessionId)?.catch(() => undefined);
    }
    // Also a session whose pi is being started again: the restart stops instead of carrying on.
    await sessions.get(sessionId)?.controller.shutdown();
  }

  return {
    async createChat(clientId) {
      const name = options.newId();
      const cwd = join(options.chatsRoot, name);
      await mkdir(cwd, { recursive: true });
      try {
        return { sessionId: await create(clientId, chatIdOf(name), cwd) };
      } catch (error) {
        // Only the directory just made, and only while empty.
        await rmdir(cwd).catch(() => undefined);
        throw error;
      }
    },
    async createSession(clientId, containerId) {
      if (isChatId(containerId)) {
        const chat = options.catalog.chats().find((candidate) => candidate.id === containerId);
        if (chat === undefined) throw new CommandError("chat_not_found", { chatId: containerId });
        return { sessionId: await create(clientId, containerId, chat.dir) };
      }
      const dir = options.workspaces.dirOf(containerId);
      if (dir === undefined) throw new CommandError("workspace_not_found", { workspaceId: containerId });
      return { sessionId: await create(clientId, containerId, dir) };
    },
    async openSession(clientId, sessionId) {
      const entry = await inClientOrder(clientId, async () => {
        if (options.catalog.find(sessionId) === undefined) await options.catalog.ready();
        // The scan may have ended because the host is closing.
        if (closed) return undefined;
        const found = entryOf(sessionId);
        // The tab opens first, so a session that cannot start explains why in its own tab.
        await options.layouts.open(clientId, found.containerId, sessionId);
        options.onChange();
        return found;
      });
      if (entry === undefined) return {};
      // Starting needs the session's file, which only a scan finds.
      await options.catalog.ready();
      const found = entryOf(sessionId);
      // A session handed off waits for "在 Atrium 里继续" (SPEC-0001, "交给终端").
      if (found.handedOff) return {};
      // A restored draft waits for its first message; one created here starts, or its start under
      // way is waited for.
      if (found.state !== "draft" || sessions.has(sessionId) || created.has(sessionId)) await ensureRunning(sessionId);
      return {};
    },
    async closeTab(clientId, sessionId) {
      await inClientOrder(clientId, async () => {
        await options.layouts.close(clientId, sessionId);
        options.onChange();
      });
      if (options.catalog.find(sessionId)?.state !== "draft") return {};
      // A message may be on its way, or its file just written: look again before discarding.
      await options.catalog.scan();
      const entry = options.catalog.find(sessionId);
      const empty = (sessions.get(sessionId)?.controller.snapshot().items.length ?? 0) === 0;
      // A start under way is no message: `stopSession` waits for it and stops its pi.
      const busyNow = (prompting.get(sessionId) ?? 0) > 0;
      if (entry?.state === "draft" && empty && !busyNow && !options.layouts.isOpen(sessionId)) {
        await stopSession(sessionId);
        forget(sessionId);
        await options.catalog.forget(sessionId);
        // Only a chat's own directory, only when no other session is in it, and only while empty
        // (domain-model, "已决定 13").
        const alone = !options.catalog.list().some((other) => other.containerId === entry.containerId);
        if (isChatId(entry.containerId) && alone) {
          await rmdir(entry.cwd).catch(() => undefined);
          // The chat goes with its directory.
          inBackground("session scan", () => options.catalog.scan());
        }
        options.onChange();
      }
      return {};
    },
    async selectContainer(clientId, containerId) {
      await inClientOrder(clientId, async () => {
        await options.layouts.select(clientId, containerId);
        options.onChange();
      });
      return {};
    },
    async archiveSession(sessionId) {
      entryOf(sessionId);
      await stopSession(sessionId);
      forget(sessionId);
      await options.catalog.archive(sessionId);
      await options.layouts.forgetSessions([sessionId]);
      options.onChange();
      return {};
    },
    async renameSession(sessionId, name) {
      await options.catalog.ready();
      // pi writes no file before the first message, so a draft's name has nowhere to go.
      if (entryOf(sessionId).state === "draft") throw new CommandError("session_is_draft", { sessionId });
      notHandedOff(sessionId);
      const { pi } = await ensureRunning(sessionId);
      renamed.add(sessionId);
      await pi.request({ type: "set_session_name", name });
      inBackground("session scan", () => options.catalog.scan());
      return {};
    },
    async subscribe(connectionId, sessionIds) {
      await options.catalog.ready();
      const snapshots = new Map<string, SessionSnapshotEvent>();
      for (const sessionId of sessionIds) {
        const controller = sessions.get(sessionId)?.controller;
        const entry = controller === undefined ? entryOf(sessionId) : null;
        if (controller !== undefined) {
          snapshots.set(sessionId, controller.snapshot());
        } else if (entry?.state === "draft") {
          snapshots.set(sessionId, draftSnapshot(sessionId, fastOf(entry)));
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
    async prompt(command, images) {
      const { sessionId } = command;
      prompting.set(sessionId, (prompting.get(sessionId) ?? 0) + 1);
      try {
        await options.catalog.ready();
        entryOf(sessionId);
        notHandedOff(sessionId);
        // A session whose pi is not running, a restored draft among them, starts on its message.
        const session = live(sessionId) ?? (await ensureRunning(sessionId));
        return await session.controller.prompt(command, images);
      } finally {
        const left = (prompting.get(sessionId) ?? 1) - 1;
        if (left === 0) prompting.delete(sessionId);
        else prompting.set(sessionId, left);
      }
    },
    async steer(command, images) {
      const { sessionId } = command;
      prompting.set(sessionId, (prompting.get(sessionId) ?? 0) + 1);
      try {
        await options.catalog.ready();
        entryOf(sessionId);
        notHandedOff(sessionId);
        const session = live(sessionId) ?? (await ensureRunning(sessionId));
        return await session.controller.steer(command, images);
      } finally {
        const left = (prompting.get(sessionId) ?? 1) - 1;
        if (left === 0) prompting.delete(sessionId);
        else prompting.set(sessionId, left);
      }
    },
    stop: async (sessionId) => controllerOf(sessionId).stop(),
    async resumeQueue(sessionId) {
      notHandedOff(sessionId);
      const controller = controllerOf(sessionId);
      // The queue moves only with a pi to take it.
      if (live(sessionId) === undefined) await ensureRunning(sessionId);
      return controller.resumeQueue();
    },
    clearQueue: async (sessionId) => controllerOf(sessionId).clearQueue(),
    updateQueued: async (sessionId, itemId, text) => controllerOf(sessionId).updateQueued(itemId, text),
    removeQueued: async (sessionId, itemId) => controllerOf(sessionId).removeQueued(itemId),
    steerQueued: async (sessionId, itemId) => controllerOf(sessionId).steerQueued(itemId),
    answerInteraction: async (sessionId, interactionId, answer) =>
      controllerOf(sessionId).answerInteraction(interactionId, answer),
    setModel: async (sessionId, model) => (await commanded(sessionId)).controller.setModel(model),
    setThinkingLevel: async (sessionId, level) => (await commanded(sessionId)).controller.setThinkingLevel(level),
    setFast: async (sessionId, enabled) => (await commanded(sessionId)).controller.setFast(enabled),
    listCommands: async (sessionId) => (await commanded(sessionId)).controller.listCommands(),
    async searchFiles(sessionId, query) {
      await options.catalog.ready();
      const { cwd } = entryOf(sessionId);
      if (options.files === undefined) throw new CommandError("fd_missing");
      // Typing a character makes the last search useless; only the newest one runs on.
      searches.get(sessionId)?.abort();
      const search = new AbortController();
      searches.set(sessionId, search);
      try {
        return { files: await options.files.search(cwd, query, search.signal) };
      } finally {
        if (searches.get(sessionId) === search) searches.delete(sessionId);
      }
    },
    async retryRun(sessionId) {
      await options.catalog.ready();
      entryOf(sessionId);
      notHandedOff(sessionId);
      // A session this host never ran has no controller yet; starting it makes one.
      const session = sessions.get(sessionId) ?? (await ensureRunning(sessionId));
      return session.controller.retryRun();
    },
    async fetchStep(command) {
      return controllerOf(command.sessionId).fetchStep(command);
    },
    async fetchTranscript(command) {
      return controllerOf(command.sessionId).fetchTranscript(command);
    },
    async clearAttention(sessionId) {
      await options.catalog.ready();
      const { attention } = entryOf(sessionId);
      // A sign-in problem stays until a run starts: only then is it solved.
      if (attention?.reason === "error" && !attention.cleared) {
        await options.catalog.mark(sessionId, { attention: { ...attention, cleared: true } });
      }
      return {};
    },
    async handOff(sessionId) {
      await options.catalog.ready();
      const entry = entryOf(sessionId);
      if (entry.state === "missing") throw new CommandError("session_not_found", { sessionId });
      if (entry.file === null) throw new CommandError("session_is_draft", { sessionId });
      if (occupied(sessionId)) throw new CommandError("session_busy");
      const { file } = entry;
      return inHandOrder(sessionId, async () => {
        // Marked first, so nothing starts the session's pi again while it stops.
        await options.catalog.mark(sessionId, { handedOff: true });
        await stopSession(sessionId);
        return { file };
      });
    },
    async takeBack(sessionId) {
      await options.catalog.ready();
      entryOf(sessionId);
      return inHandOrder(sessionId, async () => {
        await options.catalog.mark(sessionId, { handedOff: false });
        // pi in the terminal has written to the file since.
        await options.catalog.scan();
        await ensureRunning(sessionId);
        return {};
      });
    },
    summaries() {
      return options.catalog.list().map(({ cwd: _cwd, fast: _fast, ...entry }) => ({
        ...entry,
        running: busy.has(entry.sessionId),
        asking: askingSince(entry.sessionId),
      }));
    },
    async stopIdle() {
      // pi was updated: a session's next use starts the new one (SPEC-0001, "首次启动 · 接口").
      // A pi starting meanwhile may be the old one, so it is waited for and judged too. A dialog
      // waiting for an answer keeps its session's pi. Stopping a pi already gone does nothing.
      await Promise.allSettled(starting.values());
      const idle = [...sessions.keys()].filter((sessionId) => !occupied(sessionId) && askingSince(sessionId) === null);
      await Promise.all(idle.map((sessionId) => stopSession(sessionId)));
    },
    async forgetWorkspaces(workspaceIds) {
      const gone = options.catalog.list().filter((entry) => workspaceIds.includes(entry.containerId));
      await Promise.all(gone.map((entry) => stopSession(entry.sessionId)));
      for (const entry of gone) forget(entry.sessionId);
      await options.layouts.forgetContainers(workspaceIds);
      options.onChange();
    },
    rescan() {
      inBackground("session scan", () => options.catalog.scan());
    },
    async close() {
      closed = true;
      for (const search of searches.values()) search.abort();
      const titlesClosed = titles.close();
      // Controllers first, so restarts under way stop rather than start pi again.
      await Promise.all([...sessions.values()].map(({ controller }) => controller.shutdown()));
      await Promise.all([...running].map((pi) => pi.stop()));
      await Promise.all([...background, titlesClosed]);
    },
  };

  /**
   * The session a command is for, its pi started if it has none.
   *
   * @remarks
   * As for a message: a restored draft, or a session whose pi has exited, starts on the command.
   *
   * @sideEffects May spawn pi.
   * @param sessionId - The session.
   * @returns The running session.
   * @throws {CommandError} `session_not_found`, `session_handed_off`, `session_cwd_missing`,
   * `pi_unavailable`.
   */
  async function commanded(sessionId: string): Promise<Running> {
    await options.catalog.ready();
    entryOf(sessionId);
    notHandedOff(sessionId);
    return live(sessionId) ?? (await ensureRunning(sessionId));
  }

  /**
   * Refuses a command that would start or write pi on a session handed off.
   *
   * @remarks
   * Two pi writing one session fork it without telling (SPEC-0001, "交给终端").
   *
   * @sideEffects none
   * @param sessionId - The session.
   * @throws {CommandError} `session_handed_off`.
   */
  function notHandedOff(sessionId: string): void {
    if (options.catalog.find(sessionId)?.handedOff === true) {
      throw new CommandError("session_handed_off", { sessionId });
    }
  }

  /**
   * Whether a session has something going on that handing it off would cut short.
   *
   * @remarks
   * A run (a stop under way is one), a message on its way, a run pi said it started that has not
   * begun yet, a restart under way, or messages in the host's queue, which only Atrium would send
   * (SPEC-0001, "交给终端").
   *
   * @sideEffects none
   * @param sessionId - The session.
   * @returns Whether it is busy.
   */
  function occupied(sessionId: string): boolean {
    if (busy.has(sessionId) || starting.has(sessionId) || (prompting.get(sessionId) ?? 0) > 0) return true;
    const controller = sessions.get(sessionId)?.controller;
    if (controller === undefined) return false;
    const { control } = controller.snapshot();
    return controller.submitting || control.restarting || control.queue.length > 0;
  }

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
 * Images in the shape pi's `prompt` and `steer` take them.
 *
 * @remarks
 * Left out when there are none, as pi's own clients do (pi-internals.md §3).
 *
 * @sideEffects none
 * @param images - The images.
 * @returns The `images` field, or nothing.
 */
function piImages(images: readonly PromptImage[]): {
  readonly images?: { type: "image"; data: string; mimeType: string }[];
} {
  if (images.length === 0) return {};
  return { images: images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })) };
}

/**
 * The snapshot of a draft whose pi has not started.
 *
 * @remarks
 * Epoch 0, so the snapshot sent once pi starts (epoch 1) replaces it.
 *
 * @sideEffects none
 * @param sessionId - The draft.
 * @param fast - Its Fast.
 * @returns An empty snapshot.
 */
function draftSnapshot(sessionId: string, fast: boolean): SessionSnapshotEvent {
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
    control: IDLE_CONTROL,
    model: null,
    fast,
    metrics: UNKNOWN_METRICS,
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

/** pi's texts of a failure that comes from credentials (pi-internals.md §3, "一次性调用"). */
const AUTH_FAILURE = /no api key|oauth|\b401\b|unauthorized|authentication|invalid[ _]api[ _]key|\/login/i;

/**
 * Whether a failure looks like a credentials problem.
 *
 * @remarks
 * A best guess on pi's own text (SPEC-0001, "会话状态"): a wrong guess only changes the icon.
 *
 * @sideEffects none
 * @param text - pi's text.
 * @returns Whether to ask the user to sign in.
 */
function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE.test(text);
}
