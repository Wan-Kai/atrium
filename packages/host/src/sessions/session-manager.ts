import {
  FAST_COMMAND,
  EDIT_COMMAND,
  isEditCommand,
  AGENT_COMMAND,
  AGENT_STATUS,
  type ModelCatalog,
  readEntries,
  compactionReserve,
  createUsageReader,
  encodeArgument,
  isAgentCommand,
  lastEntryId,
  queryPlanUsage,
  type PiInspection,
  PiRequestError,
  isFastSwitch,
  piStatsOf,
  readUserImage,
  runOneShot,
  sessionModelOf,
  toLogEntry,
  toSlashCommand,
} from "@atrium/pi";
import {
  type Attention,
  type ChildPlacement,
  CommandError,
  IDLE_CONTROL,
  type ModelRef,
  type PlanProvider,
  type SessionEvent,
  type SessionModel,
  type SessionSnapshotEvent,
  type SessionSummary,
  type ThinkingLevel,
  UNKNOWN_METRICS,
  isAuthFailure,
  isChatId,
} from "@atrium/protocol";
import type { Tracer } from "@opentelemetry/api";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import { createPiDeps } from "../platform/pi-deps";
import type { ResourceTracker } from "../platform/resources";
import type { SubscriptionRegistry } from "../sync/subscriptions";
import type { EntriesPage } from "../transcript/session-transcript";
import type { WorkspaceService } from "../workspaces/workspace-service";
import type { ChatRecords } from "../store/chat-records";
import type { PlanUsageService } from "./plan-usage";
import type { TurnStarts } from "../store/turn-starts";
import type { FileSearch } from "../files/file-search";
import type { Layouts } from "./layouts";
import { type CatalogChat, type CatalogEntry, chatIdOf, type NewRecord, type SessionCatalog } from "./session-catalog";
import { archivePlan } from "./child-tree";
import { agentLaunchFlags, toolFlags } from "./agent-launch";
import { type ChildCreated, type ChildRequest, type WorkChanges, createAgentRelay } from "./agent-relay";
import { createChildrenUsage } from "./children-usage";
import type { SessionCommands } from "./session-commands";
import {
  type PromptImage,
  type Respawned,
  type SessionController,
  type SessionPi,
  createSessionController,
} from "./session-controller";
import { forkWithPi } from "./session-forker";
import { type TitleSubject, createTitleGenerator, firstExchange, titleInput } from "./titles";
import { type TracedPi, startTracedPi } from "./traced-pi";

/** What the host found out about pi; `null` when detection did not finish. */
export interface SessionTools {
  readonly env: Readonly<Record<string, string>>;
  readonly pi: PiInspection;
}

/** The largest page `export_session` hands over (SPEC-0001, "M1.11 的 `/` 命令 · 其他宿主命令"). */
const EXPORT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Runs work after the work run before it under the same key.
 *
 * @remarks
 * A failed one does not hold up the next. The key is dropped once nothing waits on it.
 *
 * @sideEffects Runs `work` once the key's earlier work is done; updates `turns`.
 * @param turns - The work under way, by key.
 * @param key - The key.
 * @param work - The work.
 * @returns What `work` returns.
 */
async function inTurn<T>(turns: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
  const turn = (turns.get(key) ?? Promise.resolve()).then(work);
  const settled = turn.catch(() => undefined);
  turns.set(key, settled);
  try {
    return await turn;
  } finally {
    // Stryker disable next-line ConditionalExpression,BlockStatement: only frees memory; a settled turn holds up nothing.
    if (turns.get(key) === settled) turns.delete(key);
  }
}

