import {
  AGENT_COMMAND,
  type AgentErrorCode,
  type AgentEvent,
  type AgentProgress,
  type AgentRequest,
  type CallResults,
  type CancelReason,
  type Delivery,
  FINAL_EVENTS,
  HANDLE,
  type ListedChild,
  type LogEntry,
  REPLY_LIMIT,
  type ReadResult,
  encodeArgument,
  readRequest,
} from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import type {
  AgentRole,
  AgentStatus,
  CatalogModel,
  DeliveryItem,
  SessionAgent,
  SessionModel,
  ThinkingLevel,
} from "@atrium/protocol";
import { dirname } from "node:path";
import type { Clock } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { AgentRecord, AgentTask, DeliveryRecord } from "../store/agent-records";
import { agentDepth, childrenOf, descendantsOf } from "./child-tree";
import type { AgentFields, CatalogEntry, SessionCatalog } from "./session-catalog";
import type { ControllerDeliveries, PendingDelivery, RunOpening, SessionController } from "./session-controller";

/** The most children an agent may have unfinished at once (SPEC-0002, "概念 · 数量"). */
const MAX_CHILDREN = 6;

/** The agent depth at which a session opens no children (SPEC-0002, "概念 · 层数"). */
const MAX_DEPTH = 2;

/** How long `agent_reply` waits for the child's extension to take or close an answer, each time. */
const REPLY_CONFIRM_MS = 10_000;

/** How many answered calls' replies a process keeps, for a request it repeats (ADR-0013, point 4). */
const KEPT_REPLIES = 64;

/** How many questions a child no longer has open are kept, for an answer repeated to one (SPEC-0002, `agent_reply`). */
const KEPT_QUESTIONS = 16;

/** The longest branch a notice gives (`AgentNoticeEvent`). */
const BRANCH_LIMIT = 256;

/** What `agent_read` reads by default: characters of a reply, or steps. */
const READ_DEFAULTS = { reply: 8000, steps: 10 } as const;

/** The longest step title `agent_read` gives. */
const STEP_TITLE = 120;

/** The order of thinking levels, low to high, for picking a supported one (SPEC-0002, "推理档位"). */
const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A session's run, as the manager knows it. */
export interface SessionState {
  /** Its pi runs. */
  readonly live: boolean;
  /** A run is in progress, or about to begin. */
  readonly running: boolean;
  /** A dialog waits for you. */
  readonly asking: boolean;
  /** The queue is paused: you stopped, or pi crashed past its restarts. */
  readonly paused: "stopped" | "crashed" | null;
  /** pi crashed past its restarts. */
  readonly failed: boolean;
  /** Messages in its queue. */
  readonly queued: number;
}

/** A child the agent asked for, as the manager creates it. */
export interface ChildRequest {
  readonly parentId: string;
  readonly agent: AgentRecord;
  /** A worktree of its own, or the parent's container. */
  readonly worktree: boolean;
  /** The branch the parent's extension cut, for a child with its parent's conversation. */
  readonly branchFile: string | null;
  /** The worktree was only the role's default: without one, the parent's container will do. */
  readonly fallback: boolean;
}

/** What the manager made of a child. */
export interface ChildCreated {
  readonly sessionId: string;
  /** Its own worktree's directory and branch; `null` in the parent's container. */
  readonly worktree: { readonly dir: string; readonly branch: string } | null;
}

/** What the relay needs of the host: the index, the sessions' pi and their workspaces. */
export interface AgentHost {
  readonly catalog: Pick<SessionCatalog, "list" | "find" | "changeAgent">;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly logger: Logger;
  /** Sends a hidden command to a session's pi, if it is still the one of `epoch`; whether it went. */
  command(sessionId: string, epoch: number, message: string): Promise<boolean>;
  /** The session's controller, if its pi runs. */
  controller(sessionId: string): SessionController | undefined;
  state(sessionId: string): SessionState;
  ensureRunning(sessionId: string): Promise<void>;
  /** Stops an agent child's pi after a run, as a requested stop; it starts again when needed. */
  recycle(sessionId: string): Promise<void>;
  /** Lets a session's paused queue go again, as "继续发送" does. */
  resumeQueue(sessionId: string): Promise<void>;
  /**
   * A `work` child's branch, and what its worktree changed since it was made, committed or not
   * (SPEC-0002, "交付"); `null` for what cannot be read.
   */
  workChanges(sessionId: string): Promise<{ readonly branch: string | null; readonly changes: WorkChanges | null }>;
  /** Whether a tab shows the session in any window. */
  tabOpen(sessionId: string): boolean;
  /** Whether the session, or its container, is being archived. */
  archiving(sessionId: string): boolean;
  /** Whether a session's place allows a worktree of its own: a project's git workspace. */
  canBranch(sessionId: string): boolean;
  createChild(request: ChildRequest): Promise<ChildCreated>;
  /** The models a session's directory can use. */
  models(sessionId: string): Promise<readonly CatalogModel[]>;
  /** The model a session's pi uses now, if known. */
  modelOf(sessionId: string): SessionModel | null;
  readEntries(file: string): Promise<LogEntry[]>;
  /** Tells a child forked into a new worktree where it works (SPEC-0002, "带上下文的子对话怎么做出来"). */
  noteMoved(sessionId: string, from: string, to: string): Promise<void>;
  /** A new temporary directory for a branch, the host's own. */
  tempDir(): Promise<string>;
  removeDir(dir: string): Promise<void>;
  /** The summaries changed. */
  changed(): void;
}

/** What a `work` child changed in its own worktree. */
export interface WorkChanges {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
}

/** Why a session's deliveries wait for you: the host restarted, or pi did not take them (SPEC-0002, "送达"). */
type HoldReason = "restart" | "stalled";

/** The agent relay: the host's end of Atrium's extension (SPEC-0002, ADR-0013). */
export interface AgentRelay {
  /** A status a session's pi sent on Atrium's channel. */
  request(sessionId: string, epoch: number, text: string): void;
  /** A session's pi of `epoch` exited. */
  exited(sessionId: string, epoch: number): void;
  /** What a session's controller is told of its deliveries and gives back of its runs. */
  deliveries(sessionId: string): ControllerDeliveries;
  /** What a session's summary shows of its agent state. */
  summary(sessionId: string): { readonly agent: SessionAgent | null; readonly heldDeliveries: number };
  /** Whether a dialog waits for you in a session, as its control says. */
  asking(sessionId: string, asking: boolean): void;
  /** A tab of a session closed: an agent child idle without one stops its pi. */
  tabClosed(sessionId: string): void;
  /**
   * A session's pi is about to be stopped because it is archived or handed off: the end of its run
   * meanwhile is not its task's, which `ended` tells instead. Call the result once it stopped.
   */
  ending(sessionId: string): () => void;
  /** A child stopped being its parent's: archived, detached from `parentId`, or handed to a terminal. */
  ended(sessionId: string, reason: "archived" | "detached" | "handed_off", parentId?: string): Promise<void>;
  /** A session handed off came back: what waited for it can go. */
  takenBack(sessionId: string): void;
  /**
   * Takes a delivery out of a session's queue panel.
   *
   * @throws {CommandError} `delivery_not_found`, `delivery_sending`.
   */
  removeDelivery(sessionId: string, deliveryId: string): Promise<void>;
  /**
   * Lets go the session's held deliveries, whyever they are held; with `tree`, those held since
   * the host restarted in it and below it ("全部继续"), not the ones pi did not take.
   */
  resumeDeliveries(sessionId: string, tree: boolean): Promise<void>;
  /** Reads the index once it is loaded: what was held, lost or open when the host stopped. */
  start(): Promise<void>;
  /** The host stops: tasks running are told `stopped` (SPEC-0002, "送达"). */
  close(): Promise<void>;
}

/**
 * A call's failure, as the extension is answered.
 *
 * @remarks
 * Thrown by an operation and caught where the call is answered, so each check can stop it.
 *
 * @sideEffects none
 */
class AgentFailure extends Error {
  /**
   * A failure with its code and parameters.
   *
   * @remarks
   * The host sends only codes (ADR-0013, point 9).
   *
   * @sideEffects none
   * @param code - The code.
   * @param params - Its parameters.
   */
  constructor(
    readonly code: AgentErrorCode,
    readonly params: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    // Stryker disable next-line StringLiteral: the name is never read; a failure is answered by its code.
    this.name = "AgentFailure";
  }
}

/** A question a child asked its parent's agent (SPEC-0002, `ask_parent`). */
interface Question {
  readonly childId: string;
  /** Its id, its `ask_parent` call's. */
  readonly questionId: string;
  readonly epoch: number;
  readonly parentId: string;
  readonly taskId: string;
  readonly text: string;
  readonly options: readonly string[];
  state: "open" | "answered" | "closed";
  /** The answer that counted, the first one given (SPEC-0002, `agent_reply`). */
  given: string | null;
  /** The last `agent_reply` to it, which the next waits for. */
  replies: Promise<unknown>;
  /** Answers the child's call, or drops it with `null`; set while it waits. */
  answer: ((result: CallResults["ask"] | null) => void) | null;
  /** Told of the child's notes `answered` and `closed`. */
  readonly heard: Set<(op: "answered" | "closed") => void>;
}

/** What runs in a child now, for its notices (SPEC-0002, "通知父会话的事件"). */
interface RunTask {
  /** The task the run works on; `null` for a turn you opened. */
  readonly taskId: string | null;
  readonly at: number;
}

/**
 * Whether a role only reads.
 *
 * @remarks
 * `explore` and `advise` (SPEC-0002, "角色与限制").
 *
 * @sideEffects none
 * @param role - The role.
 * @returns Whether.
 */
function readOnly(role: AgentRole | null | undefined): boolean {
  return role === "explore" || role === "advise";
}

/**
 * A level a model supports, from the one wanted.
 *
 * @remarks
 * As pi does: the next level up it supports, else the next down (SPEC-0002, "推理档位").
 *
 * @sideEffects none
 * @param wanted - The level.
 * @param supported - The model's levels.
 * @returns The level.
 */
function supportedLevel(wanted: ThinkingLevel, supported: readonly ThinkingLevel[]): ThinkingLevel {
  if (supported.includes(wanted)) return wanted;
  const at = LEVELS.indexOf(wanted);
  return (
    LEVELS.slice(at + 1).find((level) => supported.includes(level)) ??
    LEVELS.slice(0, at).findLast((level) => supported.includes(level)) ??
    "off"
  );
}

/**
 * The text of an assistant entry.
 *
 * @remarks
 * Its text parts, joined; thinking and tool calls are not the reply.
 *
 * @sideEffects none
 * @param entry - The entry.
 * @returns The text, or `null` when it is no assistant entry.
 */