/** The session layer: every session's controller, and the session commands. */
export interface SessionManager extends SessionCommands {
  /** Every session of a registered container, with whether it runs. */
  summaries(): SessionSummary[];
  /** Stops the sessions of workspaces that went away and drops them from every layout. */
  forgetWorkspaces(workspaceIds: readonly string[]): Promise<void>;
  /**
   * Keeps a workspace's sessions from starting, and new ones from being created in it, until
   * released; stops their pi, archiving nothing; resolves to those not archived.
   */
  stopWorkspace(workspaceId: string): Promise<string[]>;
  /** Lets a workspace's sessions start again, once its archiving is done or failed. */
  releaseWorkspace(workspaceId: string): void;
  /** Archives every session in a workspace, as `archiveSession` does, and drops it from every layout. */
  archiveWorkspace(workspaceId: string): Promise<void>;
  /** Unarchives the sessions given, or with `null` all archived in the workspace. */
  restoreWorkspace(workspaceId: string, sessionIds: readonly string[] | null): Promise<void>;
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
  /** Which start of pi this is, host-wide: Atrium's extension's calls belong to it (ADR-0013, point 5). */
  epoch: number;
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

/** The start of the names of forks' temporary directories (SPEC-0002, "带上下文的子对话怎么做出来"). */
const FORK_TEMP_PREFIX = "atrium-fork-";

/** The marker in a fork's temporary directory, so a later start removes only the host's own. */
const FORK_TEMP_MARKER = ".atrium-fork";

/**
 * The usage baseline of a forked child whose file could not be read for it: no entry has this
 * id, so the child counts nothing rather than its copied history twice (SPEC-0002, "用量合计").
 */
const UNREAD_BASELINE = "(unread)";

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
 * Refuses a message only the host may send pi.
 *
 * @remarks
 * `/atrium-` opens Atrium's hidden commands to its own extension; one you typed would reach it as
 * the host's (SPEC-0002, "送达"). The host's own commands do not come this way.
 *
 * @sideEffects none
 * @param text - The message.
 * @throws {CommandError} `command_reserved`.
 */
function notReserved(text: string): void {
  if (text.trimStart().startsWith("/atrium-")) throw new CommandError("command_reserved");
}

/**
 * Tells a child forked into a new worktree where it works now.
 *
 * @remarks
 * Through Atrium's extension, which words the note and writes it as an `atrium-agent` custom
 * message (SPEC-0002, "对话记录里的自定义消息"); without the extension there is no note, and the
 * user is told so, to tell the model themselves.
 *
 * @sideEffects Asks pi; writes into the child's session.
 * @param pi - The child's pi.
 * @param from - The parent's directory.
 * @param to - The child's.
 * @returns Whether the note was sent.
 * @throws What pi's requests reject with.
 */
async function sendNote(pi: TracedPi, from: string, to: string): Promise<boolean> {
  const { commands } = await pi.request({ type: "get_commands" });
  if (!commands.some(isAgentCommand)) return false;
  const argument = encodeArgument({ v: 1, kind: "note", note: "worktree_moved", from, to });
  await pi.request({ type: "prompt", message: `/${AGENT_COMMAND} note ${argument}` });
  return true;
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
 * - archiving hides a session and stops its pi; archiving a chat records which of its sessions it
 *   archives and its first session before archiving them, so a failure leaves nothing half done
 *   but the record, and restoring brings back only those, before clearing the record; an archived
 *   chat takes no new session (SPEC-0001, "M1.11 的对话归档");
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
 *   session and reported to `fast` (SPEC-0001, "Fast");
 * - a fork is made by a pi of its own on the session's file (`forkWithPi`), takes the original's
 *   turn starts, and opens as a tab of the original's container, where the client goes as for a
 *   new session; `close` calls off forks under way (SPEC-0001, "M1.11 的 `/` 命令 · 分叉").
 *
 * Subscribing sends each newly watched session's snapshot to that connection before any later
 * event (domain-model §7); a draft without pi has an empty one, and its subscribers get the real
 * one once pi starts. Runs starting and ending change the list; a run's end also has the catalog
 * and the workspace looked at again.
 *
 * @sideEffects none until a command arrives; then creates directories, spawns pi, writes the
 * index and publishes.
 * @param options - The chats root, the detected tools, the subscription registry, the catalog,
 * layouts, chats' records and workspaces, a callback for list changes, and the host's clock, resources, tracer,
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
  /** Which chats are archived, and with which sessions (SPEC-0001, "M1.11 的对话归档"). */
  readonly chats: Pick<ChatRecords, "archived" | "setArchived">;
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
  /**
   * Subscriptions' usage, asked through Atrium's extension in sessions' pi (ADR-0010); without it,
   * or without the extension, sessions show none.
   */
  readonly plan?: PlanUsageService;
  /**
   * Creates a worktree for a child conversation from where a workspace is now (SPEC-0002, "概念 ·
   * 新 worktree 的起点"); without it a child cannot go to a new worktree (`child_place_invalid`).
   */
  readonly childWorktree?: (
    workspaceId: string,
    wanted: string,
    prefix?: string,
  ) => Promise<{ readonly workspaceId: string; readonly dir: string; readonly branch: string }>;
  /** The models a directory can use, for the agent's children (SPEC-0002, `agent_models`); none without it. */
  readonly modelCatalog?: Pick<ModelCatalog, "list">;
  /** Where temporary files of forks into new worktrees go, the host's own; the system's when left out. */
  readonly tempRoot?: string;
  /**
   * A worktree workspace's branch and what it changed since it was made, committed or not, for a
   * `work` child's delivery (SPEC-0002, "交付"); without it the delivery gives neither.
   */
  readonly workChanges?: (
    workspaceId: string,
    signal: AbortSignal,
  ) => Promise<{ readonly branch: string | null; readonly changes: WorkChanges | null }>;
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
  /** Drafts being discarded, which a message or an open waits for (SPEC-0001, "close_tab"). */
  const discarding = new Map<string, Promise<void>>();
  /** Drafts created by this host, which start on open, unlike drafts restored (domain-model, "已决定 7, 9"). */
  const created = new Set<string>();
  /** Sessions being started, so a second start waits for the first. */
  const starting = new Map<string, Promise<Running>>();
  /**
   * Sessions, and containers whose sessions, are being archived, which nothing may start again
   * (SPEC-0001, "`archive_session`"), with how many archivings under way mark each: a child's
   * archiving and its parent's may overlap.
   */
  const archiving = new Map<string, number>();
  /** Those waiting for an archiving to end, told whenever one does. */
  const archivingWaiters = new Set<() => void>();
  /** Each chat's archive or restore under way, for the next to wait for. */
  const chatTurns = new Map<string, Promise<unknown>>();
  /** Background work, such as scans after a run, that `close` waits for. */
  const background = new Set<Promise<void>>();
  /** Set by `close`; a session being started then stops its pi instead of keeping it. */
  let closed = false;
  /** Each session's `@` search under way, which the next one calls off. */
  const searches = new Map<string, AbortController>();
  /** Aborted by `close`, which calls off forks under way. */
  const closing = new AbortController();
  /** Each client's last tab or place change, which the next one waits for. */
  const clientTurns = new Map<string, Promise<unknown>>();
  /** Each session's last hand-off or take-back, which the next one waits for. */
  const handTurns = new Map<string, Promise<unknown>>();
  /** Children forked into a new worktree, by session, to the file their pi first starts from (SPEC-0002). */
  const forkFrom = new Map<string, string>();
  /** What each session's child conversations produced, for its "含子对话" figures (SPEC-0002, "用量合计"). */
  const childrenUsage = createChildrenUsage({
    entries: () => options.catalog.list(),
    reader: createUsageReader(),
    onTotals: (sessionId, totals) => sessions.get(sessionId)?.controller.childrenChanged(totals),
  });
  // A child created, detached, archived or found grown changes its ancestors' figures.
  const stopWatchingCatalog = options.catalog.onChange(() => {
    for (const sessionId of sessions.keys()) childrenUsage.refresh(sessionId);
  });
  /** How many times pi was started, so each start has its own number (ADR-0013, point 5). */
  let epochs = 0;
  /** The host's end of Atrium's extension: child conversations the agent opens (SPEC-0002, "第二步"). */
  const relay = createAgentRelay({
    catalog: options.catalog,
    clock: timers,
    newId: options.newId,
    logger: options.logger,
    async command(sessionId, epoch, message) {
      const found = live(sessionId);
      if (found === undefined || found.epoch !== epoch) return false;
      await found.pi.request({ type: "prompt", message });
      return true;
    },
    controller: (sessionId) => live(sessionId)?.controller,
    state(sessionId) {
      const found = live(sessionId);
      // A pi that exited keeps its control: a queue stopped, or pi crashed out (SPEC-0002, `agent_send`).
      const controller = sessions.get(sessionId)?.controller;
      const control = controller?.control() ?? IDLE_CONTROL;
      return {
        live: found !== undefined,
        // pi being started again after a crash is in `starting` all along (SPEC-0002, "概念 · 数量").
        running: busy.has(sessionId) || (found?.controller.submitting ?? false) || starting.has(sessionId),
        asking: askingSince(sessionId) !== null,
        paused: control.paused,
        failed: control.failure !== null,
        queued: control.queue.length,
      };
    },
    async ensureRunning(sessionId) {
      await ensureRunning(sessionId);
    },
    recycle: (sessionId) => stopSession(sessionId),
    async resumeQueue(sessionId) {
      try {
        sessions.get(sessionId)?.controller.resumeQueue();
      } catch (error) {
        // A stop under way pauses the queue again once it ends.
        options.logger.warn({ sessionId, err: error }, "queue not resumed");
      }
    },
    async workChanges(sessionId) {
      const entry = options.catalog.find(sessionId);
      if (entry === undefined || options.workChanges === undefined) return { branch: null, changes: null };
      return options.workChanges(entry.containerId, closing.signal);
    },
    tabOpen: (sessionId) => options.layouts.isOpen(sessionId),
    archiving(sessionId) {
      const entry = options.catalog.find(sessionId);
      return archiving.has(sessionId) || (entry !== undefined && archiving.has(entry.containerId));
    },
    canBranch(sessionId) {
      const entry = options.catalog.find(sessionId);
      return entry !== undefined && !isChatId(entry.containerId) && options.childWorktree !== undefined;
    },
    createChild: (request) => createAgentChild(request),
    async models(sessionId) {
      if (options.modelCatalog === undefined) return [];
      return [...(await options.modelCatalog.list(entryOf(sessionId).cwd, false)).models];
    },
    modelOf: (sessionId) => sessions.get(sessionId)?.controller.model() ?? null,
    readEntries: (file) => readEntries(file),
    async noteMoved(sessionId, from, to) {
      const found = live(sessionId);
      if (found !== undefined) await sendNote(found.pi, from, to);
    },
    tempDir: () => forkTempDir(),
    removeDir: (dir) => removeForkDir(dir),
    changed: () => options.onChange(),
  });

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
    return inTurn(handTurns, sessionId, work);
  }

  /**
   * Runs a chat's archive or restore after the one asked for before it.
   *
   * @remarks
   * SPEC-0001 ("M1.11 的对话归档"): a restore while the archive still stops pi would unmark the
   * chat, and the archive would then archive its sessions, leaving them archived in a chat shown
   * again. A failed one does not hold up the next.
   *
   * @sideEffects Runs `work` once the chat's earlier archive or restore is done.
   * @param chatId - The chat.
   * @param work - The archive or restore.
   * @returns What `work` returns.
   */
  async function inChatOrder<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    return inTurn(chatTurns, chatId, work);
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
        if (found.controller.forking) return false;
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
    } else if (event.type === "metrics_updated") {
      // Its file grew, or its own children's did: the sessions above it count that.
      childrenUsage.refreshAbove(sessionId);
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
      // A child the agent opened waiting for you tells its parent's agent (SPEC-0002, `needs_you`).
      relay.asking(sessionId, open.size > 0);
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
   * @param sessionId - The session it is for, which says who it is to Atrium's extension.
   * @returns The traced pi, the controller's view of it, its model and its entries.
   * @throws {CommandError} `pi_unavailable` when pi exits or does not answer.
   */
  async function spawn(tools: ReadyTools, launch: Launch, sessionId: string) {
    // Atrium's extension, and who the session is for it and its tools' limits (SPEC-0002, "角色与限制").
    const extension =
      options.fast === undefined
        ? []
        : ["--extension", options.fast.extension, ...agentLaunchFlags(options.catalog.list(), sessionId)];
    const traced = startTracedPi({
      launch: {
        piPath: tools.pi.piPath,
        args: [...launch.args, ...extension],
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
    epochs += 1;
    const epoch = epochs;
    // Atrium's extension asks the host on its status line (ADR-0013, point 1).
    const unheard = pi.onEvent((event) => {
      if (
        event.type === "extension_ui_request" &&
        event.method === "setStatus" &&
        event.statusKey.startsWith(`${AGENT_STATUS}:`) &&
        event.statusText !== undefined
      )
        relay.request(sessionId, epoch, event.statusText);
    });
    /**
     * Forgets the process once it exited.
     *
     * @remarks
     * Its calls and questions end with it (ADR-0013, point 4).
     *
     * @sideEffects Updates the processes; stops listening; tells the relay.
     */
    const ended = (): void => {
      running.delete(pi);
      unheard();
      relay.exited(sessionId, epoch);
    };
    // Fire and forget: `exited` never rejects.
    void pi.exited.then(ended);
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
    let sessionFile: string | null = null;
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
      const state = await traced.request({ type: "get_state" });
      model = sessionModelOf(state);
      sessionFile = state.sessionFile ?? null;
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
      readPersistedEntries: async () => {
        const file = sessionFile ?? entryOf(sessionId).file;
        if (file === null) throw new CommandError("edit_failed");
        const persisted = await readEntries(file);
        return { entries: persisted, leafId: persisted.at(-1)?.id ?? null };
      },
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
      // No deadline: pi answers once its model has written the summary.
      compact: async (instructions) => {
        await traced.request(
          // Stryker disable next-line ConditionalExpression,EqualityOperator: undefined is left out of the JSON either way.
          { type: "compact", ...(instructions === undefined ? {} : { customInstructions: instructions }) },
          { timeoutMs: null },
        );
      },
      exportHtml: async (outputPath) => {
        await traced.request({ type: "export_html", outputPath });
      },
      commands: async () =>
        (await traced.request({ type: "get_commands" })).commands.flatMap((command) => toSlashCommand(command) ?? []),
      stats: async () => piStatsOf(await traced.request({ type: "get_session_stats" })),
      stop: () => pi.stop(),
      command: async (message) => {
        if (message.startsWith(`/${EDIT_COMMAND} `)) {
          const { commands } = await traced.request({ type: "get_commands" });
          if (!commands.some(isEditCommand)) throw new CommandError("edit_failed");
        }
        await traced.request({ type: "prompt", message });
      },
    };
    return { traced, view, entries, model, fast: launch.fast, env: tools.env, epoch };
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
    const { traced, view, entries, model, fast, env, epoch } = spawned;
    const known = sessions.get(sessionId);
    if (known !== undefined) {
      if (!known.controller.exited) {
        // Another start handed the session its pi first; one session, one pi (pi-internals.md §3).
        await traced.process.stop();
        return known;
      }
      known.pi = traced;
      known.epoch = epoch;
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
      readReserve: (chosen) => compactionReserve(env, chosen),
      ...(options.plan === undefined || options.fast === undefined
        ? {}
        : {
            plan: {
              service: options.plan,
              // The session's pi now; before the session is registered, the one just started.
              ask: (provider: PlanProvider) =>
                queryPlanUsage((sessions.get(sessionId)?.pi ?? traced).process, provider),
            },
          }),
      home: env["HOME"] ?? homedir(),
      model,
      onModelChosen: (chosen) => options.models?.chosen(chosen),
      fast,
      onFastChosen: (enabled) => {
        options.fast?.chosen(enabled);
        inBackground("fast record", () => options.catalog.mark(sessionId, { fast: enabled }));
      },
      deliveries: relay.deliveries(sessionId),
      ...(starts === undefined
        ? {}
        : {
            turnStarts: {
              opened: starts.opened,
              auto: starts.auto,
              compactions: starts.compactions,
              record: (
                entryIds: readonly string[],
                autoIds: readonly string[],
                compactions: ReadonlyMap<string, "overflow" | "threshold" | null>,
              ) => inBackground("turn starts", () => starts.record(entryIds, autoIds, compactions)),
            },
          }),
    });
    const started: Running = { controller, pi: traced, epoch };
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
      const spawned = await spawn(await readyTools(), await launchOf(sessionId), sessionId);
      const known = sessions.get(sessionId);
      if (known === undefined) throw new CommandError("session_not_found", { sessionId });
      known.pi = spawned.traced;
      known.epoch = spawned.epoch;
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
    // A child forked into a new worktree: pi copies the history there before it starts (SPEC-0002).
    const from = forkFrom.get(sessionId);
    if (from !== undefined)
      return { args: ["--fork", from, "--session-id", sessionId], cwd: entry.cwd, startOn: null, fast };
    // pi has written nothing of the session, so a new pi would not know the model it had.
    const had = snapshot?.model ?? null;
    // A child the agent opened starts on the model and level it asked for (SPEC-0002, `agent_spawn`).
    const asked = entry.agent?.startOn ?? null;
    const startOn =
      had !== null
        ? { model: { providerId: had.providerId, modelId: had.modelId }, thinkingLevel: had.thinkingLevel }
        : asked !== null
          ? { model: { providerId: asked.providerId, modelId: asked.modelId }, thinkingLevel: asked.thinkingLevel }
          : (options.models?.preferred() ?? null);
    // A child conversation's name goes into pi's session from its first start (SPEC-0002, "概念 · 名字").
    const named = entry.name === null ? [] : ["--name", entry.name];
    return { args: ["--session-id", sessionId, ...named], cwd: entry.cwd, startOn, fast };
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
      notArchived(sessionId);
      const tools = await readyTools();
      const started = await connect(sessionId, await spawn(tools, await launchOf(sessionId), sessionId));
      // pi copied the history and wrote the file: never `--fork` the same id again (SPEC-0002).
      forkFrom.delete(sessionId);
      return started;
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
   * @param go - Whether the client goes to the container, as it does unless it moved meanwhile.
   * @param child - For a child conversation, its parent and name (SPEC-0002).
   * @returns The new session's id.
   */
  async function create(
    clientId: string,
    containerId: string,
    cwd: string,
    go = true,
    child: Pick<NewRecord, "parent" | "name"> = {},
  ): Promise<string> {
    const asked = options.layouts.of(clientId).container;
    const sessionId = options.newSessionId();
    await options.catalog.record({ sessionId, containerId, cwd, ...child });
    // A parent archived meanwhile takes the child with it, or lets it go (SPEC-0002).
    await settleChild(sessionId);
    created.add(sessionId);
    // Started as a draft's: whatever needs pi meanwhile waits for this start.
    inBackground("session start", () => ensureRunning(sessionId));
    // In order from here: the client could not name the session before.
    await inClientOrder(clientId, async () => {
      const stayed = options.layouts.of(clientId).container === asked;
      await options.layouts.open(clientId, containerId, sessionId, go && stayed);
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
    childrenUsage.refresh(sessionId);
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

  /**
   * A chat there is, archived or not.
   *
   * @remarks
   * A chat is found by its directory (`SessionCatalog.chats`).
   *
   * @sideEffects none
   * @param chatId - The chat.
   * @returns The chat with its first session.
   * @throws {CommandError} `chat_not_found` when there is no such chat.
   */
  function chatOf(chatId: string): CatalogChat {
    const chat = options.catalog.chats().find((candidate) => candidate.id === chatId);
    if (chat === undefined) throw new CommandError("chat_not_found", { chatId });
    return chat;
  }

  /**
   * Gives a forked session the record of which of its user messages opened turns, and of the
   * compactions seen during its runs.
   *
   * @remarks
   * pi keeps entry ids when it forks (pi-internals.md §1), so the original's record holds for the
   * fork; without it, the fork would show steers as turns of their own (SPEC-0001, "M1.11 的 `/`
   * 命令 · 分叉"). Entries past the fork point are left in, as they name nothing there. A failure
   * is only logged: the fork is made, and shows as it would without the record.
   *
   * @sideEffects Reads and writes turn start files; may log.
   * @param from - The original session.
   * @param to - The fork.
   */
  async function copyTurnStarts(from: string, to: string): Promise<void> {
    if (options.turnStarts === undefined) return;
    try {
      const starts = await options.turnStarts(from);
      await (await options.turnStarts(to)).record([...starts.opened], [...starts.auto], starts.compactions);
    } catch (error) {
      options.logger.warn({ ...failureFields(error), sessionId: to }, "turn starts could not be copied");
    }
  }

  /**
   * Discards a draft whose last tab closed: stops its pi, forgets it, and removes its chat's
   * directory when it was the chat's only session.
   *
   * @remarks
   * Stopping waits for a start under way, during which a message may come or a client open it
   * again: looked at once more after, it is kept then, and its pi starts again for them (SPEC-0001,
   * "close_tab"). A chat whose directory went leaves every layout too.
   *
   * @sideEffects Stops pi; writes the index; may remove a directory, change layouts and scan.
   * @param sessionId - The draft.
   * @param entry - Its catalog entry.
   */
  async function discard(sessionId: string, entry: { readonly containerId: string; readonly cwd: string }) {
    await stopSession(sessionId);
    if ((prompting.get(sessionId) ?? 0) > 0 || options.layouts.isOpen(sessionId)) return;
    forget(sessionId);
    await options.catalog.forget(sessionId);
    // Only a chat's own directory, only when no other session is in it, and only while empty
    // (domain-model, "已决定 13").
    const alone = !options.catalog.list().some((other) => other.containerId === entry.containerId);
    if (isChatId(entry.containerId) && alone) {
      const removed = await rmdir(entry.cwd).then(
        () => true,
        () => false,
      );
      if (removed) await options.layouts.forgetContainers([entry.containerId]);
      // The chat goes with its directory.
      inBackground("session scan", () => options.catalog.scan());
    }
    options.onChange();
  }

  /**
   * Removes the temporary directories of forks a stop of the host cut short.
   *
   * @remarks
   * Only directories with the fixed prefix that hold the marker, so nothing of anyone else's goes
   * (SPEC-0002, "带上下文的子对话怎么做出来"). What cannot be read or removed stays.
   *
   * @sideEffects Reads the temporary directory; removes directories.
   */
  async function removeForkLeftovers(): Promise<void> {
    const root = options.tempRoot ?? tmpdir();
    const names = await readdir(root).catch(() => [] as string[]);
    for (const name of names.filter((candidate) => candidate.startsWith(FORK_TEMP_PREFIX))) {
      const dir = join(root, name);
      if ((await stat(join(dir, FORK_TEMP_MARKER)).catch(() => null)) === null) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The removal of leftovers at start, which a new fork's directory waits for. */
  let leftoversGone: Promise<unknown> = Promise.resolve();
  inBackground("fork leftovers", () => (leftoversGone = removeForkLeftovers()));
  // What waited to go to pi when the host stopped is held for you (SPEC-0002, "送达").
  inBackground("agent deliveries", async () => {
    // `close` waits for this; a host closing before its first scan has nothing to hold.
    const closes = new Promise<void>((resolve) =>
      closing.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await Promise.race([options.catalog.ready(), closes]);
    if (!closed) await relay.start();
  });

  return {
    async createChat(clientId) {
      const name = options.newId();
      const cwd = join(options.chatsRoot, name);
      await mkdir(cwd, { recursive: true });
      try {
        return { sessionId: await create(clientId, chatIdOf(name), cwd) };
      } catch (error) {
        // Only the directory just made, only while empty, and only if no session was recorded in it.
        if (!options.catalog.list().some((entry) => entry.cwd === cwd)) await rmdir(cwd).catch(() => undefined);
        throw error;
      }
    },
    async createSession(clientId, containerId, go = true, child) {
      if (child !== undefined) return { sessionId: await createChild(clientId, containerId, child, go) };
      if (isChatId(containerId)) {
        const chat = chatOf(containerId);
        if (options.chats.archived(containerId) !== null || archiving.has(containerId)) {
          throw new CommandError("chat_not_found", { chatId: containerId });
        }
        return { sessionId: await create(clientId, containerId, chat.dir) };
      }
      const dir = options.workspaces.dirOf(containerId);
      if (dir === undefined || archiving.has(containerId)) {
        throw new CommandError("workspace_not_found", { workspaceId: containerId });
      }
      return { sessionId: await create(clientId, containerId, dir, go) };
    },
    async openSession(clientId, sessionId) {
      const entry = await inClientOrder(clientId, async () => {
        if (options.catalog.find(sessionId) === undefined) await options.catalog.ready();
        // The scan may have ended because the host is closing.
        if (closed) return undefined;
        const found = entryOf(sessionId);
        notArchived(sessionId);
        // The tab opens first, so a session that cannot start explains why in its own tab.
        await options.layouts.open(clientId, found.containerId, sessionId);
        options.onChange();
        return found;
      });
      if (entry === undefined) return {};
      // Starting needs the session's file, which only a scan finds.
      await options.catalog.ready();
      // A discard under way sees the tab, keeps the draft, and its pi starts again here.
      await discarding.get(sessionId)?.catch(() => undefined);
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
      // A child the agent opened, idle without a tab, stops its pi (SPEC-0002, "角色与限制 · 进程").
      relay.tabClosed(sessionId);
      if (options.catalog.find(sessionId)?.state !== "draft") return {};
      // A message may be on its way, or its file just written: look again before discarding.
      await options.catalog.scan();
      const entry = options.catalog.find(sessionId);
      const empty = (sessions.get(sessionId)?.controller.snapshot().items.length ?? 0) === 0;
      // A start under way is no message: `stopSession` waits for it and stops its pi.
      const busyNow = (prompting.get(sessionId) ?? 0) > 0;
      if (entry?.state === "draft" && empty && !busyNow && !options.layouts.isOpen(sessionId)) {
        const going = discard(sessionId, entry);
        discarding.set(sessionId, going);
        try {
          await going;
        } finally {
          discarding.delete(sessionId);
        }
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
      const entry = entryOf(sessionId);
      // Its child conversations in the same container go with it; one elsewhere is detached (SPEC-0002).
      const plan = archivePlan(options.catalog.list(), [sessionId], entry.containerId);
      const archived = [sessionId, ...plan.archive];
      await whileArchivingAll(archived, async () => {
        await Promise.all(archived.map((id) => stopEnding(id)));
        for (const id of archived) {
          forget(id);
          await options.catalog.archive(id);
        }
      });
      await detachAll(plan.detach);
      for (const id of archived) await relay.ended(id, "archived");
      await options.layouts.forgetSessions(archived);
      options.onChange();
      return {};
    },
    async detachSession(sessionId) {
      await options.catalog.ready();
      const entry = entryOf(sessionId);
      // An archiving under way decided already what becomes of it.
      notArchived(sessionId);
      await detachAll([sessionId]);
      // Its file counts for no session above it any more.
      if (entry.file !== null) childrenUsage.forget(entry.file);
      options.onChange();
      return {};
    },
    async archiveChat(chatId) {
      await options.catalog.ready();
      chatOf(chatId);
      await inChatOrder(chatId, async () => {
        if (options.chats.archived(chatId) !== null) return;
        await whileArchiving(chatId, async () => {
          // A session created before the mark is listed already: the index records it at once.
          const archived = options.catalog
            .list()
            .filter((entry) => entry.containerId === chatId && !entry.archived)
            .map((entry) => entry.sessionId);
          await options.chats.setArchived(chatId, {
            at: options.clock.now(),
            sessions: archived,
            first: chatOf(chatId).firstSessionId,
          });
          await Promise.all(archived.map((sessionId) => stopEnding(sessionId)));
          const { detach } = archivePlan(options.catalog.list(), archived, chatId);
          for (const sessionId of archived) {
            forget(sessionId);
            await options.catalog.archive(sessionId);
          }
          // A child conversation elsewhere stays, as an ordinary session (SPEC-0002, "归档、脱离、交接").
          await detachAll(detach);
          for (const sessionId of archived) await relay.ended(sessionId, "archived");
        });
        await options.layouts.forgetContainers([chatId]);
        options.onChange();
      });
      return {};
    },
    async restoreChat(chatId) {
      await options.catalog.ready();
      chatOf(chatId);
      await inChatOrder(chatId, async () => {
        const archive = options.chats.archived(chatId);
        if (archive === null) return;
        for (const sessionId of archive.sessions) await options.catalog.unarchive(sessionId);
        await options.chats.setArchived(chatId, null);
        options.onChange();
      });
      return {};
    },
    async renameSession(sessionId, name) {
      await options.catalog.ready();
      const entry = entryOf(sessionId);
      if (entry.state === "draft") {
        // pi writes no file before the first message, so a draft's name has nowhere to go, but a
        // child's: its record (SPEC-0002, "概念 · 名字").
        if (entry.parent === null) throw new CommandError("session_is_draft", { sessionId });
        renamed.add(sessionId);
        await options.catalog.name(sessionId, name);
        // A pi started, or starting, was given the old name, which its file would carry.
        await starting.get(sessionId)?.catch(() => undefined);
        const session = live(sessionId);
        if (session?.controller.forking) throw new CommandError("session_busy");
        await session?.pi.request({ type: "set_session_name", name });
        return {};
      }
      notHandedOff(sessionId);
      const { pi, controller } = await ensureRunning(sessionId);
      if (controller.forking) throw new CommandError("session_busy");
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
        // A discard under way sees this message, keeps the draft, and its pi starts again here.
        await discarding.get(sessionId)?.catch(() => undefined);
        notReserved(command.text);
        await options.catalog.ready();
        notArchived(sessionId);
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
    async editStoppedMessage(command, images) {
      const { sessionId } = command;
      prompting.set(sessionId, (prompting.get(sessionId) ?? 0) + 1);
      try {
        notReserved(command.text);
        await options.catalog.ready();
        notArchived(sessionId);
        notHandedOff(sessionId);
        const session = live(sessionId) ?? (await ensureRunning(sessionId));
        return await session.controller.editStoppedMessage(command, images);
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
        // A discard under way sees this message, keeps the draft, and its pi starts again here.
        await discarding.get(sessionId)?.catch(() => undefined);
        notReserved(command.text);
        await options.catalog.ready();
        notArchived(sessionId);
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
    async updateQueued(sessionId, itemId, text) {
      notReserved(text);
      return controllerOf(sessionId).updateQueued(itemId, text);
    },
    removeQueued: async (sessionId, itemId) => controllerOf(sessionId).removeQueued(itemId),
    steerQueued: async (sessionId, itemId) => controllerOf(sessionId).steerQueued(itemId),
    answerInteraction: async (sessionId, interactionId, answer) =>
      controllerOf(sessionId).answerInteraction(interactionId, answer),
    setModel: async (sessionId, model) => (await commanded(sessionId)).controller.setModel(model),
    setThinkingLevel: async (sessionId, level) => (await commanded(sessionId)).controller.setThinkingLevel(level),
    setFast: async (sessionId, enabled) => (await commanded(sessionId)).controller.setFast(enabled),
    async compactSession(sessionId, instructions) {
      await options.catalog.ready();
      // A draft has no conversation to compact.
      if (entryOf(sessionId).state === "draft") throw new CommandError("session_is_draft", { sessionId });
      return (await commanded(sessionId)).controller.compact(instructions);
    },
    async exportSession(sessionId) {
      await options.catalog.ready();
      // pi exports from the session's file, which a draft does not have yet.
      if (entryOf(sessionId).state === "draft") throw new CommandError("session_is_draft", { sessionId });
      const { controller } = await commanded(sessionId);
      // pi writes to its working directory unless told where; the host's own directory keeps the
      // page out of your files, and goes once read (SPEC-0001, "M1.11 的 `/` 命令 · 其他宿主命令").
      const dir = await mkdtemp(join(tmpdir(), "atrium-export-"));
      try {
        const file = join(dir, "session.html");
        await controller.exportHtml(file);
        if ((await stat(file)).size > EXPORT_MAX_BYTES)
          throw new CommandError("export_failed", { reason: "too_large" });
        return { html: await readFile(file, "utf8") };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async forkSession(clientId, { sessionId, turnId, name, child }) {
      const asked = options.layouts.of(clientId).container;
      await options.catalog.ready();
      const entry = entryOf(sessionId);
      if (entry.state === "missing") throw new CommandError("session_not_found", { sessionId });
      if (entry.file === null) throw new CommandError("session_is_draft", { sessionId });
      notHandedOff(sessionId);
      // A tree being archived takes no new child (SPEC-0002, "归档、脱离、交接").
      if (child !== undefined) notArchived(sessionId);
      // Turns are known only to a controller, which the session's pi starting makes.
      const controller = sessions.get(sessionId)?.controller;
      if (controller === undefined) throw new CommandError("turn_not_found");
      // A turn that just ended is tied to its entry by the read its end started.
      await controller.entriesRead();
      const at = controller.forkPoint(turnId);
      // Busy from the check until the temporary pi has read the file and stopped: a message sent
      // meanwhile would be written to the file it reads.
      const release = controller.holdForFork();
      let temp: string | null = null;
      let forked: Awaited<ReturnType<typeof forkWithPi>>;
      try {
        // Into a new worktree, the fork is a file in the host's own temporary directory first (SPEC-0002).
        if (child?.place === "worktree") temp = await forkTempDir();
        forked = await forkWithTemporaryPi(entry, at, name, temp);
      } catch (error) {
        if (temp !== null) await removeForkDir(temp);
        throw error;
      } finally {
        release();
      }
      if (child?.place === "worktree" && temp !== null) {
        return forkIntoWorktree(clientId, asked, entry, temp, child.branch, name);
      }
      await copyTurnStarts(sessionId, forked.sessionId);
      await options.catalog.scan();
      const found = options.catalog.find(forked.sessionId);
      if (found === undefined) {
        options.logger.warn({ sessionId, reason: "not_found" }, "fork failed");
        throw new CommandError("fork_failed");
      }
      if (child !== undefined && found.file !== null) {
        // Under the session it was forked from, counting only what it does from here on (SPEC-0002).
        await options.catalog.record({
          sessionId: forked.sessionId,
          containerId: found.containerId,
          cwd: found.cwd,
          parent: { sessionId, by: "user" },
          name,
          usageAfter: await lastEntryId(found.file).catch((error: unknown) => {
            // Unknown, it counts nothing rather than the history it copied a second time.
            options.logger.warn({ ...failureFields(error), sessionId: forked.sessionId }, "usage baseline not read");
            return UNREAD_BASELINE;
          }),
          persisted: true,
        });
        await settleChild(forked.sessionId);
      }
      await inClientOrder(clientId, async () => {
        // As for a new session: the client goes to it only if it stayed where it was.
        const stayed = options.layouts.of(clientId).container === asked;
        await options.layouts.open(clientId, found.containerId, forked.sessionId, stayed);
        options.onChange();
      });
      return { sessionId: forked.sessionId };
    },
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
    async fetchImage(command) {
      // pi keeps the image in the session file, so it is read from there rather than kept here.
      const controller = controllerOf(command.sessionId);
      // A turn that just ended is tied to its entry by the read its end started.
      await controller.entriesRead();
      const entryId = controller.entryOfTurn(command.turnId);
      const { file } = entryOf(command.sessionId);
      const image = entryId === null || file === null ? null : await readUserImage(file, entryId, command.index);
      if (image === null) throw new CommandError("image_unavailable");
      return image;
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
    async removeDelivery(sessionId, deliveryId) {
      await options.catalog.ready();
      entryOf(sessionId);
      await relay.removeDelivery(sessionId, deliveryId);
      return {};
    },
    async resumeDeliveries(sessionId, tree) {
      await options.catalog.ready();
      entryOf(sessionId);
      await relay.resumeDeliveries(sessionId, tree);
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
        if (occupied(sessionId)) throw new CommandError("session_busy");
        // Marked first, so nothing starts the session's pi again while it stops.
        await options.catalog.mark(sessionId, { handedOff: true });
        await stopEnding(sessionId);
        await relay.ended(sessionId, "handed_off");
        // pi in a terminal has no Atrium extension: a child's limits go as flags (SPEC-0002, "交接").
        const entries = options.catalog.list();
        const args =
          entries.find((one) => one.sessionId === sessionId)?.agent == null ? [] : toolFlags(entries, sessionId, true);
        return { file, args };
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
        relay.takenBack(sessionId);
        return {};
      });
    },
    summaries() {
      return options.catalog
        .list()
        .map(
          ({
            cwd: _cwd,
            fast: _fast,
            usageAfter: _usageAfter,
            agent: _agent,
            usedHandles: _usedHandles,
            deliveries: _deliveries,
            ...entry
          }) => ({
            ...entry,
            running: busy.has(entry.sessionId),
            asking: askingSince(entry.sessionId),
            ...relay.summary(entry.sessionId),
          }),
        );
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
    async stopWorkspace(workspaceId) {
      // Marked first, so nothing starts or is created in it until it is released (see `notArchived`).
      mark([workspaceId]);
      const inside = options.catalog.list().filter((entry) => entry.containerId === workspaceId);
      await Promise.all(inside.map((entry) => stopEnding(entry.sessionId)));
      return inside.filter((entry) => !entry.archived).map((entry) => entry.sessionId);
    },
    releaseWorkspace(workspaceId) {
      unmark([workspaceId]);
    },
    async archiveWorkspace(workspaceId) {
      // Archived with its workspace (SPEC-0001, "M1.11 的工作区归档"), drafts too; archiving one again changes nothing.
      const inside = options.catalog.list().filter((entry) => entry.containerId === workspaceId);
      await Promise.all(inside.map((entry) => stopEnding(entry.sessionId)));
      // Called once the worktree is removed, so a failed removal detaches nothing (SPEC-0002).
      const { detach } = archivePlan(
        options.catalog.list(),
        inside.filter((entry) => !entry.archived).map((entry) => entry.sessionId),
        workspaceId,
      );
      for (const entry of inside) {
        forget(entry.sessionId);
        await options.catalog.archive(entry.sessionId);
      }
      await detachAll(detach);
      for (const entry of inside) await relay.ended(entry.sessionId, "archived");
      await options.layouts.forgetContainers([workspaceId]);
      options.onChange();
    },
    async restoreWorkspace(workspaceId, sessionIds) {
      // A workspace archived before its sessions were recorded gets back all those archived in it.
      const back =
        sessionIds ??
        options.catalog
          .list()
          .filter((entry) => entry.containerId === workspaceId && entry.archived)
          .map((entry) => entry.sessionId);
      for (const sessionId of back) await options.catalog.unarchive(sessionId);
      options.onChange();
    },
    rescan() {
      inBackground("session scan", () => options.catalog.scan());
    },
    async close() {
      closed = true;
      closing.abort();
      stopWatchingCatalog();
      for (const search of searches.values()) search.abort();
      const titlesClosed = titles.close();
      // Tasks running are told `stopped` before their pi stops (SPEC-0002, "送达").
      await relay.close();
      // Controllers first, so restarts under way stop rather than start pi again.
      await Promise.all([...sessions.values()].map(({ controller }) => controller.shutdown()));
      await Promise.all([...running].map((pi) => pi.stop()));
      await Promise.all([...background, titlesClosed, childrenUsage.close()]);
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
   * Refuses a command that would start pi on, or send to, a session archived or being archived.
   *
   * @remarks
   * SPEC-0001 ("`archive_session`"): an archived session keeps no pi. Marked before its pi stops,
   * so nothing slips in between the stop and the index being written.
   *
   * @sideEffects none
   * @param sessionId - The session.
   * @throws {CommandError} `session_not_found`, also for an unknown session.
   */
  function notArchived(sessionId: string): void {
    const entry = entryOf(sessionId);
    if (entry.archived || archiving.has(sessionId) || archiving.has(entry.containerId)) {
      throw new CommandError("session_not_found", { sessionId });
    }
  }

  /**
   * Forks a session with a temporary pi, which stops once done.
   *
   * @remarks
   * The session's own pi stays as it is: pi's `fork` moves the pi that runs it to the new file
   * (SPEC-0001, "M1.11 的 `/` 命令 · 分叉"). With `sessionDir` the new file goes there rather than
   * to the session's folder, as a fork into a new worktree needs (SPEC-0002).
   *
   * @sideEffects Starts and stops a pi; writes a session file.
   * @param entry - The session, on file.
   * @param at - The entry the fork stops before; `null` copies the whole branch.
   * @param name - The new session's name.
   * @param sessionDir - Where the new file goes; `null` for the session's folder.
   * @returns The new session's id.
   * @throws {CommandError} `fork_failed`, `pi_unavailable`.
   */
  async function forkWithTemporaryPi(entry: CatalogEntry, at: string | null, name: string, sessionDir: string | null) {
    const tools = await readyTools();
    const traced = startTracedPi({
      launch: {
        piPath: tools.pi.piPath,
        args: ["--session", entry.file ?? "", ...(sessionDir === null ? [] : ["--session-dir", sessionDir])],
        cwd: entry.cwd,
      },
      deps: createPiDeps({
        clock: options.clock,
        resources: options.resources,
        logger: options.logger,
        env: tools.env,
      }),
      tracer: options.tracer,
    });
    running.add(traced.process);
    // Fire and forget: `exited` never rejects.
    void traced.process.exited.then(() => running.delete(traced.process));
    return forkWithPi({
      pi: traced,
      at,
      name,
      clock: timers,
      signal: closing.signal,
      onFailed: (reason) => options.logger.warn({ sessionId: entry.sessionId, reason }, "fork failed"),
    });
  }

  /**
   * Makes a temporary directory for a fork into a new worktree, marked as the host's.
   *
   * @remarks
   * Under the host's own temporary directory (`tempRoot`, in Atrium's home), where no scan and no
   * pi in a terminal looks, and no other host's start removes it; its name starts with a fixed
   * prefix and it holds a marker, so a start of this host removes only these when a fork was cut
   * short (SPEC-0002, "带上下文的子对话怎么做出来"). Made once that removal is done.
   *
   * @sideEffects Creates the directory and its marker.
   * @returns The directory.
   */
  async function forkTempDir(): Promise<string> {
    // The removal at start must not come upon the directory of a fork under way.
    await leftoversGone.catch(() => undefined);
    const root = options.tempRoot ?? tmpdir();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(root, FORK_TEMP_PREFIX));
    try {
      await writeFile(join(dir, FORK_TEMP_MARKER), "");
    } catch (error) {
      // Without its marker no later start would remove it.
      await removeForkDir(dir);
      throw error;
    }
    return dir;
  }

  /**
   * Makes a child conversation in a new worktree from a fork in a temporary directory.
   *
   * @remarks
   * SPEC-0002 ("带上下文的子对话怎么做出来"): the worktree starts where the parent's workspace is
   * now; the child's pi starts there with `--fork <file> --session-id <id>`, which writes its file
   * before it answers; the temporary directory goes once it has, or once anything failed. The
   * child is told that the history's paths are the old directory's. When its pi does not start,
   * a child whose file was not written is forgotten; one whose file was is kept, under its parent,
   * and the fork answers `fork_failed` with its `sessionId`. A worktree made stays, as with creating a workspace.
   *
   * @sideEffects Creates a worktree; writes the index; starts pi; removes the temporary directory.
   * @param clientId - The client.
   * @param asked - Where the client was when it asked.
   * @param parent - The session forked.
   * @param temp - The temporary directory holding the fork's file.
   * @param branch - The branch name the user wanted.
   * @param name - The child's name.
   * @returns The child's id.
   * @throws {CommandError} `fork_failed`, `child_place_invalid`, `worktree_create_failed`.
   */
  async function forkIntoWorktree(
    clientId: string,
    asked: string | null,
    parent: CatalogEntry,
    temp: string,
    branch: string,
    name: string,
  ): Promise<{ sessionId: string; noteSent?: false }> {
    try {
      const file = (await readdir(temp)).find((candidate) => candidate.endsWith(".jsonl"));
      if (file === undefined) throw new CommandError("fork_failed");
      const intermediate = join(temp, file);
      const usageAfter = await lastEntryId(intermediate);
      const place = await worktreeFor(parent, branch);
      const sessionId = options.newSessionId();
      await options.catalog.record({
        sessionId,
        containerId: place.workspaceId,
        cwd: place.dir,
        parent: { sessionId: parent.sessionId, by: "user" },
        name,
        usageAfter,
      });
      // Detached at once when the parent was archived meanwhile, as it is in another workspace.
      await settleChild(sessionId);
      // Before its controller loads them, so its turns read as the parent's did.
      await copyTurnStarts(parent.sessionId, sessionId);
      forkFrom.set(sessionId, intermediate);
      let started: Running;
      try {
        started = await ensureRunning(sessionId);
      } catch (error) {
        options.logger.warn({ ...failureFields(error), sessionId }, "fork failed");
        await stopSession(sessionId);
        await options.catalog.scan();
        if (options.catalog.find(sessionId)?.state !== "persisted") {
          await options.catalog.forget(sessionId);
          throw new CommandError("fork_failed");
        }
        // pi wrote its file before it failed: the child stays under its parent (SPEC-0002).
        throw new CommandError("fork_failed", { sessionId });
      } finally {
        forkFrom.delete(sessionId);
      }
      const noted = await sendNote(started.pi, parent.cwd, place.dir).catch((error: unknown) => {
        options.logger.warn({ ...failureFields(error), sessionId }, "note not sent");
        return false;
      });
      await options.catalog.scan();
      await inClientOrder(clientId, async () => {
        const stayed = options.layouts.of(clientId).container === asked;
        await options.layouts.open(clientId, place.workspaceId, sessionId, stayed);
        options.onChange();
      });
      return noted ? { sessionId } : { sessionId, noteSent: false };
    } finally {
      await removeForkDir(temp);
    }
  }

  /**
   * Removes a fork's temporary directory.
   *
   * @remarks
   * What cannot be removed stays for the next start to remove; the fork's outcome is told as it
   * was, and the path is not logged (security.md).
   *
   * @sideEffects Removes the directory; may log.
   * @param dir - The directory.
   */
  async function removeForkDir(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) =>
      options.logger.warn(failureFields(error), "fork directory not removed"),
    );
  }

  /**
   * Detaches child conversations from their parents, telling the parents' agents.
   *
   * @remarks
   * A child the agent opened ends its open tasks as `detached` for the parent it had (SPEC-0002,
   * `ended`).
   *
   * @sideEffects Writes the index; may hand the parents' pi notices.
   * @param ids - The children.
   */
  async function detachAll(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const parentId = options.catalog.find(id)?.parent?.sessionId;
      await options.catalog.detach(id);
      if (parentId !== undefined) await relay.ended(id, "detached", parentId);
    }
  }

  /**
   * Creates the child conversation the agent asked for (SPEC-0002, `agent_spawn`).
   *
   * @remarks
   * In its own new worktree on `agent/<handle>` from where the parent's workspace is now, or, when
   * that was only the role's default and the parent's place has none, in the parent's container;
   * recorded under the parent as opened by the agent, named by its handle, not opened as a tab. A
   * child with its parent's conversation starts from the branch the parent's extension cut, its
   * usage counted from there, its turns read as the parent's were.
   *
   * @sideEffects May create a worktree; writes the index; copies turn starts.
   * @param request - The parent, the child's record, where it goes and its branch.
   * @returns The child and its worktree.
   * @throws {CommandError} `child_place_invalid`, `worktree_create_failed`, `session_not_found`.
   */
  async function createAgentChild(request: ChildRequest): Promise<ChildCreated> {
    const parent = entryOf(request.parentId);
    notArchived(parent.sessionId);
    let place: { readonly workspaceId: string; readonly dir: string; readonly branch: string } | null = null;
    if (request.worktree) {
      try {
        place = await agentWorktree(parent, request.agent.handle);
      } catch (error) {
        if (!request.fallback || !(error instanceof CommandError && error.code === "child_place_invalid")) throw error;
      }
    }
    const dir =
      place?.dir ??
      (isChatId(parent.containerId) ? chatOf(parent.containerId).dir : options.workspaces.dirOf(parent.containerId));
    if (dir === undefined) throw new CommandError("workspace_not_found", { workspaceId: parent.containerId });
    const usageAfter =
      request.branchFile === null ? null : await lastEntryId(request.branchFile).catch(() => UNREAD_BASELINE);
    const sessionId = options.newSessionId();
    await options.catalog.record({
      sessionId,
      containerId: place?.workspaceId ?? parent.containerId,
      cwd: dir,
      parent: { sessionId: parent.sessionId, by: "agent" },
      name: request.agent.handle,
      usageAfter,
      agent: { ...request.agent, worktree: place !== null },
    });
    await settleChild(sessionId);
    if (request.branchFile !== null) {
      await copyTurnStarts(parent.sessionId, sessionId);
      forkFrom.set(sessionId, request.branchFile);
    }
    return { sessionId, worktree: place === null ? null : { dir: place.dir, branch: place.branch } };
  }

  /**
   * Creates the new worktree a child the agent opens goes to.
   *
   * @remarks
   * As `worktreeFor`, on a branch `agent/<handle>` (SPEC-0002, "角色与限制 · 新建 worktree").
   *
   * @sideEffects Creates a worktree.
   * @param parent - The parent.
   * @param handle - The child's handle.
   * @returns The new workspace, its directory and branch.
   * @throws {CommandError} `child_place_invalid`, `worktree_create_failed`.
   */
  async function agentWorktree(parent: CatalogEntry, handle: string) {
    if (isChatId(parent.containerId) || options.childWorktree === undefined) {
      throw new CommandError("child_place_invalid");
    }
    return options.childWorktree(parent.containerId, handle, "agent/");
  }

  /**
   * Creates the new worktree a child conversation goes to.
   *
   * @remarks
   * Only from a workspace of a repository's project (SPEC-0002, "概念 · 位置"): a chat's session,
   * or a host without worktrees, can have its children only in its own container.
   *
   * @sideEffects Creates a worktree.
   * @param parent - The parent.
   * @param branch - The branch name the user wanted.
   * @returns The new workspace and its directory.
   * @throws {CommandError} `child_place_invalid`, `worktree_create_failed`.
   */
  async function worktreeFor(parent: CatalogEntry, branch: string) {
    if (isChatId(parent.containerId) || options.childWorktree === undefined) {
      throw new CommandError("child_place_invalid");
    }
    return options.childWorktree(parent.containerId, branch);
  }

  /**
   * Creates an empty child conversation in a new worktree (SPEC-0002, "第一步 · 入口").
   *
   * @remarks
   * As `createChild`, in a worktree that starts where the parent's workspace is now; the client
   * goes to that workspace.
   *
   * @sideEffects Creates a worktree; writes the index; starts pi in the background.
   * @param clientId - The client.
   * @param parent - The parent.
   * @param branch - The branch name the user wanted.
   * @param go - Whether the client goes there.
   * @param record - The child's parent and name.
   * @returns The new session's id.
   * @throws {CommandError} `child_place_invalid`, `worktree_create_failed`.
   */
  async function createChildWorktree(
    clientId: string,
    parent: CatalogEntry,
    branch: string,
    go: boolean,
    record: Pick<NewRecord, "parent" | "name">,
  ): Promise<string> {
    const place = await worktreeFor(parent, branch);
    return create(clientId, place.workspaceId, place.dir, go, record);
  }

  /**
   * Archives several sessions, keeping anything from starting them meanwhile.
   *
   * @remarks
   * As `whileArchiving`, for a session and the child conversations archived with it (SPEC-0002).
   *
   * @sideEffects Updates what is being archived; what `archive` does.
   * @param ids - The sessions.
   * @param archive - Stops and archives.
   */
  async function whileArchivingAll(ids: readonly string[], archive: () => Promise<void>): Promise<void> {
    mark(ids);
    try {
      await archive();
    } finally {
      unmark(ids);
    }
  }

  /**
   * Marks sessions or containers as being archived.
   *
   * @remarks
   * See `archiving`; each mark is taken off by an `unmark`.
   *
   * @sideEffects Updates what is being archived.
   * @param ids - The sessions or containers.
   */
  function mark(ids: readonly string[]): void {
    for (const id of ids) archiving.set(id, (archiving.get(id) ?? 0) + 1);
  }

  /**
   * Takes off the marks `mark` put on, telling those waiting.
   *
   * @remarks
   * An id stays marked while another archiving still marks it.
   *
   * @sideEffects Updates what is being archived; calls the waiters.
   * @param ids - The sessions or containers.
   */
  function unmark(ids: readonly string[]): void {
    for (const id of ids) {
      const left = (archiving.get(id) ?? 1) - 1;
      if (left === 0) archiving.delete(id);
      else archiving.set(id, left);
    }
    const waiting = [...archivingWaiters];
    archivingWaiters.clear();
    for (const wake of waiting) wake();
  }

  /**
   * Stops a session's pi as it is archived or handed off.
   *
   * @remarks
   * The end of its run meanwhile is not its task's: its parent is told `ended` afterwards
   * (SPEC-0002, "归档、脱离、交接"), not that the run failed.
   *
   * @sideEffects Stops pi; tells the relay.
   * @param sessionId - The session.
   */
  async function stopEnding(sessionId: string): Promise<void> {
    const over = relay.ending(sessionId);
    try {
      await stopSession(sessionId);
    } finally {
      over();
    }
  }

  /**
   * Brings a child just recorded under the archiving rules, as if it had been there when its
   * parent was archived.
   *
   * @remarks
   * SPEC-0002 ("归档、脱离、交接"): an archiving that began after the parent was looked at did
   * not see the child. Once no archiving marks the parent or its container any more, a child of
   * an archived parent is archived too in the parent's container and detached elsewhere, and its
   * tasks end as they would have then.
   *
   * @sideEffects Waits for archivings; may stop pi, archive or detach the child, end its tasks and
   * write layouts.
   * @param childId - The child.
   * @throws {CommandError} `session_not_found` for the parent, once the child was archived with it.
   */
  async function settleChild(childId: string): Promise<void> {
    const parentId = options.catalog.find(childId)?.parent?.sessionId;
    if (parentId === undefined) return;
    for (let parent = options.catalog.find(parentId); parent !== undefined; parent = options.catalog.find(parentId)) {
      if (!archiving.has(parentId) && !archiving.has(parent.containerId)) break;
      await new Promise<void>((resolve) => archivingWaiters.add(resolve));
    }
    const parent = options.catalog.find(parentId);
    const child = options.catalog.find(childId);
    if (parent?.archived !== true || child === undefined) return;
    if (child.containerId !== parent.containerId) {
      await options.catalog.detach(childId);
      await relay.ended(childId, "detached", parentId);
      return;
    }
    await stopEnding(childId);
    forget(childId);
    await options.catalog.archive(childId);
    await relay.ended(childId, "archived");
    await options.layouts.forgetSessions([childId]);
    options.onChange();
    throw new CommandError("session_not_found", { sessionId: parentId });
  }

  /**
   * Creates an empty child conversation of a session (SPEC-0002, "第一步 · 入口").
   *
   * @remarks
   * In the parent's container, under it, with the name given; the user opens as many levels as
   * they like. A parent that is a draft has no file to hang it under yet; one archived, being
   * archived or gone has none.
   *
   * @sideEffects Writes the index; starts pi in the background; may create a worktree.
   * @param clientId - The client.
   * @param containerId - The container the client asked for.
   * @param child - The parent, the name and where it goes.
   * @param go - Whether the client goes there, as it does unless it moved meanwhile.
   * @returns The new session's id.
   * @throws {CommandError} `session_not_found`, `session_is_draft`, `child_place_invalid`.
   */
  async function createChild(
    clientId: string,
    containerId: string,
    child: ChildPlacement,
    go: boolean,
  ): Promise<string> {
    await options.catalog.ready();
    const parent = entryOf(child.parentSessionId);
    if (parent.state === "missing") throw new CommandError("session_not_found", { sessionId: parent.sessionId });
    notArchived(parent.sessionId);
    if (parent.state === "draft") throw new CommandError("session_is_draft", { sessionId: parent.sessionId });
    const record = { parent: { sessionId: parent.sessionId, by: "user" as const }, name: child.name };
    if (child.place === "worktree") return createChildWorktree(clientId, parent, child.branch, go, record);
    if (containerId !== parent.containerId) throw new CommandError("child_place_invalid");
    const dir = isChatId(parent.containerId)
      ? chatOf(parent.containerId).dir
      : options.workspaces.dirOf(parent.containerId);
    if (dir === undefined) throw new CommandError("workspace_not_found", { workspaceId: parent.containerId });
    return create(clientId, parent.containerId, dir, go, record);
  }

  /**
   * Archives a session, or a container's sessions, keeping anything from starting them meanwhile.
   *
   * @remarks
   * See `notArchived`; a container's mark also keeps sessions from being created in it. The mark
   * goes once archived, or once archiving failed.
   *
   * @sideEffects Updates what is being archived; what `archive` does.
   * @param id - The session or container.
   * @param archive - Stops and archives.
   * @returns What `archive` returns.
   */
  async function whileArchiving<T>(id: string, archive: () => Promise<T>): Promise<T> {
    mark([id]);
    try {
      return await archive();
    } finally {
      unmark([id]);
    }
  }

  /**
   * Whether a session has something going on that handing it off would cut short.
   *
   * @remarks
   * A run (a stop under way is one), a message on its way, a run pi said it started that has not
   * begun yet, a restart, a compaction or a fork under way, or messages in the host's queue, which
   * only Atrium would send (SPEC-0001, "交给终端", "M1.11 的 `/` 命令 · 压缩").
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
    return (
      controller.submitting ||
      controller.forking ||
      control.restarting ||
      control.compacting ||
      control.queue.length > 0
    );
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