function replyText(entry: LogEntry | undefined): string | null {
  if (entry?.kind !== "assistant") return null;
  return entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * The entries of one task's run, from its message to the next turn's start.
 *
 * @remarks
 * A task opens at its `atrium-agent` message; the run ends at the next task or message of yours.
 * Words added to the task in its run do not end it (SPEC-0002, `agent_send`).
 *
 * @sideEffects none
 * @param entries - The child's entries.
 * @param taskId - The task.
 * @returns The entries after the task's message, or `null` when it is not there.
 */
function taskEntries(entries: readonly LogEntry[], taskId: string): LogEntry[] | null {
  const at = entries.findIndex(
    // Stryker disable next-line ConditionalExpression: notices' details carry no task id, so only a task's can match.
    (entry) => entry.kind === "agent" && entry.details.kind === "task" && entry.details.taskId === taskId,
  );
  if (at === -1) return null;
  const rest = entries.slice(at + 1);
  const end = rest.findIndex(
    (entry) =>
      entry.kind === "user" ||
      (entry.kind === "agent" && entry.details.kind === "task" && entry.details.steer !== true),
  );
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * A tool call's title, as `agent_read` lists steps.
 *
 * @remarks
 * Its tool and the first of its arguments that is text, cut to {@link STEP_TITLE}.
 *
 * @sideEffects none
 * @param tool - The tool.
 * @param args - Its arguments.
 * @returns The title.
 */
function stepTitle(tool: string, args: Readonly<Record<string, unknown>>): string {
  const first = Object.values(args).find((value) => typeof value === "string");
  return `${tool}${typeof first === "string" ? ` ${first.replaceAll(/\s+/gu, " ")}` : ""}`.slice(0, STEP_TITLE);
}

/**
 * A session's display name, as the agent's tools and notices give it.
 *
 * @remarks
 * Its name, else its first message, else its handle.
 *
 * @sideEffects none
 * @param entry - The session.
 * @returns The name.
 */
function titleOf(entry: CatalogEntry | undefined): string {
  return entry?.name ?? entry?.prompt ?? entry?.agent?.handle ?? "";
}

/**
 * Whether a session is one the agent opened.
 *
 * @remarks
 * Its record has an agent part and its parent link says `agent`.
 *
 * @sideEffects none
 * @param entry - The session.
 * @returns Whether.
 */
function isAgentChild(entry: CatalogEntry | undefined): entry is CatalogEntry & { agent: AgentRecord } {
  return entry?.agent != null && entry.parent?.by === "agent";
}

/**
 * The key of a call: its session, process and request id.
 *
 * @remarks
 * A request is the same one only in the same process (ADR-0013, points 4 and 5).
 *
 * @sideEffects none
 * @param sessionId - The session.
 * @param epoch - Its process.
 * @param id - The request.
 * @returns The key.
 */
function callKey(sessionId: string, epoch: number, id: string): string {
  return `${sessionId}#${String(epoch)}#${id}`;
}

/**
 * The tasks the host lost when it was killed: open, with nothing on its way for them.
 *
 * @remarks
 * SPEC-0002, "送达"'s table, "宿主重启后" (2026-10-18): a task still open whose child has no
 * delivery of it waiting to go, and whose parent has no final notice of it waiting, had its run
 * cut short with the host, which did not get to say `stopped`.
 *
 * @sideEffects none
 * @param entries - The index.
 * @returns The tasks, with their child and parent.
 */
function lostTasks(
  entries: readonly CatalogEntry[],
): { readonly childId: string; readonly parentId: string; readonly taskId: string }[] {
  return entries.flatMap((entry) => {
    const parentId = entry.parent?.sessionId;
    if (!isAgentChild(entry) || entry.archived || parentId === undefined) return [];
    const parent = entries.find((one) => one.sessionId === parentId);
    return entry.agent.tasks.flatMap((task) => {
      if (task.state !== "open") return [];
      const toGo = entry.deliveries.some((delivery) => delivery.kind === "task" && delivery.taskId === task.taskId);
      const told = (parent?.deliveries ?? []).some(
        (delivery) =>
          delivery.from === entry.sessionId &&
          delivery.taskId === task.taskId &&
          FINAL_EVENTS.includes(delivery.event ?? "finished"),
      );
      return toGo || told ? [] : [{ childId: entry.sessionId, parentId, taskId: task.taskId }];
    });
  });
}

/**
 * Creates the agent relay.
 *
 * @remarks
 * SPEC-0002, "第二步", and ADR-0013. Each call from a session's pi is answered once per request id
 * and process (`epoch`); a second ask with the same id waits for the first. Who calls is the
 * session whose pi the status came from. A parent's spawns, and sends that set an idle child to
 * work, are accepted one at a time, so the count of unfinished children holds. Tasks, deliveries
 * and handles live in the sessions' records; questions, progress and what each run works on live here and do not outlast the host,
 * which holds the deliveries for you when it starts again. An agent child that ends a run idle,
 * without a tab, has its pi stopped, and started again when there is something for it.
 *
 * @sideEffects none until called; then reads and writes the index, starts, stops and commands pi,
 * reads session files, and makes and removes temporary directories.
 * @param host - What the relay needs of the host.
 * @returns The relay.
 */
export function createAgentRelay(host: AgentHost): AgentRelay {
  const { catalog, clock } = host;
  /** Calls under way, by session, process and request id (ADR-0013, point 4). */
  const calls = new Map<string, Promise<void>>();
  /**
   * Calls answered, by session and process: their ids, and the latest replies, to send again for a
   * request repeated (ADR-0013, point 4).
   */
  const answeredCalls = new Map<string, { readonly ids: Set<string>; readonly replies: Map<string, unknown> }>();
  /** Each parent's last accepted spawn or send, which the next waits for. */
  const turns = new Map<string, Promise<unknown>>();
  /** Children being created, by parent: they count as unfinished. */
  const creating = new Map<string, number>();
  /** Children made but whose first run has not begun. */
  const fresh = new Set<string>();
  /** Children asleep whose pi is being started for what waits for them: each holds a place (SPEC-0002, "送达"). */
  const waking = new Set<string>();
  /** Sessions archived or handed off whose pi is being stopped: their run's end is not their task's. */
  const endingNow = new Map<string, number>();
  /** Set once the host closes: what is told then is only recorded (SPEC-0002, "送达"). */
  let closing = false;
  /** What each child's run works on. */
  const runs = new Map<string, RunTask>();
  /** Tasks whose run ended and whose end is being told, before they are written done. */
  const ending = new Set<string>();
  /** A task whose run pi interrupted by crashing, which a restart carries on. */
  const interrupted = new Map<string, string>();
  /** Why a child was stopped, for its `stopped` event. */
  const stopReasons = new Map<string, string>();
  /** Each child's latest progress, and whether its parent has it. */
  const progress = new Map<string, { message: string; passed: boolean }>();
  /** Open and recently closed questions, by child and question id. */
  const questions = new Map<string, Map<string, Question>>();
  /** Sessions whose deliveries wait for you, and why. */
  const held = new Map<string, HoldReason>();
  /** Temporary directories handed to a process for branches, by session and process. */
  const branchDirs = new Map<string, Set<string>>();
  /** Children asking you, so `needs_you` goes once each time. */
  const askingNow = new Set<string>();
  /** Each child's last start or stop of its pi, which the next waits for. */
  const lifecycles = new Map<string, Promise<unknown>>();

  /**
   * A session's entry.
   *
   * @remarks
   * From the catalog, as it is now.
   *
   * @sideEffects none
   * @param sessionId - The session.
   * @returns The entry.
   */
  const find = (sessionId: string): CatalogEntry | undefined => catalog.find(sessionId);

  /**
   * Changes a session's agent fields.
   *
   * @remarks
   * Every write of tasks, deliveries and handles goes through here.
   *
   * @sideEffects Writes the index.
   * @param sessionId - The session.
   * @param edit - The change.
   */
  const change = (sessionId: string, edit: (fields: AgentFields) => AgentFields): Promise<void> =>
    catalog.changeAgent(sessionId, edit);

  /**
   * Changes a child's agent record.
   *
   * @remarks
   * A session without one is left alone.
   *
   * @sideEffects Writes the index.
   * @param sessionId - The child.
   * @param update - The change.
   */
  const changeRecord = (sessionId: string, update: (agent: AgentRecord) => AgentRecord): Promise<void> =>
    change(sessionId, (fields) => (fields.agent === null ? fields : { ...fields, agent: update(fields.agent) }));

  /**
   * A child's status, as `agent_list` and the child list show it.
   *
   * @remarks
   * SPEC-0002, `agent_list`: ended once archived or gone, handed off, being created, asking its
   * parent, asking you, running, with work queued, failed, stopped, or idle.
   *
   * @sideEffects none
   * @param entry - The child.
   * @returns The status.
   */
  const statusOf = (entry: CatalogEntry): AgentStatus => {
    if (entry.archived || entry.state === "missing") return "ended";
    if (entry.handedOff) return "handed_off";
    if (fresh.has(entry.sessionId)) return "creating";
    if ([...(questions.get(entry.sessionId)?.values() ?? [])].some((question) => question.state === "open"))
      return "waiting_for_parent";
    const state = host.state(entry.sessionId);
    if (state.asking) return "waiting_for_you";
    if (state.running) return "running";
    if (state.failed || entry.attention?.reason === "error") return "failed";
    if (state.paused === "stopped") return "stopped";
    const waiting = entry.deliveries.length > 0;
    return (state.queued > 0 && state.paused === null) || (waiting && !held.has(entry.sessionId)) ? "queued" : "idle";
  };

  /**
   * A child's status by its id.
   *
   * @remarks
   * One the catalog does not list yet is being created.
   *
   * @sideEffects none
   * @param sessionId - The child.
   * @returns The status.
   */
  const statusOfId = (sessionId: string): AgentStatus => {
    const entry = find(sessionId);
    return entry === undefined ? "creating" : statusOf(entry);
  };

  /**
   * Whether a child counts against its parent's six.
   *
   * @remarks
   * SPEC-0002, "概念 · 数量": being created, running or asking its parent, with work queued, or
   * asking you. Idle, stopped, failed, handed off and ended do not. One whose pi was recycled
   * waits for a place without taking one: it takes it only as its pi is started (2026-10-18).
   *
   * @sideEffects none
   * @param entry - The child.
   * @returns Whether.
   */
  const unfinished = (entry: CatalogEntry): boolean => {
    const status = statusOf(entry);
    if (status === "queued") return host.state(entry.sessionId).live || waking.has(entry.sessionId);
    return ["creating", "running", "waiting_for_you", "waiting_for_parent"].includes(status);
  };

  /**
   * A parent's children the agent opened.
   *
   * @remarks
   * Archived ones included; callers filter.
   *
   * @sideEffects none
   * @param parentId - The parent.
   * @returns The children.
   */
  const agentChildren = (parentId: string): (CatalogEntry & { agent: AgentRecord })[] =>
    childrenOf(catalog.list(), parentId).filter(isAgentChild);

  /**
   * Whether a parent may set one more child to work, and who keeps it from it.
   *
   * @remarks
   * Those being created count (SPEC-0002, "角色与限制 · 名额").
   *
   * @sideEffects none
   * @param parentId - The parent.
   * @param besides - A child to leave out, the one about to be set to work.
   * @returns The handles of its unfinished children, when it may not; `null` when it may.
   */
  const full = (parentId: string, besides?: string): string[] | null => {
    const busy = agentChildren(parentId).filter((child) => child.sessionId !== besides && unfinished(child));
    return busy.length + (creating.get(parentId) ?? 0) >= MAX_CHILDREN ? busy.map((child) => child.agent.handle) : null;
  };

  /**
   * Runs a parent's acceptance after the ones before.
   *
   * @remarks
   * SPEC-0002, "角色与限制 · 名额": checking the count and taking a place happen together.
   *
   * @sideEffects Runs `work` in turn.
   * @param parentId - The parent.
   * @param work - The acceptance.
   * @returns What it gives.
   */
  const inTurn = <T>(parentId: string, work: () => Promise<T>): Promise<T> => {
    const turn = (turns.get(parentId) ?? Promise.resolve()).then(work, work);
    turns.set(
      parentId,
      turn.catch(() => undefined),
    );
    return turn;
  };

  /**
   * Runs a child's pi start or stop after the ones before.
   *
   * @remarks
   * SPEC-0002, "角色与限制 · 进程": a stop never crosses a start.
   *
   * @sideEffects Runs `work` in turn.
   * @param childId - The child.
   * @param work - The start or stop.
   * @returns Once it ran.
   */
  const lifecycle = (childId: string, work: () => Promise<void>): Promise<void> => {
    const next = (lifecycles.get(childId) ?? Promise.resolve()).then(work, work);
    lifecycles.set(
      childId,
      next.catch(() => undefined),
    );
    return next;
  };

  /**
   * Sends a session's pi a hidden command, if it is still the process of `epoch`.
   *
   * @remarks
   * ADR-0013, point 5: a newer process does not get what an older one asked for.
   *
   * @sideEffects Calls pi.
   * @param sessionId - The session.
   * @param epoch - Its process.
   * @param action - The command's action.
   * @param value - Its argument.
   * @returns Whether it went.
   */
  const tell = (sessionId: string, epoch: number, action: string, value: unknown): Promise<boolean> =>
    host.command(sessionId, epoch, `/${AGENT_COMMAND} ${action} ${encodeArgument(value)}`).catch(() => false);

  /**
   * The caller's child that `to` names.
   *
   * @remarks
   * SPEC-0002, "句柄与显示名" and "错误码": a handle among the caller's children, or `id:` and a
   * session id. Another's, or one detached, is `agent_not_allowed`; one whose record went, `agent_gone`.
   * For what changes it, an archived one is `agent_gone` too, one handed off `agent_handed_off`,
   * one being archived `agent_busy`.
   *
   * @sideEffects none
   * @param callerId - The caller.
   * @param to - The name.
   * @param acting - Whether the call changes the child, not only reads it.
   * @returns The child.
   * @throws {AgentFailure} As above.
   */
  const childNamed = (callerId: string, to: string, acting: boolean): CatalogEntry & { agent: AgentRecord } => {
    const entries = catalog.list();
    const byId = to.startsWith("id:") ? entries.find((entry) => entry.sessionId === to.slice(3)) : undefined;
    const target = byId ?? entries.find((entry) => entry.parent?.sessionId === callerId && entry.agent?.handle === to);
    if (target === undefined) {
      const used = find(callerId)?.usedHandles.includes(to) === true;
      const detached = entries.some((entry) => entry.agent?.handle === to && entry.parent === null);
      throw new AgentFailure(
        used && !detached ? "agent_gone" : to.startsWith("id:") ? "agent_gone" : "agent_not_allowed",
      );
    }
    if (target.parent?.sessionId !== callerId || !isAgentChild(target)) throw new AgentFailure("agent_not_allowed");
    if (target.state === "missing") throw new AgentFailure("agent_gone");
    if (acting && target.archived) throw new AgentFailure("agent_gone");
    if (acting && target.handedOff) throw new AgentFailure("agent_handed_off");
    if (acting && host.archiving(target.sessionId)) throw new AgentFailure("agent_busy");
    return target;
  };

  /**
   * The task of a parent's run now, which a child it opens or sets to work goes under.
   *
   * @remarks
   * SPEC-0002, "通知父会话的事件": a grandchild's task keeps the task its parent was on.
   *
   * @sideEffects none
   * @param parentId - The parent.
   * @returns The task, or `undefined` for a turn you opened, or a session no agent opened.
   */
  const originOf = (parentId: string): string | undefined => runs.get(parentId)?.taskId ?? undefined;

  /**
   * Adds a task to a child and its delivery.
   *
   * @remarks
   * The text waits in the child's record until pi wrote it (SPEC-0002, "送达").
   *
   * @sideEffects Writes the index.
   * @param childId - The child.
   * @param parentId - Its parent.
   * @param text - What to do.
   * @returns The task's id.
   */
  const giveTask = async (childId: string, parentId: string, text: string): Promise<string> => {
    const taskId = `t-${host.newId()}`;
    const at = clock.now();
    const origin = originOf(parentId);
    const task: AgentTask = { taskId, state: "open", at, ...(origin === undefined ? {} : { originTask: origin }) };
    const delivery: DeliveryRecord = {
      id: host.newId(),
      kind: "task",
      from: parentId,
      taskId,
      text,
      at,
      state: "waiting",
    };
    await change(childId, (fields) => ({
      ...fields,
      agent: fields.agent === null ? null : { ...fields.agent, tasks: [...fields.agent.tasks, task] },
      deliveries: [...fields.deliveries, delivery],
    }));
    return taskId;
  };

  /**
   * Adds words to the task a child works on, as a delivery of that task.
   *
   * @remarks
   * SPEC-0002, `agent_send`: no new task; the words go into the run going at its next turn's end.
   *
   * @sideEffects Writes the index.
   * @param childId - The child.
   * @param parentId - Its parent.
   * @param taskId - The task in hand.
   * @param text - The words.
   */
  const giveWords = async (childId: string, parentId: string, taskId: string, text: string): Promise<void> => {
    const delivery: DeliveryRecord = {
      id: host.newId(),
      kind: "task",
      from: parentId,
      taskId,
      text,
      at: clock.now(),
      state: "waiting",
      steer: true,
    };
    await change(childId, (fields) => ({ ...fields, deliveries: [...fields.deliveries, delivery] }));
  };

  /**
   * Keeps what a call was answered, for a request repeated.
   *
   * @remarks
   * ADR-0013, point 4: a call answered is not made again; the same answer goes again for the
   * latest {@link KEPT_REPLIES} of a process. Nothing is kept for a process that exited.
   *
   * @sideEffects Updates what is kept.
   * @param process - The session and process.
   * @param id - The request.
   * @param reply - Its answer; `undefined` when none was sent.
   */
  const remember = (process: string, id: string, reply: unknown): void => {
    const done = answeredCalls.get(process);
    if (done === undefined) return;
    done.ids.add(id);
    if (reply === undefined) return;
    done.replies.set(id, reply);
    for (const old of [...done.replies.keys()].slice(0, Math.max(0, done.replies.size - KEPT_REPLIES)))
      done.replies.delete(old);
  };

  /**
   * Lets go a session's hold once nothing held is left.
   *
   * @remarks
   * The queue panel's "宿主重启后暂停" or "没送出去" goes with the last delivery it held.
   *
   * @sideEffects May let go the hold; tells the summaries.
   * @param sessionId - The session.
   */
  const settleHold = (sessionId: string): void => {
    if (!held.has(sessionId)) return;
    const left = (find(sessionId)?.deliveries ?? []).some(
      (delivery) => delivery.state === "waiting" || delivery.state === "sending",
    );
    if (left) return;
    held.delete(sessionId);
    host.changed();
  };

  /**
   * Hands a session what waits for it, starting its pi when it may.
   *
   * @remarks
   * SPEC-0002, "送达"'s table: an archived session's deliveries go; one handed off or held keeps
   * them; a running one takes them through its controller; an agent child asleep takes a place
   * among its parent's six only as its pi is started, in its parent's turn, and is looked at again
   * when a place frees. A caller that took the place already, in that turn, says so (`placed`).
   * Once the host closes, nothing is handed over or started.
   *
   * @sideEffects May write the index, start pi or hand pi deliveries.
   * @param sessionId - The session.
   * @param placed - Whether the caller took the child's place among the six already.
   */
  const wake = async (sessionId: string, placed = false): Promise<void> => {
    if (closing) return;
    const entry = find(sessionId);
    if (entry === undefined) return;
    if (entry.archived) {
      await change(sessionId, (fields) => ({ ...fields, deliveries: [] }));
      return;
    }
    const waiting = entry.deliveries.filter((delivery) => delivery.state === "waiting");
    if (waiting.length === 0 || entry.handedOff || held.has(sessionId)) return;
    const controller = host.controller(sessionId);
    if (controller !== undefined) {
      controller.deliveriesChanged();
      return;
    }
    const parentId = isAgentChild(entry) ? entry.parent?.sessionId : undefined;
    if (parentId !== undefined && !placed) {
      const took = await inTurn(parentId, async () => {
        // Started meanwhile, or by another wake, or no place free.
        if (closing || waking.has(sessionId) || host.controller(sessionId) !== undefined) return false;
        if (full(parentId, sessionId) !== null) return false;
        waking.add(sessionId);
        return true;
      });
      if (!took) return;
    } else if (parentId !== undefined) {
      waking.add(sessionId);
    }
    try {
      await lifecycle(sessionId, () => host.ensureRunning(sessionId));
      host.controller(sessionId)?.deliveriesChanged();
    } catch (error) {
      // Its place frees, but the others are not woken for it: one that cannot start would be tried again and again.
      host.logger.warn({ sessionId, err: error }, "session not started for its deliveries");
    } finally {
      waking.delete(sessionId);
    }
  };

  /**
   * Looks again at a parent's children that wait for a place among its six.
   *
   * @remarks
   * When a place frees (SPEC-0002, "送达"'s table): a sibling's run ends, a sibling is stopped,
   * archived, detached or handed off, or a new one could not start. Each takes its place in the parent's
   * turn, so as many start as there are places.
   *
   * @sideEffects May start pi.
   * @param parentId - The parent.
   */
  const wakeSiblings = (parentId: string): void => {
    if (closing) return;
    for (const child of agentChildren(parentId)) {
      if (
        host.controller(child.sessionId) === undefined &&
        child.deliveries.some((delivery) => delivery.state === "waiting")
      )
        // Fire and forget: the place is taken in the parent's turn, whoever waits for it.
        void wake(child.sessionId).catch((error: unknown) =>
          host.logger.warn({ sessionId: child.sessionId, err: error }, "session not started for its deliveries"),
        );
    }
  };

  /**
   * Stops an agent child's pi once it has nothing to do and no tab shows it.
   *
   * @remarks
   * SPEC-0002, "角色与限制 · 进程": a run ended, no tab, nothing queued or waiting to go to it, no
   * dialog, no question open. A `requested` stop, which the list does not show as a failure.
   *
   * @sideEffects May stop pi.
   * @param sessionId - The child.
   */
  const maybeRecycle = (sessionId: string): void => {
    const entry = find(sessionId);
    if (!isAgentChild(entry) || host.controller(sessionId) === undefined || host.tabOpen(sessionId)) return;
    const state = host.state(sessionId);
    if (state.running || state.asking || state.queued > 0) return;
    if (entry.deliveries.length > 0 || statusOf(entry) === "waiting_for_parent") return;
    // Fire and forget: the stop runs in the child's turn; a failure leaves its pi running.
    void lifecycle(sessionId, async () => {
      const now = find(sessionId);
      const again = host.state(sessionId);
      if (
        host.tabOpen(sessionId) ||
        again.running ||
        again.asking ||
        again.queued > 0 ||
        (now?.deliveries.length ?? 0) > 0
      )
        return;
      await host.recycle(sessionId);
    }).catch((error: unknown) => host.logger.warn({ sessionId, err: error }, "child's pi not stopped"));
  };

  /**
   * Reads what an event says, for the parent's agent.
   *
   * @remarks
   * SPEC-0002, "送达": the reply is read from the child's file by its entry and cut to 4000
   * characters; a question's text is the one the child asked; a `work` child in its own worktree
   * gives its directory, branch and what it changed with its delivery, its `finished` (SPEC-0002,
   * "交付"), as far as they can be read.
   *
   * @sideEffects Reads the child's file; reads its worktree's changes.
   * @param delivery - The notice.
   * @returns The event, or `null` when its child is gone.
   */
  const eventOf = async (delivery: DeliveryRecord): Promise<AgentEvent | null> => {
    const child = find(delivery.from);
    if (child?.agent == null || delivery.event === undefined) return null;
    let reply: AgentEvent["reply"];
    if (delivery.replyEntry != null && child.file !== null) {
      const entries = await host.readEntries(child.file).catch(() => []);
      const text = replyText(entries.find((entry) => entry.id === delivery.replyEntry)) ?? "";
      reply = { text: text.slice(0, REPLY_LIMIT), totalChars: text.length };
    }
    const question =
      delivery.questionId === undefined ? undefined : questions.get(child.sessionId)?.get(delivery.questionId);
    const worktree = child.agent.worktree && child.agent.role === "work";
    const delivered = worktree && delivery.event === "finished";
    const work = delivered ? await host.workChanges(child.sessionId).catch(() => null) : null;
    return {
      name: child.agent.handle,
      title: titleOf(child),
      sessionId: child.sessionId,
      taskId: delivery.taskId,
      event: delivery.event,
      ...(delivery.reason === undefined ? {} : { reason: delivery.reason }),
      ...(delivery.followUpOf === undefined ? {} : { followUpOf: delivery.followUpOf }),
      ...(delivery.elapsedMs === undefined ? {} : { elapsedMs: delivery.elapsedMs }),
      ...(reply === undefined ? {} : { reply }),
      ...(question === undefined
        ? {}
        : { questionId: delivery.questionId, question: question.text, options: [...question.options] }),
      ...(delivered ? { workspace: child.cwd } : {}),
      ...(work?.branch == null ? {} : { branch: work.branch.slice(0, BRANCH_LIMIT) }),
      ...(work?.changes == null ? {} : { changes: { ...work.changes } }),
    };
  };

  /**
   * Takes the progress a parent's children reported that it does not have yet.
   *
   * @remarks
   * SPEC-0002, `report_progress`: it rides along once, with the next notice or wait.
   *
   * @sideEffects Marks it passed on.
   * @param parentId - The parent.
   * @returns The progress.
   */
  const takeProgress = (parentId: string): AgentProgress[] =>
    agentChildren(parentId).flatMap((child) => {
      const latest = progress.get(child.sessionId);
      if (latest === undefined || latest.passed) return [];
      latest.passed = true;
      return [{ name: child.agent.handle, title: titleOf(child), message: latest.message }];
    });

  /**
   * Tells a parent what happened to its task, as a delivery.
   *
   * @remarks
   * SPEC-0002, "通知父会话的事件": a final event ends the task, once its notice is written: a
   * notice that could not be written leaves the task open, so its end is not lost. The notice
   * waits to go to the parent's pi. A question no longer open is not sent.
   *
   * @sideEffects Writes the index; may hand the parent's pi the notice or start it.
   * @param childId - The child.
   * @param fields - The event.
   */
  const report = async (
    childId: string,
    fields: Pick<DeliveryRecord, "taskId" | "event"> &
      Partial<Pick<DeliveryRecord, "reason" | "replyEntry" | "questionId" | "toolCallId" | "followUpOf" | "elapsedMs">>,
  ): Promise<void> => {
    const child = find(childId);
    const parentId = child?.parent?.sessionId;
    if (!isAgentChild(child) || parentId === undefined || fields.event === undefined) return;
    const final = FINAL_EVENTS.includes(fields.event);
    const task = child.agent.tasks.find((candidate) => candidate.taskId === fields.taskId);
    if (task === undefined || task.state === "done") return;
    const delivery: DeliveryRecord = {
      id: host.newId(),
      kind: "report",
      from: childId,
      at: clock.now(),
      state: "waiting",
      ...fields,
      ...(fields.elapsedMs === undefined ? { elapsedMs: Math.max(0, clock.now() - task.at) } : {}),
      ...(task.followUpOf === undefined ? {} : { followUpOf: task.followUpOf }),
    };
    await sendUp(parentId, delivery);
    if (final) {
      await changeRecord(childId, (agent) => ({
        ...agent,
        tasks: agent.tasks.map((one) =>
          one.taskId === fields.taskId ? { ...one, state: "done", replyEntry: fields.replyEntry ?? null } : one,
        ),
      }));
    }
    host.changed();
  };

  /**
   * Gives a parent an event of its task, as a delivery.
   *
   * @remarks
   * SPEC-0002, "送达": the event waits to go to the parent's pi.
   *
   * @sideEffects Writes the index; may hand the parent's pi the notice or start it.
   * @param parentId - The parent.
   * @param delivery - The event, as a delivery waiting to go.
   */
  const sendUp = async (parentId: string, delivery: DeliveryRecord): Promise<void> => {
    await change(parentId, (parent) => ({ ...parent, deliveries: [...parent.deliveries, delivery] }));
    await wake(parentId);
  };

  /**
   * Stops a child's run and those of the agent children below it, as `agent_stop` does.
   *
   * @remarks
   * SPEC-0002, `agent_stop`: down through children the agent opened, not past one you opened or
   * one detached; only those running.
   *
   * @sideEffects Stops runs.
   * @param childId - The child.
   * @param reason - Why, for their `stopped` events.
   * @returns The handles stopped.
   */
  const stopTree = async (childId: string, reason: string): Promise<string[]> => {
    const entries = catalog.list();
    const tree = [find(childId), ...descendantsOf(entries, childId)].filter(
      (entry): entry is CatalogEntry & { agent: AgentRecord } => isAgentChild(entry),
    );
    const below = new Set([childId]);
    const stopped: string[] = [];
    for (const entry of tree) {
      if (entry.sessionId !== childId && !below.has(entry.parent?.sessionId ?? "")) continue;
      below.add(entry.sessionId);
      const controller = host.controller(entry.sessionId);
      if (controller === undefined || !host.state(entry.sessionId).running) continue;
      stopReasons.set(entry.sessionId, reason);
      stopped.push(entry.agent.handle);
      await controller.stop();
    }
    return stopped;
  };

  /**
   * Answers `agent_spawn`: checks it, opens the child and gives it its first task.
   *
   * @remarks
   * SPEC-0002, `agent_spawn`, "角色与限制" and "错误码", in that order: depth, name, archiving,
   * role, place, model and level, the six; then a place is taken while the child is made. A
   * child with its parent's conversation starts from the branch the parent's extension cut, in a
   * directory this process was given, which goes once the child started.
   *
   * @sideEffects Writes the index; may create a worktree; starts the child's pi.
   * @param callerId - The parent.
   * @param epoch - Its process.
   * @param args - The tool's parameters.
   * @returns The child.
   * @throws {AgentFailure} As above.
   */
  const spawn = async (
    callerId: string,
    epoch: number,
    args: Extract<AgentRequest, { op: "spawn" }>["args"],
  ): Promise<CallResults["spawn"]> => {
    const accepted = await inTurn(callerId, () => accept(callerId, epoch, args));
    const { child, worktree, model, thinking, taskId } = accepted;
    const result: CallResults["spawn"] = {
      name: args.name,
      sessionId: child,
      taskId,
      role: args.role ?? "explore",
      place: worktree === null ? "same" : "worktree",
      ...(worktree === null ? {} : { workspace: worktree.dir, branch: worktree.branch }),
      model,
      thinking,
      status: statusOfId(child),
    };
    return result;
  };

  /**
   * Accepts a spawn in the parent's turn.
   *
   * @remarks
   * See `spawn`.
   *
   * @sideEffects As `spawn`.
   * @param callerId - The parent.
   * @param epoch - Its process.
   * @param args - The tool's parameters.
   * @returns The child, its place, model and level, and its task.
   * @throws {AgentFailure} As `spawn`.
   */
  const accept = async (
    callerId: string,
    epoch: number,
    args: Extract<AgentRequest, { op: "spawn" }>["args"],
  ): Promise<{
    child: string;
    worktree: ChildCreated["worktree"];
    model: string;
    thinking: ThinkingLevel;
    taskId: string;
  }> => {
    const entries = catalog.list();
    const caller = find(callerId);
    if (caller === undefined) throw new AgentFailure("agent_not_allowed");
    if (agentDepth(entries, callerId) >= MAX_DEPTH) throw new AgentFailure("agent_depth_limit");
    if (!HANDLE.test(args.name)) throw new AgentFailure("agent_name_invalid");
    if (caller.usedHandles.includes(args.name)) throw new AgentFailure("agent_name_taken");
    if (caller.archived || host.archiving(callerId)) throw new AgentFailure("agent_busy");
    const role = args.role ?? "explore";
    const callerReads = isAgentChild(caller) && readOnly(caller.agent.role);
    if (callerReads && !readOnly(role)) throw new AgentFailure("agent_role_not_allowed");
    const branchable = host.canBranch(callerId);
    if (args.place === "worktree" && (readOnly(role) || callerReads || !branchable))
      throw new AgentFailure("agent_place_invalid");
    const worktree = args.place === "worktree" || (args.place === undefined && role === "work" && branchable);
    const models = await host.models(callerId);
    const current = host.modelOf(callerId);
    const id = args.model ?? (current === null ? undefined : `${current.providerId}/${current.modelId}`);
    const model =
      id === undefined ? models[0] : models.find((candidate) => `${candidate.providerId}/${candidate.modelId}` === id);
    if (model === undefined) throw new AgentFailure("agent_model_unknown");
    if (args.thinking !== undefined && !model.thinkingLevels.includes(args.thinking))
      throw new AgentFailure("agent_thinking_invalid", { supported: [...model.thinkingLevels] });
    const thinking = args.thinking ?? supportedLevel(current?.thinkingLevel ?? "off", model.thinkingLevels);
    const busy = full(callerId);
    if (busy !== null) throw new AgentFailure("agent_limit", { children: busy });
    const forked = args.context === "fork";
    if (
      forked &&
      (args.branch === undefined || !branchDirs.get(`${callerId}#${String(epoch)}`)?.has(dirname(args.branch)))
    )
      throw new AgentFailure("agent_context_unavailable");
    creating.set(callerId, (creating.get(callerId) ?? 0) + 1);
    try {
      await change(callerId, (fields) => ({ ...fields, usedHandles: [...fields.usedHandles, args.name] }));
      const taskId = `t-${host.newId()}`;
      const origin = originOf(callerId);
      const agent: AgentRecord = {
        handle: args.name,
        role,
        toolGuard: forked ? "extension" : "flags",
        startOn: { providerId: model.providerId, modelId: model.modelId, thinkingLevel: thinking },
        worktree,
        tasks: [{ taskId, state: "open", at: clock.now(), ...(origin === undefined ? {} : { originTask: origin }) }],
      };
      let created: ChildCreated;
      try {
        created = await host.createChild({
          parentId: callerId,
          agent,
          worktree,
          branchFile: forked ? (args.branch ?? null) : null,
          fallback: args.place === undefined,
        });
      } catch (error) {
        const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
        if (typeof code === "string") throw new AgentFailure("agent_place_failed", { reason: code });
        throw error;
      }
      fresh.add(created.sessionId);
      await change(created.sessionId, (fields) => ({
        ...fields,
        deliveries: [
          ...fields.deliveries,
          {
            id: host.newId(),
            kind: "task",
            from: callerId,
            taskId,
            text: args.task,
            at: clock.now(),
            state: "waiting",
          },
        ],
      }));
      const moved = forked && created.worktree !== null ? { from: caller.cwd, to: created.worktree.dir } : null;
      // Fire and forget: `start` reports its own failures, and what it could not report is logged.
      void start(created.sessionId, forked ? args.branch : undefined, moved).catch((error: unknown) =>
        host.logger.warn({ sessionId: created.sessionId, err: error }, "child's failed start not told"),
      );
      return {
        child: created.sessionId,
        worktree: created.worktree,
        model: `${model.providerId}/${model.modelId}`,
        thinking,
        taskId,
      };
    } finally {
      creating.set(callerId, (creating.get(callerId) ?? 1) - 1);
      host.changed();
    }
  };

  /**
   * Starts a new child's pi, which takes its first task, and removes the branch it started from.
   *
   * @remarks
   * A child that cannot start is `failed` for its parent, and stops counting as being created; its
   * first task, which the parent was told failed, no longer waits to go, and its place goes to the
   * next.
   *
   * @sideEffects Starts pi; removes a directory; may write the index.
   * @param childId - The child.
   * @param branch - The branch file, for a child with its parent's conversation.
   * @param moved - For such a child in a new worktree, the parent's directory and its own.
   */
  const start = async (
    childId: string,
    branch: string | undefined,
    moved: { readonly from: string; readonly to: string } | null,
  ): Promise<void> => {
    try {
      await lifecycle(childId, () => host.ensureRunning(childId));
      // Before the task: a child with its parent's conversation in a new worktree is told where it works.
      if (moved !== null) await host.noteMoved(childId, moved.from, moved.to);
      host.controller(childId)?.deliveriesChanged();
    } catch (error) {
      host.logger.warn({ sessionId: childId, err: error }, "child not started");
      fresh.delete(childId);
      const task = find(childId)?.agent?.tasks[0];
      if (task !== undefined) {
        await change(childId, (fields) => ({
          ...fields,
          deliveries: fields.deliveries.filter(
            (delivery) =>
              !(delivery.kind === "task" && delivery.taskId === task.taskId && delivery.state === "waiting"),
          ),
        }));
        await report(childId, { taskId: task.taskId, event: "failed", reason: "start_failed" });
      }
      const parentId = find(childId)?.parent?.sessionId;
      if (parentId !== undefined) wakeSiblings(parentId);
    } finally {
      if (branch !== undefined) await host.removeDir(dirname(branch)).catch(() => undefined);
    }
  };

  /**
   * Answers `agent_send`: words for the task a child works on, or its next task.
   *
   * @remarks
   * SPEC-0002, `agent_send`: a child at work on a task its parent gave takes the words into that
   * task at its next turn's end (2026-10-22); one waiting for its parent's answer takes nothing.
   * Otherwise the task waits for the child's run in progress, which it does not interrupt; an idle
   * child set to work counts against the six, and takes its place at once, in the parent's turn. A
   * child whose queue is paused, stopped or crashed out, has it go again, so the task goes
   * (2026-10-18).
   *
   * @sideEffects Writes the index; may start the child's pi.
   * @param callerId - The parent.
   * @param args - The tool's parameters.
   * @returns The task given.
   * @throws {AgentFailure} See `childNamed`, and `agent_limit`.
   */
  const send = async (
    callerId: string,
    args: Extract<AgentRequest, { op: "send" }>["args"],
  ): Promise<CallResults["send"]> => {
    const { child, taskId, queued, steered } = await inTurn(callerId, async () => {
      const target = childNamed(callerId, args.to, true);
      // Stryker disable next-line ArrayDeclaration: anything standing in for no questions is no open question.
      const asking = [...(questions.get(target.sessionId)?.values() ?? [])].find(
        (question) => question.state === "open",
      );
      if (asking !== undefined) throw new AgentFailure("agent_question_open", { questionId: asking.questionId });
      // A child being stopped has its queue paused already: what is sent goes as its next task.
      const now = host.state(target.sessionId);
      const inHand = now.running && now.paused === null ? (runs.get(target.sessionId)?.taskId ?? null) : null;
      if (inHand !== null) {
        await giveWords(target.sessionId, callerId, inHand, args.message);
        await wake(target.sessionId, true);
        return { child: target, taskId: inHand, queued: false, steered: true };
      }
      const busy = !unfinished(target) ? full(callerId, target.sessionId) : null;
      if (busy !== null) throw new AgentFailure("agent_limit", { children: busy });
      const state = host.state(target.sessionId);
      const given = await giveTask(target.sessionId, callerId, args.message);
      if (state.paused !== null) await host.resumeQueue(target.sessionId);
      await wake(target.sessionId, true);
      return { child: target, taskId: given, queued: state.running, steered: false };
    });
    return { to: args.to, sessionId: child.sessionId, taskId, queued, steered };
  };

  /**
   * Answers `agent_reply`: hands the child's extension the answer and waits for it to take it.
   *
   * @remarks
   * SPEC-0002, `agent_reply`: up to 10 s for the child to confirm; then the host closes the
   * question there, and the child says whether it took the answer after all; past 10 s more,
   * `delivered: "unknown"`. A question closed, or a child whose pi changed, is
   * `agent_question_closed`. Answers to one question go one at a time: the first counts, the same
   * answer again is confirmed again, a different one is `agent_question_closed`.
   *
   * @sideEffects Commands the child's pi; sets timers.
   * @param callerId - The parent.
   * @param args - The tool's parameters.
   * @returns Whether it was delivered.
   * @throws {AgentFailure} See `childNamed`, and `agent_question_closed`.
   */
  const replyCall = async (
    callerId: string,
    args: Extract<AgentRequest, { op: "reply" }>["args"],
  ): Promise<CallResults["reply"]> => {
    const child = childNamed(callerId, args.to, true);
    const question = questions.get(child.sessionId)?.get(args.questionId);
    if (question === undefined || question.state === "closed") throw new AgentFailure("agent_question_closed");
    const turn = question.replies.then(() => answerQuestion(child.sessionId, question, args));
    question.replies = turn.catch(() => undefined);
    return turn;
  };

  /**
   * Waits for a child to say it took or closed a question.
   *
   * @remarks
   * See `replyCall`.
   *
   * @sideEffects Sets a timer.
   * @param question - The question.
   * @returns What it said, or `null` after 10 s.
   */
  const heard = (question: Question): Promise<"answered" | "closed" | null> => {
    const said = Promise.withResolvers<"answered" | "closed" | null>();
    const cancel = clock.setTimeout(() => said.resolve(null), REPLY_CONFIRM_MS);
    /**
     * Hears how the child's extension closed the question.
     *
     * @remarks
     * See `replyCall`.
     *
     * @sideEffects Settles the confirmation.
     * @param op - How it closed.
     */
    const listener = (op: "answered" | "closed"): void => said.resolve(op);
    question.heard.add(listener);
    return said.promise.finally(() => {
      cancel();
      question.heard.delete(listener);
    });
  };

  /**
   * Gives a question one `agent_reply`'s answer, in the question's turn.
   *
   * @remarks
   * See `replyCall`.
   *
   * @sideEffects Commands the child's pi; sets timers.
   * @param childId - The child.
   * @param question - The question.
   * @param args - The tool's parameters.
   * @returns Whether it was delivered.
   * @throws {AgentFailure} `agent_question_closed`.
   */
  const answerQuestion = async (
    childId: string,
    question: Question,
    args: Extract<AgentRequest, { op: "reply" }>["args"],
  ): Promise<CallResults["reply"]> => {
    if (question.state === "closed") throw new AgentFailure("agent_question_closed");
    if (question.given !== null && question.given !== args.answer) throw new AgentFailure("agent_question_closed");
    const first = heard(question);
    const sent = question.answer;
    if (question.given === null && sent !== null && question.state === "open") {
      question.given = args.answer;
      sent({ answered: true, answer: args.answer });
    } else {
      // Answered before: the child confirms the same answer again.
      await tell(childId, question.epoch, "reply", {
        v: 1,
        id: question.questionId,
        ok: true,
        result: { answered: true, answer: args.answer },
      });
    }
    const said = await first;
    if (said === "answered") return { delivered: true };
    if (said === "closed") throw new AgentFailure("agent_question_closed");
    const second = heard(question);
    await tell(childId, question.epoch, "cancel", { v: 1, id: question.questionId, reason: "reply_failed" });
    const after = await second;
    if (after === "answered") return { delivered: true };
    if (after === "closed") throw new AgentFailure("agent_question_closed");
    return { delivered: "unknown" };
  };

  /**
   * Answers `ask_parent`: tells the parent's agent, and answers the child when it is answered.
   *
   * @remarks
   * SPEC-0002, `ask_parent`: only in a task's run; in a turn you opened it is answered `user_turn`
   * at once. The question is a `question` event of the task, not its end.
   *
   * @sideEffects Writes the index; may hand the parent's pi the notice.
   * @param childId - The child.
   * @param epoch - Its process.
   * @param questionId - The question, its tool call's id.
   * @param args - The tool's parameters.
   * @returns The answer, once given; `null` when the question closes without one.
   * @throws {AgentFailure} `agent_not_allowed` for a session no agent opened.
   */
  const ask = async (
    childId: string,
    epoch: number,
    questionId: string,
    args: Extract<AgentRequest, { op: "ask" }>["args"],
  ): Promise<CallResults["ask"] | null> => {
    const child = find(childId);
    const parentId = child?.parent?.sessionId;
    if (!isAgentChild(child) || parentId === undefined) throw new AgentFailure("agent_not_allowed");
    const taskId = runs.get(childId)?.taskId ?? null;
    if (taskId === null) return { answered: false, reason: "user_turn" };
    const answered = Promise.withResolvers<CallResults["ask"] | null>();
    const question: Question = {
      childId,
      questionId,
      epoch,
      parentId,
      taskId,
      text: args.question,
      options: args.options ?? [],
      state: "open",
      given: null,
      replies: Promise.resolve(),
      answer: (result) => {
        question.answer = null;
        answered.resolve(result);
      },
      heard: new Set(),
    };
    const open = questions.get(childId) ?? new Map<string, Question>();
    open.set(questionId, question);
    questions.set(childId, open);
    host.changed();
    await report(childId, { taskId, event: "question", questionId, toolCallId: questionId });
    question.heard.add((op) => {
      if (op === "closed") answered.resolve(null);
    });
    return answered.promise;
  };

  /**
   * Closes a question: no longer answered, no longer sent.
   *
   * @remarks
   * SPEC-0002, `ask_parent`: its `question` still waiting to go to the parent is removed; one
   * delivered is not taken back. What the child says of one closed already, as of a repeated
   * answer, is only passed on to who waits for it.
   *
   * @sideEffects Writes the index.
   * @param question - The question.
   * @param questionId - Its id.
   * @param how - Answered, or closed without one.
   */
  const closeQuestion = async (question: Question, questionId: string, how: "answered" | "closed"): Promise<void> => {
    for (const listener of question.heard) listener(how);
    if (question.state !== "open") return;
    question.state = how;
    question.answer?.(null);
    question.answer = null;
    await change(question.parentId, (fields) => ({
      ...fields,
      deliveries: fields.deliveries.filter(
        (delivery) =>
          !(delivery.questionId === questionId && delivery.from === question.childId && delivery.state === "waiting"),
      ),
    }));
    host.controller(question.parentId)?.deliveriesChanged();
    forgetQuestions(question.childId);
    host.changed();
  };

  /**
   * Forgets the oldest questions a child no longer has open, past {@link KEPT_QUESTIONS}.
   *
   * @remarks
   * A closed question is kept only to answer an `agent_reply` repeated to it (SPEC-0002,
   * `agent_reply`); one forgotten is answered `agent_question_closed` as well.
   *
   * @sideEffects Forgets questions.
   * @param childId - The child.
   */
  const forgetQuestions = (childId: string): void => {
    const asked = questions.get(childId);
    // Stryker disable next-line ConditionalExpression: a child closing a question has asked it.
    if (asked === undefined) return;
    const over = [...asked].filter(([, one]) => one.state !== "open");
    for (const [id] of over.slice(0, Math.max(0, over.length - KEPT_QUESTIONS))) asked.delete(id);
  };

  /**
   * Answers `agent_list`.
   *
   * @remarks
   * SPEC-0002, `agent_list`: the caller's children the agent opened, with ended ones only when
   * asked; detached ones are no longer theirs.
   *
   * @sideEffects none
   * @param callerId - The caller.
   * @param includeEnded - Whether to list ended ones.
   * @returns The children.
   */
  const list = (callerId: string, includeEnded: boolean): CallResults["list"] => {
    const children = agentChildren(callerId)
      .map((child): ListedChild => {
        const status = statusOf(child);
        const model = child.sessionId === "" ? null : host.modelOf(child.sessionId);
        const startOn = child.agent.startOn;
        const latest = progress.get(child.sessionId)?.message;
        return {
          name: child.agent.handle,
          title: titleOf(child),
          sessionId: child.sessionId,
          role: child.agent.role,
          status,
          place: child.agent.worktree ? "worktree" : "same",
          model:
            model === null
              ? startOn === null
                ? null
                : `${startOn.providerId}/${startOn.modelId}`
              : `${model.providerId}/${model.modelId}`,
          thinking: model?.thinkingLevel ?? startOn?.thinkingLevel ?? null,
          updatedAt: child.updatedAt,
          openTasks: child.agent.tasks.filter((task) => task.state === "open").map((task) => task.taskId),
          // Stryker disable next-line ConditionalExpression: the result goes as JSON, which drops a field left undefined.
          ...(latest === undefined ? {} : { lastProgress: latest }),
        };
      })
      .filter((child) => includeEnded || (child.status !== "ended" && child.status !== "handed_off"));
    return { children };
  };

  /**
   * Answers `agent_read`: a task's reply, a page at a time, or the latest steps.
   *
   * @remarks
   * SPEC-0002, `agent_read`: from the child's file, whether its pi runs or not; archived and
   * handed-off children can be read. A task's reply is its last one; before there is one,
   * `no_reply_yet`.
   *
   * @sideEffects Reads the child's file.
   * @param callerId - The caller.
   * @param args - The tool's parameters.
   * @returns What it read.
   * @throws {AgentFailure} See `childNamed`.
   */
  const read = async (callerId: string, args: Extract<AgentRequest, { op: "read" }>["args"]): Promise<ReadResult> => {
    const child = childNamed(callerId, args.to, false);
    const task =
      args.taskId === undefined
        ? child.agent.tasks.at(-1)
        : child.agent.tasks.find((one) => one.taskId === args.taskId);
    if (task === undefined) throw new AgentFailure("agent_not_allowed");
    const entries = child.file === null ? [] : await host.readEntries(child.file).catch(() => []);
    // Stryker disable next-line ArrayDeclaration: a string is no entry, so neither a step nor a reply comes of it.
    const run = taskEntries(entries, task.taskId) ?? [];
    if (args.what === "steps") {
      const results = new Map(
        run.flatMap((entry) => (entry.kind === "toolResult" ? [[entry.callId, entry.isError] as const] : [])),
      );
      const steps = run.flatMap((entry) =>
        entry.kind === "assistant"
          ? entry.parts.flatMap((part) =>
              part.type === "toolCall"
                ? [
                    {
                      title: stepTitle(part.tool, part.args),
                      status: !results.has(part.callId)
                        ? ("running" as const)
                        : results.get(part.callId) === true
                          ? ("failed" as const)
                          : ("done" as const),
                    },
                  ]
                : [],
            )
          : [],
      );
      return { steps: steps.slice(-(args.limit ?? READ_DEFAULTS.steps)) };
    }
    const replyEntry = task.replyEntry ?? null;
    const reply =
      replyEntry === null
        ? run.findLast((entry) => entry.kind === "assistant" && (replyText(entry) ?? "") !== "")
        : entries.find((entry) => entry.id === replyEntry);
    const text = replyText(reply);
    if (text === null || (task.state === "open" && replyEntry === null && reply === undefined))
      return { text: null, reason: "no_reply_yet" };
    const offset = Math.min(args.offset ?? 0, text.length);
    const end = Math.min(text.length, offset + (args.limit ?? READ_DEFAULTS.reply));
    return { text: text.slice(offset, end), totalChars: text.length, nextOffset: end < text.length ? end : null };
  };

  /**
   * Answers `agent_stop`.
   *
   * @remarks
   * SPEC-0002, `agent_stop`: the child's run and its agent children's below it; the child stays,
   * and `agent_send` gives it more work.
   *
   * @sideEffects Stops runs.
   * @param callerId - The caller.
   * @param args - The tool's parameters.
   * @returns What was stopped.
   * @throws {AgentFailure} See `childNamed`.
   */
  const stop = async (
    callerId: string,
    args: Extract<AgentRequest, { op: "stop" }>["args"],
  ): Promise<CallResults["stop"]> => {
    const child = childNamed(callerId, args.to, true);
    const previousStatus = statusOf(child);
    const stopped = await stopTree(child.sessionId, "agent_stop");
    return { to: args.to, sessionId: child.sessionId, previousStatus, stopped };
  };

  /**
   * Answers a call.
   *
   * @remarks
   * Each operation as its tool says (SPEC-0002, "工具"); depth is checked for the main agent's.
   *
   * @sideEffects As the operation's.
   * @param sessionId - The caller.
   * @param epoch - Its process.
   * @param request - The call.
   * @returns The result, or `null` for no answer.
   * @throws {AgentFailure} As the operation's.
   */
  const answer = async (
    sessionId: string,
    epoch: number,
    request: Extract<AgentRequest, { kind: "call" }>,
  ): Promise<unknown> => {
    const parentOp = request.op !== "ask" && request.op !== "branch";
    if (parentOp && agentDepth(catalog.list(), sessionId) >= MAX_DEPTH) throw new AgentFailure("agent_depth_limit");
    switch (request.op) {
      case "spawn":
        return spawn(sessionId, epoch, request.args);
      case "send":
        return send(sessionId, request.args);
      case "reply":
        return replyCall(sessionId, request.args);
      case "list":
        return list(sessionId, request.args.includeEnded === true);
      case "read":
        return read(sessionId, request.args);
      case "stop":
        return stop(sessionId, request.args);
      case "models": {
        const current = host.modelOf(sessionId);
        const models = await host.models(sessionId);
        return {
          models: models.map((model) => ({
            id: `${model.providerId}/${model.modelId}`,
            name: model.name,
            thinking: [...model.thinkingLevels],
            ...(current?.providerId === model.providerId && current.modelId === model.modelId
              ? { current: true as const }
              : {}),
          })),
        };
      }
      case "ask":
        return ask(sessionId, epoch, request.id, request.args);
      // A directory for the extension to cut the session into.
      case "branch":
      default: {
        const dir = await host.tempDir();
        const key = `${sessionId}#${String(epoch)}`;
        branchDirs.set(key, new Set([...(branchDirs.get(key) ?? []), dir]));
        return { dir };
      }
    }
  };

  /**
   * Takes a note from a session's extension.
   *
   * @remarks
   * ADR-0013, points 6–8: progress, a call it no longer waits for, a question it took or closed.
   * Only a question's call ends early when cancelled; another call's answer the extension drops.
   *
   * @sideEffects As the note's.
   * @param sessionId - The session.
   * @param epoch - Its process.
   * @param request - The note.
   */
  const note = async (
    sessionId: string,
    epoch: number,
    request: Extract<AgentRequest, { kind: "note" }>,
  ): Promise<void> => {
    switch (request.op) {
      case "progress":
        if (!isAgentChild(find(sessionId))) return;
        progress.set(sessionId, { message: request.args.message, passed: false });
        host.changed();
        return;
      case "cancel": {
        const id = request.args.id;
        const question = questions.get(sessionId)?.get(id);
        if (question !== undefined) {
          await closeQuestion(question, id, "closed");
          return;
        }
        return;
      }
      case "answered":
      case "closed": {
        const question = questions.get(sessionId)?.get(request.args.id);
        if (question === undefined) return;
        await closeQuestion(question, request.args.id, request.op);
        return;
      }
    }
  };

  const relay: AgentRelay = {
    request(sessionId, epoch, text) {
      const parsed = readRequest(text);
      if ("bad" in parsed) {
        host.logger.warn({ sessionId, size: text.length }, "agent request not read");
        // Stryker disable next-line ConditionalExpression: a request read as far as its kind has its id too.
        if (parsed.kind === "call" && parsed.bad !== null)
          // Fire and forget: `tell` never rejects.
          void tell(sessionId, epoch, "reply", { v: 1, id: parsed.bad, ok: false, code: "agent_bad_request" });
        return;
      }
      const { request } = parsed;
      if (request.kind === "note") {
        // Fire and forget: a note has no answer; what it could not do is logged.
        void note(sessionId, epoch, request).catch((error: unknown) =>
          host.logger.warn({ sessionId, op: request.op, err: error }, "agent note failed"),
        );
        return;
      }
      const key = callKey(sessionId, epoch, request.id);
      // Still at it: its one answer is the one awaited (ADR-0013, point 4).
      if (calls.has(key)) return;
      const process = `${sessionId}#${String(epoch)}`;
      const done = answeredCalls.get(process) ?? { ids: new Set<string>(), replies: new Map<string, unknown>() };
      answeredCalls.set(process, done);
      if (done.ids.has(request.id)) {
        const again = done.replies.get(request.id);
        // Fire and forget: `tell` never rejects.
        if (again !== undefined) void tell(sessionId, epoch, "reply", again);
        return;
      }
      const startedAt = clock.now();
      const work = (async () => {
        let reply: unknown;
        try {
          const result = await answer(sessionId, epoch, request);
          if (result === null) return;
          reply = { v: 1, id: request.id, ok: true, result };
        } catch (error) {
          const failure =
            error instanceof AgentFailure
              ? error
              : (host.logger.error({ sessionId, op: request.op, err: error }, "agent call failed"),
                new AgentFailure("agent_failed"));
          reply = {
            v: 1,
            id: request.id,
            ok: false,
            code: failure.code,
            ...(Object.keys(failure.params).length === 0 ? {} : { params: failure.params }),
          };
        } finally {
          calls.delete(key);
          remember(process, request.id, reply);
        }
        const code: unknown = Reflect.get(Object(reply), "code") ?? null;
        host.logger.info(
          { sessionId, op: request.op, requestId: request.id, ms: clock.now() - startedAt, code },
          "agent call",
        );
        await tell(sessionId, epoch, "reply", reply);
      })();
      calls.set(key, work);
    },

    exited(sessionId, epoch) {
      const prefix = `${sessionId}#${String(epoch)}`;
      for (const key of calls.keys()) if (key.startsWith(`${prefix}#`)) calls.delete(key);
      answeredCalls.delete(prefix);
      for (const dir of branchDirs.get(prefix) ?? [])
        // Fire and forget: what cannot be removed now goes at the next start, with the others marked.
        void host.removeDir(dir).catch(() => undefined);
      branchDirs.delete(prefix);
      for (const [id, question] of questions.get(sessionId) ?? []) {
        if (question.epoch === epoch && question.state === "open")
          // Fire and forget: the child's pi is gone; a failed write leaves only the notice to go.
          void closeQuestion(question, id, "closed").catch((error: unknown) =>
            host.logger.warn({ sessionId, err: error }, "question not closed"),
          );
      }
    },

    deliveries(sessionId) {
      return {
        list: () =>
          (find(sessionId)?.deliveries ?? []).map((delivery): PendingDelivery => ({
            id: delivery.id,
            kind: delivery.kind,
            ...(delivery.event === undefined ? {} : { event: delivery.event }),
            at: delivery.at,
            state: delivery.state,
            ...(delivery.steer === true ? { steer: true } : {}),
          })),
        items: () =>
          (find(sessionId)?.deliveries ?? []).flatMap((delivery): DeliveryItem[] =>
            delivery.state === "waiting" || delivery.state === "sending"
              ? [
                  {
                    id: delivery.id,
                    kind: delivery.kind,
                    fromTitle: titleOf(find(delivery.from)).slice(0, 1024),
                    event: delivery.event ?? null,
                    state: delivery.state,
                  },
                ]
              : [],
          ),
        held: () => held.get(sessionId) ?? null,
        mark: (ids, state) => {
          const marked = new Set(ids);
          return change(sessionId, (fields) => ({
            ...fields,
            deliveries: fields.deliveries.map((delivery) =>
              marked.has(delivery.id) ? { ...delivery, state } : delivery,
            ),
          }));
        },
        async confirm(ids) {
          const done = new Set(ids);
          await change(sessionId, (fields) => ({
            ...fields,
            deliveries: fields.deliveries.filter((delivery) => !done.has(delivery.id)),
          }));
          settleHold(sessionId);
          host.controller(sessionId)?.deliveriesChanged();
          maybeRecycle(sessionId);
        },
        async command(ids) {
          const chosen = (find(sessionId)?.deliveries ?? []).filter((delivery) => ids.includes(delivery.id));
          const task = chosen.find((delivery) => delivery.kind === "task");
          // Words for the task in hand go as one, in order (SPEC-0002, "送达").
          const words =
            task?.steer === true
              ? chosen.filter((delivery) => delivery.steer === true && delivery.taskId === task.taskId)
              : [];
          let payload: Delivery | null = null;
          if (task !== undefined) {
            const self = find(sessionId);
            const parent = find(task.from);
            // Stryker disable next-line OptionalChaining: the delivery came from the session's entry, and a child given a task has it in its record.
            const first = task.steer !== true && self?.agent?.tasks[0]?.taskId === task.taskId;
            payload =
              self?.agent == null || task.text === undefined
                ? null
                : {
                    v: 1,
                    kind: "task",
                    deliveries: words.length > 0 ? words.map((delivery) => delivery.id) : [task.id],
                    from: parent?.agent?.handle ?? "main",
                    fromTitle: titleOf(parent),
                    taskId: task.taskId,
                    // Stryker disable next-line StringLiteral: words for the task in hand always carry their text.
                    text: words.length > 0 ? words.map((delivery) => delivery.text ?? "").join("\n\n") : task.text,
                    ...(task.steer === true ? { steer: true as const } : {}),
                    ...(first
                      ? {
                          preamble: {
                            role: self.agent.role,
                            forked: self.agent.toolGuard === "extension",
                            canSpawn: agentDepth(catalog.list(), sessionId) < MAX_DEPTH,
                            ...(self.agent.worktree ? { workspace: self.cwd } : {}),
                          },
                        }
                      : {}),
                  };
          } else {
            const events = (await Promise.all(chosen.map(eventOf))).flatMap((event) => event ?? []);
            payload =
              events.length === 0
                ? null
                : {
                    v: 1,
                    kind: "report",
                    deliveries: chosen.map((delivery) => delivery.id),
                    events,
                    progress: takeProgress(sessionId),
                  };
          }
          return payload === null ? null : `/${AGENT_COMMAND} deliver ${encodeArgument(payload)}`;
        },
        stalled(ids) {
          // Not the restart's hold: "重试" lets it go, "全部继续" does not (SPEC-0002, "送达").
          if (!held.has(sessionId)) held.set(sessionId, "stalled");
          // Fire and forget: a failed write leaves them sending, which the next look at the file puts back.
          void relay
            .deliveries(sessionId)
            .mark(ids, "waiting")
            .catch((error: unknown) => host.logger.warn({ sessionId, err: error }, "deliveries not put back"));
          host.changed();
        },
        runStarted(opening: RunOpening) {
          fresh.delete(sessionId);
          const entry = find(sessionId);
          if (!isAgentChild(entry)) return;
          if (opening === "user") {
            runs.set(sessionId, { taskId: null, at: clock.now() });
          } else if (opening === "auto") {
            const carried = interrupted.get(sessionId) ?? null;
            interrupted.delete(sessionId);
            runs.set(sessionId, { taskId: carried, at: clock.now() });
          } else {
            const opened = entry.deliveries.filter((delivery) => opening.deliveries.includes(delivery.id));
            const task = opened.find((delivery) => delivery.kind === "task");
            runs.set(sessionId, {
              taskId: task === undefined ? taskOfNotices(sessionId, opened) : taskOfOpening(sessionId, task),
              at: clock.now(),
            });
          }
          host.changed();
        },
        runSettled(outcome, crashed, reply) {
          const run = runs.get(sessionId);
          // Stryker disable next-line CallExpression: every run sets its own entry as it starts, and tools, which read it, run only inside a run.
          runs.delete(sessionId);
          const entry = find(sessionId);
          // Archived or handed off as it ran: `ended` tells its parent instead (SPEC-0002, "归档、脱离、交接").
          if (endingNow.has(sessionId)) {
            stopReasons.delete(sessionId);
            return;
          }
          if (run?.taskId == null || !isAgentChild(entry)) {
            // A stop of a turn you opened tells no one; its reason is not the next stop's.
            stopReasons.delete(sessionId);
            maybeRecycle(sessionId);
            // A run of yours that ends frees its place too.
            if (isAgentChild(entry) && entry.parent !== null) wakeSiblings(entry.parent.sessionId);
            return;
          }
          if (crashed) {
            interrupted.set(sessionId, run.taskId);
            return;
          }
          const taskId = run.taskId;
          const why = stopReasons.get(sessionId);
          stopReasons.delete(sessionId);
          // Its run is over: what opens the next run goes under a follow-up of it (SPEC-0002, `agent_send`).
          ending.add(taskId);
          // Fire and forget: a notice not written is logged, and leaves the task open.
          void (async () => {
            const event = outcome === "completed" ? "finished" : outcome === "stopped" ? "stopped" : "failed";
            try {
              const replyEntry = await reply;
              await report(sessionId, {
                taskId,
                event,
                replyEntry,
                ...(event === "stopped" ? { reason: why ?? "user" } : {}),
              });
            } finally {
              // Written done by now, or left open for its end not to be lost.
              ending.delete(taskId);
            }
            maybeRecycle(sessionId);
            // Stryker disable next-line OptionalChaining: an agent child always has its parent.
            const parentId = entry.parent?.sessionId;
            // Stryker disable next-line ConditionalExpression: see above.
            if (parentId !== undefined) wakeSiblings(parentId);
          })().catch((error: unknown) => host.logger.warn({ sessionId, err: error }, "child's event not sent"));
        },
        gaveUp() {
          const taskId = interrupted.get(sessionId);
          interrupted.delete(sessionId);
          // Stryker disable next-line ConditionalExpression: a report on no task finds none in the record, and is not sent.
          if (taskId !== undefined)
            // Fire and forget: a notice not written is logged, and leaves the task open.
            void report(sessionId, { taskId, event: "failed", reason: "crashed" }).catch((error: unknown) =>
              host.logger.warn({ sessionId, err: error }, "child's event not sent"),
            );
          // pi crashed out: its place frees.
          const parentId = find(sessionId)?.parent?.sessionId;
          if (parentId !== undefined) wakeSiblings(parentId);
        },
      };
    },

    summary(sessionId) {
      const entry = find(sessionId);
      const waiting = entry?.deliveries.length ?? 0;
      // Only the restart's: "全部继续" lets those go (SPEC-0002, "送达").
      const heldDeliveries = held.get(sessionId) === "restart" ? waiting : 0;
      if (!isAgentChild(entry)) return { agent: null, heldDeliveries };
      const open = [...(questions.get(sessionId)?.values() ?? [])].find((question) => question.state === "open");
      // Tasks are taken in the order handed down: the oldest open one is the one in hand.
      const current = entry.agent.tasks.find((task) => task.state === "open");
      return {
        agent: {
          handle: entry.agent.handle.slice(0, 64),
          role: entry.agent.role,
          status: statusOf(entry),
          progress: progress.get(sessionId)?.message ?? null,
          question: open?.text ?? null,
          taskId: current?.taskId ?? null,
          taskStartedAt: current?.at ?? null,
        },
        heldDeliveries,
      };
    },

    asking(sessionId, asking) {
      if (!asking) {
        askingNow.delete(sessionId);
        return;
      }
      if (askingNow.has(sessionId)) return;
      askingNow.add(sessionId);
      const taskId = runs.get(sessionId)?.taskId ?? null;
      if (taskId !== null)
        // Fire and forget: a notice not written is logged; the dialog is there all the same.
        void report(sessionId, { taskId, event: "needs_you" }).catch((error: unknown) =>
          host.logger.warn({ sessionId, err: error }, "child's event not sent"),
        );
    },

    tabClosed(sessionId) {
      maybeRecycle(sessionId);
    },

    ending(sessionId) {
      endingNow.set(sessionId, (endingNow.get(sessionId) ?? 0) + 1);
      let over = false;
      return () => {
        if (over) return;
        over = true;
        const left = (endingNow.get(sessionId) ?? 1) - 1;
        if (left === 0) endingNow.delete(sessionId);
        else endingNow.set(sessionId, left);
      };
    },

    async ended(sessionId, reason, parentId) {
      const entry = find(sessionId);
      // Stryker disable next-line ArrayDeclaration: a string's characters are no open question, so none is closed.
      for (const [id, question] of questions.get(sessionId) ?? []) {
        if (question.state !== "open") continue;
        await tell(sessionId, question.epoch, "cancel", { v: 1, id, reason: reason as CancelReason });
        await closeQuestion(question, id, "closed");
      }
      if (reason === "archived") {
        await change(sessionId, (fields) => ({ ...fields, deliveries: [] }));
        progress.delete(sessionId);
      }
      if (entry?.agent == null) return;
      const parent = parentId ?? entry.parent?.sessionId;
      if (parent === undefined) return;
      // What its old parent gave it and had not gone yet goes no more (SPEC-0002, "脱离").
      if (reason === "detached") {
        await change(sessionId, (fields) => ({
          ...fields,
          deliveries: fields.deliveries.filter(
            (delivery) => !(delivery.kind === "task" && delivery.from === parent && delivery.state === "waiting"),
          ),
        }));
      }
      const open = entry.agent.tasks.filter((one) => one.state === "open");
      for (const task of open) {
        await sendUp(parent, {
          id: host.newId(),
          kind: "report",
          from: sessionId,
          taskId: task.taskId,
          event: "ended",
          reason,
          at: clock.now(),
          state: "waiting",
        });
      }
      // Done once told, so an end not written leaves the tasks open.
      await changeRecord(sessionId, (agent) => ({
        ...agent,
        // Stryker disable next-line ConditionalExpression: a task already done comes out the same.
        tasks: agent.tasks.map((task) => (task.state === "open" ? { ...task, state: "done" } : task)),
      }));
      runs.delete(sessionId);
      host.changed();
      // Its place frees.
      wakeSiblings(parent);
    },

    takenBack(sessionId) {
      // Fire and forget: `wake` logs a start that failed.
      void wake(sessionId).catch((error: unknown) =>
        host.logger.warn({ sessionId, err: error }, "session not started for its deliveries"),
      );
    },

    async removeDelivery(sessionId, deliveryId) {
      const delivery = find(sessionId)?.deliveries.find((one) => one.id === deliveryId);
      if (delivery === undefined) throw new CommandError("delivery_not_found", { deliveryId });
      if (delivery.state === "sending") throw new CommandError("delivery_sending", { deliveryId });
      // A task removed before it went ends there, and its parent is not told (SPEC-0002, "排队面板").
      // Words for the task in hand removed leave that task going.
      const quiet = delivery.kind === "task" && delivery.steer !== true ? delivery.taskId : null;
      await change(sessionId, (fields) => ({
        ...fields,
        agent:
          quiet === null || fields.agent === null
            ? fields.agent
            : {
                ...fields.agent,
                tasks: fields.agent.tasks.map((task) =>
                  task.taskId === quiet && task.state === "open" ? { ...task, state: "done" } : task,
                ),
              },
        deliveries: fields.deliveries.filter((one) => one.id !== deliveryId),
      }));
      if (quiet !== null && !(find(sessionId)?.deliveries ?? []).some((one) => one.kind === "task")) {
        // Its first task gone, it is no longer being created.
        fresh.delete(sessionId);
      }
      settleHold(sessionId);
      host.controller(sessionId)?.deliveriesChanged();
      host.changed();
    },

    async resumeDeliveries(sessionId, tree) {
      const sessions = [
        sessionId,
        ...(tree ? descendantsOf(catalog.list(), sessionId).map((entry) => entry.sessionId) : []),
      ];
      for (const id of sessions) if (!tree || held.get(id) === "restart") held.delete(id);
      host.changed();
      for (const id of sessions) await wake(id);
    },

    async start() {
      const entries = catalog.list();
      const lost = lostTasks(entries);
      // Every hold first, before anything is read, so no controller hands pi a delivery meanwhile.
      for (const entry of entries) if (entry.deliveries.length > 0) held.set(entry.sessionId, "restart");
      for (const { parentId } of lost) held.set(parentId, "restart");
      if (held.size > 0) host.changed();
      for (const entry of entries) {
        if (isAgentChild(entry) && !entry.archived && entry.file !== null) {
          // The latest progress comes back from the child's file, to go once with the next notice (SPEC-0002, `report_progress`).
          const logged = await host.readEntries(entry.file).catch(() => []);
          const latest = logged
            .flatMap((one) => (one.kind === "assistant" ? one.parts : []))
            .findLast((part) => part.type === "toolCall" && part.tool === "report_progress");
          const message = latest?.type === "toolCall" ? latest.args["message"] : undefined;
          if (typeof message === "string") progress.set(entry.sessionId, { message, passed: false });
        }
        if (entry.deliveries.length === 0) continue;
        await change(entry.sessionId, (fields) => ({
          ...fields,
          // Nothing is on its way after a restart; a question asked of the host that stopped is void.
          deliveries: fields.deliveries.flatMap((delivery): DeliveryRecord[] => {
            if (delivery.event === "question") return [];
            // Stryker disable next-line ConditionalExpression: a delivery waiting comes out the same.
            if (delivery.state === "waiting") return [delivery];
            return [{ ...delivery, state: "waiting" }];
          }),
        }));
        settleHold(entry.sessionId);
      }
      // The host was killed: tasks it did not see end stopped with it (2026-10-18).
      for (const { childId, taskId } of lost) {
        await report(childId, { taskId, event: "stopped", reason: "host_exit" }).catch((error: unknown) =>
          host.logger.warn({ sessionId: childId, err: error }, "child's event not sent"),
        );
      }
    },

    async close() {
      // From here on what is told is only recorded: no pi is started or handed anything (SPEC-0002, "送达").
      closing = true;
      // A task whose pi was restarting is unfinished too (SPEC-0002, "送达").
      const open = [
        // Stryker disable next-line ConditionalExpression,ArrayDeclaration: a report on no task, or on a task a child does not have, finds none and sends nothing.
        ...[...runs].flatMap(([sessionId, run]) => (run.taskId === null ? [] : [[sessionId, run.taskId] as const])),
        ...interrupted,
      ];
      for (const [sessionId, taskId] of open) {
        await report(sessionId, { taskId, event: "stopped", reason: "host_exit" }).catch(() => undefined);
      }
      // Stryker disable next-line CallExpression: the host is closing; nothing reads the runs after this.
      runs.clear();
      interrupted.clear();
    },
  };

  /**
   * The task a run notices opened goes under.
   *
   * @remarks
   * SPEC-0002, "通知父会话的事件": the task the grandchild's own task was given under, when it is
   * still open; otherwise a new follow-up task, so its result goes up all the same.
   *
   * @sideEffects May write the index.
   * @param sessionId - The child the notices came to.
   * @param opened - The notices.
   * @returns The task, or `null` when the notices came from no task.
   */
  function taskOfNotices(sessionId: string, opened: readonly DeliveryRecord[]): string | null {
    const self = find(sessionId);
    if (!isAgentChild(self)) return null;
    for (const notice of opened) {
      const from = find(notice.from);
      const origin = from?.agent?.tasks.find((task) => task.taskId === notice.taskId)?.originTask;
      if (origin === undefined) continue;
      const task = self.agent.tasks.find((one) => one.taskId === origin);
      return task?.state === "open" && !ending.has(origin) ? origin : followUp(sessionId, origin);
    }
    return null;
  }

  /**
   * The task a run a task's delivery opened goes under.
   *
   * @remarks
   * SPEC-0002, `agent_send`: the task itself; words for a task that ended before they went in open
   * a follow-up of it, so what the run does reaches the parent.
   *
   * @sideEffects May write the index.
   * @param sessionId - The child.
   * @param delivery - The delivery.
   * @returns The task.
   */
  function taskOfOpening(sessionId: string, delivery: DeliveryRecord): string {
    if (delivery.steer !== true) return delivery.taskId;
    const task = find(sessionId)?.agent?.tasks.find((one) => one.taskId === delivery.taskId);
    return task?.state === "open" && !ending.has(delivery.taskId)
      ? delivery.taskId
      : followUp(sessionId, delivery.taskId);
  }

  /**
   * Opens a follow-up of a task that ended.
   *
   * @remarks
   * SPEC-0002, "通知父会话的事件": its notices say which task it follows up.
   *
   * @sideEffects Writes the index.
   * @param sessionId - The child.
   * @param origin - The task it follows up.
   * @returns The follow-up's id.
   */
  function followUp(sessionId: string, origin: string): string {
    const taskId = `t-${host.newId()}`;
    // Fire and forget: the run goes on; a follow-up not written ends with nothing to report on.
    void changeRecord(sessionId, (agent) => ({
      ...agent,
      tasks: [...agent.tasks, { taskId, state: "open", at: clock.now(), followUpOf: origin }],
    })).catch((error: unknown) => host.logger.warn({ sessionId, err: error }, "follow-up task not written"));
    return taskId;
  }

  return relay;
}
