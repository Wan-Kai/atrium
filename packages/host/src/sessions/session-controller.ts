import type { Dialog, PiEvent, PiStats, PlanReport, TranslatedEvent } from "@atrium/pi";
import { PLAN_PROVIDERS, compactRejection, createEventTranslator, isBusyRejection, planReplyOf } from "@atrium/pi";
import {
  type ContextReserve,
  CommandError,
  type CommandResult,
  type Control,
  type DeliveryItem,
  type EditStoppedMessageCommand,
  type FetchStepCommand,
  type FetchTranscriptCommand,
  type Interaction,
  type InteractionAnswer,
  type ModelRef,
  type PendingSteer,
  type PlanProvider,
  type PromptCommand,
  type RunSettledEvent,
  type SessionEvent,
  type SessionMetrics,
  type SessionModel,
  type SessionSnapshotEvent,
  type SlashCommand,
  type SteerCommand,
  type ThinkingLevel,
  type TranscriptItem,
  parseTraceparent,
} from "@atrium/protocol";
import type { Clock } from "../platform/clock";
import type { PlanUsageService } from "./plan-usage";
import { createMetricsTracker } from "./session-metrics";
import type { SeenCompaction } from "../transcript/projection";
import { editStoppedBranch } from "./stopped-edit";
import {
  type EntriesPage,
  type TranscriptEvent,
  type TurnOrigin,
  createSessionTranscript,
} from "../transcript/session-transcript";

/** How pi ended, as the controller needs it. */
interface PiEnd {
  readonly code: number | null;
  readonly signal: string | null;
  readonly requested: boolean;
}

/** An answer to an extension dialog as pi takes it. */
type DialogResponse = { readonly id: string } & InteractionAnswer;

/** An image as pi's `prompt` and `steer` take it: base64 data and its type (pi-internals.md §3). */
export interface PromptImage {
  readonly data: string;
  readonly mimeType: string;
}

/** A message as it goes to pi: its text, possibly empty, and its images. */
interface Outgoing {
  readonly text: string;
  readonly images: readonly PromptImage[];
}

/** The part of a running pi a session controller uses; the manager adapts a traced pi to it. */
export interface SessionPi {
  onEvent(listener: (event: PiEvent) => void): () => void;
  readonly exited: Promise<PiEnd>;
  /** Sends `prompt` and returns pi's disposition. */
  prompt(
    message: string,
    images: readonly PromptImage[],
  ): Promise<{ readonly disposition: "started" | "queued" | "handled" }>;
  /** Sends `steer` and returns pi's disposition. */
  steer(message: string, images: readonly PromptImage[]): Promise<{ readonly disposition: "queued" | "handled" }>;
  /** Empties pi's own queue and returns the steers it held. */
  clearQueue(): Promise<{ readonly steering: readonly string[] }>;
  /** Asks pi to stop; resolves once it has. */
  abort(): Promise<void>;
  /** Answers an extension dialog. */
  respond(response: DialogResponse): void;
  /** Reads the session's entries after `since`, or all of them, converted. */
  getEntries(since: string | undefined): Promise<EntriesPage>;
  /** Reads actual on-disk entries, even after pi exited; memory-first appends are not proof of a write. */
  readPersistedEntries(): Promise<EntriesPage>;
  /** The model pi uses now, from `get_state`; `null` when it has none. */
  model(): Promise<SessionModel | null>;
  /** Sends `set_model`. */
  setModel(model: ModelRef): Promise<void>;
  /** Sends `set_thinking_level`. */
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  /** Switches Atrium's Fast extension; fails with `fast_unavailable` when this pi did not load it. */
  setFast(enabled: boolean): Promise<void>;
  /** Sends `compact`, with what to keep in mind when asked; resolves once pi has compacted. */
  compact(instructions: string | undefined): Promise<void>;
  /** Sends `export_html`, pi writing the page to `outputPath`. */
  exportHtml(outputPath: string): Promise<void>;
  /** pi's slash commands, from `get_commands`. */
  commands(): Promise<SlashCommand[]>;
  /** pi's statistics for the status bar, from `get_session_stats`. */
  stats(): Promise<PiStats>;
  /** Stops pi; resolves once it has exited. */
  stop(): Promise<unknown>;
  /** Sends one of Atrium's hidden commands, which pi runs at once (ADR-0013, point 2). */
  command(message: string): Promise<void>;
}

/** One delivery as the controller sees it: enough to decide when it goes (SPEC-0002, "送达"). */
export interface PendingDelivery {
  readonly id: string;
  readonly kind: "report" | "task";
  /** A notice's event; `undefined` for a task. */
  readonly event?: string;
  readonly at: number;
  readonly state: "waiting" | "claimed" | "sending" | "deleted";
  /** The wait's tool call that took it. */
  readonly claimedBy?: string;
}

/** How a run began, for deliveries: notices or a task, the host carrying on after a crash, or you. */
export type RunOpening = { readonly deliveries: readonly string[] } | "auto" | "user";

/**
 * The session's deliveries and what is told of its runs (SPEC-0002, "送达"); the agent relay
 * keeps them in the session's record and words what goes to pi.
 */
export interface ControllerDeliveries {
  /** What waits for the session now. */
  list(): readonly PendingDelivery[];
  /** The queue panel's items. */
  items(): DeliveryItem[];
  /** Why they wait until you let them go: the host restarted, or pi did not take them; `null` when they go. */
  held(): "restart" | "stalled" | null;
  /** Sets the state of deliveries; resolves once written. */
  mark(ids: readonly string[], state: "waiting" | "sending"): Promise<void>;
  /** Removes deliveries pi has on file, or whose wait's result is there. */
  confirm(ids: readonly string[]): Promise<void>;
  /** The hidden command that hands pi these deliveries; `null` when they can no longer go. */
  command(ids: readonly string[]): Promise<string | null>;
  /** Holds the deliveries, as after a restart, when pi did not take one it was handed. */
  stalled(ids: readonly string[]): void;
  /** A run began. */
  runStarted(opening: RunOpening): void;
  /**
   * A run ended; `reply` resolves, once pi's entries were read, with the entry of its last reply.
   *
   * @param outcome - How it ended.
   * @param crashed - pi went away mid-run, not asked to: a restart may carry the run on.
   * @param reply - The entry of the run's last reply, once read.
   */
  runSettled(outcome: "completed" | "stopped" | "failed", crashed: boolean, reply: Promise<string | null>): void;
  /** pi's restarts after a crash were used up: the run carried on will not end otherwise. */
  gaveUp(): void;
  /** You sent a message: a wait in progress returns (SPEC-0002, "等待的规则"). */
  userSpoke(): void;
}

/** How long pi may take to begin the run a delivery starts before the host holds the deliveries. */
const DELIVERY_START_MS = 15_000;

/** A pi just started for the session again, with the entries it has and the model it uses. */
export interface Respawned {
  readonly pi: SessionPi;
  readonly entries: EntriesPage;
  /** Unknown, and taken as none, when left out. */
  readonly model?: SessionModel | null;
}

/** One session's live state and the commands on it (domain-model §3). */
export interface SessionController {
  readonly sessionId: string;
  /** Whether the session's pi has exited and has not been replaced. */
  readonly exited: boolean;
  /** Whether pi is being started again after a crash; the session counts as running meanwhile. */
  readonly restarting: boolean;
  /**
   * Whether a message is on its way to pi, or pi said it started a run that has not begun yet;
   * the run is known only once pi reports it began.
   */
  readonly submitting: boolean;
  /** The session's state now, for a client that just subscribed. */
  snapshot(): SessionSnapshotEvent;
  /** The run control now, without the rest of a snapshot. */
  control(): Control;
  /** The model pi uses, as last read; `null` when unknown. */
  model(): SessionModel | null;
  /** Every item from the session's start, whole, unlike a snapshot's latest ones. */
  items(): TranscriptItem[];
  /** Hands a session whose pi exited a newly started one, which carries on in a new epoch. */
  attach(started: Respawned): void;
  /** Sends a message with its images, or queues it behind the run in progress. */
  prompt(command: PromptCommand, images?: readonly PromptImage[]): Promise<CommandResult<"prompt">>;
  /** Replaces the last stopped user message on a new branch of this same session. */
  editStoppedMessage(
    command: EditStoppedMessageCommand,
    images?: readonly PromptImage[],
  ): Promise<CommandResult<"edit_stopped_message">>;
  /** Sends a steer with its images, or a message when idle. */
  steer(command: SteerCommand, images?: readonly PromptImage[]): Promise<CommandResult<"steer">>;
  /** Stops the run: pauses the queue, clears pi's queue and aborts. */
  stop(): Promise<CommandResult<"stop">>;
  resumeQueue(): CommandResult<"resume_queue">;
  clearQueue(): CommandResult<"clear_queue">;
  updateQueued(itemId: string, text: string): CommandResult<"update_queued">;
  removeQueued(itemId: string): CommandResult<"remove_queued">;
  /** Takes a message out of the queue and sends it as a steer. */
  steerQueued(itemId: string): Promise<CommandResult<"steer_queued">>;
  answerInteraction(interactionId: string, answer: InteractionAnswer): CommandResult<"answer_interaction">;
  /** Switches pi's model, from its next request to the model on. */
  setModel(model: ModelRef): Promise<CommandResult<"set_model">>;
  /** Sets how hard pi's model thinks. */
  setThinkingLevel(level: ThinkingLevel): Promise<CommandResult<"set_thinking_level">>;
  /** Switches Fast on or off, from pi's next request on (SPEC-0001, "Fast"). */
  setFast(enabled: boolean): Promise<CommandResult<"set_fast">>;
  /** Compacts pi's context now, as `/compact` asks (SPEC-0001, "M1.11 的 `/` 命令 · 压缩"). */
  compact(instructions: string | undefined): Promise<CommandResult<"compact_session">>;
  /** Has pi write the session as its HTML page to `outputPath`, during a run too. */
  exportHtml(outputPath: string): Promise<void>;
  /** pi's `/` commands, asked for each time the list opens. */
  listCommands(): Promise<CommandResult<"list_commands">>;
  /** Runs the last turn again, as after an automatic restart; starts pi first if it has exited. */
  retryRun(): Promise<CommandResult<"retry_run">>;
  /** Items before one the client has, for scrolling back. */
  fetchTranscript(command: FetchTranscriptCommand): CommandResult<"fetch_transcript">;
  /** One step whole, for one that traveled as a preview. */
  fetchStep(command: FetchStepCommand): CommandResult<"fetch_step">;
  /** The entry of the user message that opened a turn; `null` if there is no such turn or it is not tied to one yet. */
  entryOfTurn(turnId: string): string | null;
  /** Waits for the read of pi's entries under way, if any, which ties a turn just ended to its entry. */
  entriesRead(): Promise<void>;
  /**
   * Where a fork after a turn cuts the session: the entry of the user message that opens the next
   * turn, or `null` after the last turn (SPEC-0001, "M1.11 的 `/` 命令 · 分叉").
   */
  forkPoint(turnId: string): string | null;
  /** Takes what its child conversations produced, for its "含子对话" figures (SPEC-0002, "用量合计"). */
  childrenChanged(totals: SessionMetrics["children"]): void;
  /** Its deliveries changed: publishes them and hands pi what can go now (SPEC-0002, "送达"). */
  deliveriesChanged(): void;
  /**
   * Keeps the session busy while a fork reads its file, until the release given is called:
   * messages queue, and compacting or forking again is refused.
   */
  holdForFork(): () => void;
  /** Whether a fork reads the session's file; the session counts as busy meanwhile. */
  readonly forking: boolean;
  /** Stops pi for good, as the host asks (archiving, closing): no restart follows. */
  shutdown(): Promise<void>;
}

/** A session event before the controller numbers it. */
type Unnumbered = SessionEvent extends infer E
  ? E extends SessionEvent
    ? Omit<E, "sessionId" | "epoch" | "seq" | "traceId">
    : never
  : never;

/** What a failed pi request looks like: the pi package's `PiRequestError`, or a replay of it in tests. */
interface PiFailure {
  readonly name: "PiRequestError";
  readonly reason: string;
  readonly detail?: string;
}

/** How long a stop waits for pi to confirm before the session stays stopping (SPEC-0001, "运行控制"). */
const STOP_CONFIRM_MS = 2_000;

/** How many restarts in a row the host tries after pi crashes. */
const MAX_RESTARTS = 3;

/** How much of an extension's notification goes into the log (security.md, "凭据与日志"). */
const NOTIFY_LOG_LIMIT = 4 * 1024;

/** What the host sends to have the agent go on after an interrupted run (2026-10-09). */
export const CONTINUE_TEXT = "上一次运行意外中断了，请从中断的地方继续。";

/**
 * Whether an error is a failed pi request.
 *
 * @remarks
 * Matched by shape, so the fixture replay's mirror of the error counts too.
 *
 * @sideEffects none
 * @param error - What was thrown.
 * @returns Whether it is a pi request failure.
 */
function isPiFailure(error: unknown): error is PiFailure {
  return error instanceof Error && error.name === "PiRequestError" && "reason" in error;
}

/**
 * Turns a failed `prompt` or `steer` into the error code the client gets.
 *
 * @remarks
 * pi refusing a message is not a host bug (SPEC-0001, "应答"): busy becomes `session_busy`, any
 * other refusal `pi_rejected` with pi's text for "展开看原始报错", and a pi that has gone or does
 * not answer `pi_unavailable`. Anything else is passed on as it is.
 *
 * @sideEffects none
 * @param error - What the request threw.
 * @returns The error to throw.
 */
function promptFailure(error: unknown): unknown {
  if (!isPiFailure(error)) return error;
  const detail = error.detail ?? "";
  if (error.reason === "rejected") {
    return isBusyRejection(detail) ? new CommandError("session_busy") : new CommandError("pi_rejected", { detail });
  }
  const status = error.reason === "exited" || error.reason === "stopped" ? "exited" : "unresponsive";
  return new CommandError("pi_unavailable", { status });
}

/**
 * Whether a failure means pi went away, which its exit and a restart take care of.
 *
 * @remarks
 * See `promptFailure`.
 *
 * @sideEffects none
 * @param error - What `promptFailure` made of the failure.
 * @returns Whether it is `pi_unavailable`.
 */
function isGone(error: unknown): boolean {
  return error instanceof CommandError && error.code === "pi_unavailable";
}

/**
 * Whether a failure means pi was busy and the message can wait in the queue.
 *
 * @remarks
 * See `promptFailure`.
 *
 * @sideEffects none
 * @param error - What `promptFailure` made of the failure.
 * @returns Whether it is `session_busy`.
 */
function isBusy(error: unknown): boolean {
  return error instanceof CommandError && error.code === "session_busy";
}

/** How a run ended, from how its last turn came out. */
const RUN_OUTCOMES: Readonly<
  Record<Extract<TranscriptEvent, { type: "turn_finished" }>["outcome"], RunSettledEvent["outcome"]>
> = {
  done: "completed",
  stopped: "stopped",
  failed: "failed",
};

/**
 * Whether a failed `get_entries` means pi does not know the cursor.
 *
 * @remarks
 * pi answers an unknown `since` with "Entry not found" (pi-internals.md §1); the session file
 * was replaced, so the host reads it again from the start.
 *
 * @sideEffects none
 * @param error - What the request threw.
 * @returns Whether to read everything again.
 */
function isUnknownCursor(error: unknown): boolean {
  // Stryker disable next-line StringLiteral: no text and a made-up one both fail to start with "Entry not found".
  return isPiFailure(error) && error.reason === "rejected" && (error.detail ?? "").startsWith("Entry not found");
}

/**
 * An extension dialog as clients see it.
 *
 * @remarks
 * The deadline counts from when the host received the request.
 *
 * @sideEffects none
 * @param dialog - pi's request, translated.
 * @param now - The time it arrived.
 * @returns The interaction.
 */
function toInteraction(dialog: Dialog, now: number): Interaction {
  return {
    id: dialog.id,
    kind: dialog.method,
    title: dialog.title,
    message: dialog.message,
    options: dialog.options === null ? null : [...dialog.options],
    placeholder: dialog.placeholder,
    prefill: dialog.prefill,
    deadline: dialog.timeoutMs === null ? null : now + dialog.timeoutMs,
  };
}

/**
 * Whether an answer fits the kind of question.
 *
 * @remarks
 * A confirmation takes `confirmed`, the others a `value`; any of them may be cancelled
 * (pi-internals.md §5).
 *
 * @sideEffects none
 * @param kind - The question's kind.
 * @param answer - The answer.
 * @returns Whether pi can take it.
 */
function fits(kind: Interaction["kind"], answer: InteractionAnswer): boolean {
  if ("cancelled" in answer) return true;
  return kind === "confirm" ? "confirmed" in answer : "value" in answer;
}

/** A message waiting in the queue, with the request that sent it. */
interface QueueItem {
  readonly id: string;
  text: string;
  readonly images: readonly PromptImage[];
  readonly createdAt: number;
  readonly requestId: string | null;
  readonly traceId: string | null;
}

/** A steer pi was given, and the text its queue lists it by once it has. */
interface Steer {
  readonly id: string;
  /** As it was sent: what the client shows, and what goes again if it comes back. */
  readonly text: string;
  readonly images: readonly PromptImage[];
  /** Whether pi's queue has listed it; pi's text may differ, expanded as pi expands skills and templates. */
  listed: boolean;
}

/**
 * The text a steer of images alone goes to pi with.
 *
 * @remarks
 * pi takes a delivered steer off its queue by its text, and never one whose text is empty; such a
 * steer would stay listed for good (pi-internals.md §2; SPEC-0001, "运行控制").
 */
const IMAGES_ONLY = "（见图片）";

/** A message sent to pi that has not opened a turn yet. */
interface Waiting {
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly text: string;
  readonly images: readonly PromptImage[];
  readonly auto: boolean;
  /** Set once pi echoed it as the user message opening a turn. */
  echoed: boolean;
  /** Set when pi went away before taking it and its queued item went back to the queue instead. */
  requeued: boolean;
}

/**
 * Creates the controller of one session, driving its pi and publishing what happens.
 *
 * @remarks
 * The runtime state (the transcript, with the turn being built live, the run in progress and the
 * run control) lives here, and snapshots and events are both made from it, so a client that
 * subscribes gets a snapshot and then exactly the events after it (domain-model §7). Every
 * published event is numbered within the session's epoch and carries the trace of the run it
 * belongs to. A run starts with the first `agent_start` after idle, so its `run_started` comes
 * before the user message pi echoes, and ends only at `agent_settled`, after its turn's
 * `turn_finished`; its trace is the one the `prompt` command carried. A turn pi opens is matched
 * to the oldest message still waiting and carries that command's `requestId` as
 * `clientMessageId`, so the client can replace its pending copy. After a run and after a
 * compaction the controller reads pi's new entries and rebuilds the transcript, never during a run
 * (SPEC-0001, "快照与分页"): added notices go out as `notice_added`, wherever they are; any other
 * difference starts a new epoch and sends every subscriber a fresh snapshot.
 *
 * Run control follows SPEC-0001 ("运行控制"): a message sent while a run goes on, a message is on
 * its way, pi compacts, pi restarts or the queue is moving waits in the host's queue and goes out
 * once the session is idle again, one at a time, and a refused one stops the queue there; a paused
 * queue does not move, but a message sent while idle goes out at once. A steer goes to pi only
 * while a run goes on and is a message otherwise; pi's queue updates tell which steers were
 * delivered. A stop pauses the queue, puts the steers pi gave back at the queue's front and aborts;
 * the session stays stopping until pi confirms or exits, taking no message meanwhile. Extension
 * dialogs wait for one answer and expire at their deadline; how each ended stays in the
 * transcript as a notice.
 *
 * The controller outlives its pi (domain-model §3): when pi exits, a run in progress ends as
 * failed, steers go back to the queue, dialogs are dropped, and `session_exited` follows. A crash
 * starts pi again through `respawn`, up to `MAX_RESTARTS` times in a row, unless the host asked
 * pi to stop; after a restart the message the run was interrupted on, or that was on its way, is
 * sent again if pi had not taken it yet, and `CONTINUE_TEXT` otherwise, unless you had stopped,
 * and the queue moves on. A run that ends without failing resets the count; when the restarts are
 * used up the session is failed until the next run, and "重试" starts over.
 *
 * The session's Fast is kept here, through restarts, and switched through pi, which is refused
 * like a model change while stopping or once pi has exited; it is published only when it changed,
 * and reported each time pi took it (SPEC-0001, "Fast").
 *
 * @sideEffects Subscribes to pi's events; calls `publish` for every event; calls `newId`; reads
 * pi's entries after runs and compactions, reporting failures to `onRefreshFailed`; schedules
 * timers on the clock; starts pi again through `respawn`; logs through `log`.
 * @param options - The session id, its pi, the entries it had at start, where events go, the
 * clock, an id source, where refresh failures and log lines go, the epoch to start in, the
 * session's turn starts (SPEC-0001, `steer`), how to start pi again, and the session's model and
 * Fast with where their choices go.
 * @returns The controller.
 */
export function createSessionController(options: {
  readonly sessionId: string;
  readonly pi: SessionPi;
  readonly entries: EntriesPage;
  readonly publish: (event: SessionEvent) => void;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly onRefreshFailed: (error: unknown) => void;
  /** Where the controller's log lines go: extension notifications and failed restarts. */
  readonly log?: (level: "info" | "warn" | "error", message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** The epoch to start in; after the session's previous controller, one past its last. */
  readonly epoch?: number;
  /**
   * Entries earlier host runs saw open a turn, and compactions they saw during runs, and where
   * newly seen ones go.
   */
  readonly turnStarts?: {
    readonly opened: ReadonlySet<string>;
    readonly auto?: ReadonlySet<string>;
    readonly compactions?: ReadonlyMap<string, SeenCompaction>;
    readonly record: (
      entryIds: readonly string[],
      autoIds: readonly string[],
      compactions: ReadonlyMap<string, SeenCompaction>,
    ) => void;
  };
  /**
   * Starts the session's pi again; without it a crash is final. Resolves with `null` when another
   * start, already under way, hands the session its pi instead.
   */
  readonly respawn?: () => Promise<Respawned | null>;
  /** pi's compaction reserve for a model (SPEC-0001, "M1.13 的上下文细分与套餐用量"); unknown when left out. */
  readonly readReserve?: (model: ModelRef | null) => Promise<ContextReserve>;
  /** The home directory, written as `~` in the status bar's memory files. */
  readonly home?: string;
  /**
   * Subscriptions' usage, the host's, and how to ask this session's pi for a provider's
   * (ADR-0011); without it, the session asks for none.
   */
  readonly plan?: {
    readonly service: Pick<PlanUsageService, "wanted" | "replied">;
    readonly ask: (provider: PlanProvider) => Promise<PlanReport | null>;
  };
  /** The model pi started with; none when left out. */
  readonly model?: SessionModel | null;
  /** Told the model and thinking level pi uses after you chose one, to remember for new sessions. */
  readonly onModelChosen?: (model: SessionModel) => void;
  /** The session's Fast, which its pi was started with; off when left out. */
  readonly fast?: boolean;
  /** Told Fast was switched, to remember for the session and for new sessions. */
  readonly onFastChosen?: (enabled: boolean) => void;
  /** The session's deliveries (SPEC-0002, "送达"); without them it takes none. */
  readonly deliveries?: ControllerDeliveries;
}): SessionController {
  const { sessionId, clock, newId } = options;
  const log = options.log ?? (() => undefined);
  let pi = options.pi;
  let epoch = options.epoch ?? 1;
  let seq = 0;
  const transcript = createSessionTranscript({
    sessionId,
    newId,
    now: () => clock.now(),
    ...(options.turnStarts === undefined
      ? {}
      : {
          opened: options.turnStarts.opened,
          ...(options.turnStarts.auto === undefined ? {} : { auto: options.turnStarts.auto }),
          ...(options.turnStarts.compactions === undefined ? {} : { compactions: options.turnStarts.compactions }),
          onTurnsSeen: options.turnStarts.record,
        }),
  });
  // Stryker disable next-line BooleanLiteral: the log starts empty, so reading everything again changes nothing.
  transcript.rebuild(options.entries, false);
  let run: {
    readonly runId: string;
    readonly startedAt: number;
    readonly traceId: string | null;
    /** The message that started it: the oldest one waiting when it began. */
    readonly input: Waiting | null;
  } | null = null;
  /** Messages sent to pi that have not opened a turn yet, oldest first. */
  const waiting: Waiting[] = [];
  /** The last message sent to pi that pi has neither echoed nor handled nor refused. */
  let unconfirmed: Waiting | null = null;
  let exited = false;
  /** The refresh running, if any, and whether another was asked for meanwhile. */
  let refreshing: Promise<void> | null = null;
  // Stryker disable next-line BooleanLiteral: the loop clears it before each read.
  let refreshAgain = false;
  let translate = createEventTranslator(() => clock.now());
  let unsubscribe = pi.onEvent(heard);

  const queue: QueueItem[] = [];
  let paused: Control["paused"] = null;
  let steers: Steer[] = [];
  /** Steers sent, or waiting to be sent, that pi has not answered yet. */
  const steering = new Set<Promise<unknown>>();
  /** Settles once the last steer asked for has been answered; the next one waits for it. */
  let steerTurn: Promise<void> = Promise.resolve();
  /** A stop is taking pi's steers back; its answer, not pi's queue updates, says which pi held. */
  let clearing = false;
  /** The stop in progress, shared by every caller until pi confirms or exits. */
  let stopping: Promise<CommandResult<"stop">> | null = null;
  let compacting = false;
  /** Whether a fork reads the session's file (SPEC-0001, "M1.11 的 `/` 命令 · 分叉"). */
  let forking = false;
  /** A rewind and replacement own the pi until submission or recovery finishes. */
  let editing = false;
  /** The deliveries handed to an idle pi, whose run has not begun yet. */
  let deliveryRun: readonly string[] | null = null;
  /** Calls off the wait for that run to begin. */
  let deliveryGuard: (() => void) | null = null;
  /**
   * The deliveries handed to pi as a steer into a run, until they are seen in it: if the run ended
   * first, they open the next one (SPEC-0002, "送达"), which is theirs.
   */
  let steered: readonly string[] | null = null;
  /** The deliveries the run in progress opened with, to find its reply after them. */
  let runDeliveries: readonly string[] | null = null;
  /** Deliveries an extension's error put back once since a run last began; a second time holds them. */
  const erred = new Set<string>();
  /** You sent a message while the queue was paused: the deliveries go with it (SPEC-0002, "送达"). */
  let released = false;

  /**
   * Pauses the queue, or lets it go.
   *
   * @remarks
   * A message you send while the queue is paused releases the deliveries for that pause only; a
   * pause that starts or ends takes the release back (SPEC-0002, "送达" 的时机表).
   *
   * @sideEffects Sets the pause; takes back the release.
   * @param next - Why it pauses, or `null` to let it go.
   */
  const pauseQueue = (next: Control["paused"]): void => {
    paused = next;
    released = false;
  };
  /** A model was chosen whose result pi has not reported yet; read after the next entries. */
  let choiceToRead = false;
  /** A message on its way to pi, whose disposition has not come back yet. */
  let sending = false;
  /** pi said it started a run whose `agent_start` has not arrived yet. */
  let starting = false;
  /** How many runs have started, to tell whether a message's run started before pi answered. */
  let runsStarted = 0;
  const interactions = new Map<string, { readonly interaction: Interaction; readonly expire: () => void }>();
  let restarts = 0;
  let failure: Control["failure"] = null;
  /** The restart under way; the queue waits meanwhile, and `shutdown` waits for it. */
  let restarting: Promise<void> | null = null;
  /** The message the last crash interrupted, for "重试" once restarts are used up. */
  let lost: Waiting | null = null;
  /** Set by `shutdown`: pi exits for good. */
  let shuttingDown = false;
  /** Who waits for each pi's exit alongside other work, by pi until it exits; `watchExit` wakes them. */
  const exitWakers = new Map<SessionPi, Set<(value: undefined) => void>>();
  /** The control last published, to send `control_updated` only on change. */
  let sentControl = JSON.stringify(control());
  /** The model pi uses, as last read or reported. */
  let model = options.model ?? null;
  /** Whether you want Fast in this session, whether or not its model has it (SPEC-0001, "Fast"). */
  let fast = options.fast ?? false;
  const metrics = createMetricsTracker({
    clock,
    entries: transcript.entries(),
    readStats: () => pi.stats(),
    readReserve: () => options.readReserve?.(model) ?? Promise.resolve(null),
    provider: () => model?.providerId ?? null,
    home: options.home,
    onChange: (now) => emit({ type: "metrics_updated", metrics: now }),
    onReadFailed: (error) => {
      // pi going away fails every request; its exit is reported as such.
      if (isPiFailure(error) && (error.reason === "exited" || error.reason === "stopped")) return;
      log("warn", "session stats not read", { sessionId, reason: isPiFailure(error) ? error.reason : "unknown" });
    },
  });
  metrics.refresh();
  askPlan();

  /**
   * Takes one of pi's events: the usage a reply brought goes to the service, the rest is translated.
   *
   * @remarks
   * ADR-0012: Atrium's extension reports Claude's usage from each reply's headers, unasked.
   *
   * @sideEffects May tell the service; applies what the event means for the session.
   * @param event - pi's event.
   */
  function heard(event: PiEvent): void {
    const reply = planReplyOf(event);
    if (reply !== null) options.plan?.service.replied(reply);
    // The translator drops it; deliveries handed over may be lost with it (SPEC-0002, "送达 · 确认").
    if (event.type === "extension_error") extensionFailed();
    for (const translated of translate(event)) apply(translated);
  }

  /**
   * Looks again at the deliveries handed to pi when an extension reports an error.
   *
   * @remarks
   * SPEC-0002, "送达 · 确认": Atrium's extension may have failed to take what it was handed. The
   * deliveries that were to start a run and did not are looked for in the file again and put back
   * as waiting if not there, to go again; the second time in a row they are held as not taken
   * ("没送出去"), so a failing extension is not handed them over and over. Steered into a run, they
   * are looked at once the run ends, as always. Errors of other extensions, with nothing handed
   * over, change nothing.
   *
   * @sideEffects May hold the deliveries or read pi's entries, which may put them back and hand
   * them over again; publishes `control_updated`.
   */
  function extensionFailed(): void {
    const ids = deliveryRun;
    if (ids === null) return;
    deliveryRun = null;
    deliveryGuard?.();
    deliveryGuard = null;
    starting = false;
    const again = ids.every((id) => erred.has(id));
    for (const id of ids) erred.add(id);
    log("warn", "delivery met an extension error", { sessionId, count: ids.length });
    if (again) {
      options.deliveries?.stalled(ids);
      controlChanged();
      return;
    }
    controlChanged();
    // Fire and forget: `refresh` reports its own failures.
    void refresh();
  }

  /**
   * Asks for every subscription's usage through this session's pi.
   *
   * @remarks
   * After pi starts and each run (ADR-0011, point 2; SPEC-0001, "M1.14 的套餐总览"): all of them,
   * whatever the session's model; the service decides whether it is time to ask each. Nothing while
   * pi is being stopped for good: its last events must not ask it again.
   *
   * @sideEffects May ask the session's pi, through the service.
   */
  function askPlan(): void {
    const plan = options.plan;
    if (shuttingDown || plan === undefined) return;
    for (const provider of PLAN_PROVIDERS) plan.service.wanted(provider, () => plan.ask(provider));
  }

  /**
   * Numbers an event and sends it to the session's viewers.
   *
   * @remarks
   * The sequence number counts every event of the epoch, so a client can spot a gap.
   *
   * @sideEffects Advances `seq`; calls `publish`.
   * @param event - The event without its envelope.
   */
  function emit(event: Unnumbered): void {
    seq += 1;
    options.publish({ ...event, sessionId, epoch, seq, traceId: run?.traceId ?? null });
  }

  /**
   * The run control now.
   *
   * @remarks
   * See `createSessionController`.
   *
   * @sideEffects none
   * @returns The control.
   */
  function control(): Control {
    return {
      queue: queue.map(({ id, text, createdAt, images }) => ({ id, text, createdAt, images: images.length })),
      deliveries: options.deliveries?.items() ?? [],
      deliveriesHeld: options.deliveries?.held() ?? null,
      paused,
      steers: steers.map(({ id, text }): PendingSteer => ({ id, text })),
      stopping: stopping !== null,
      restarting: restarting !== null,
      compacting,
      interactions: [...interactions.values()].map((open) => open.interaction),
      failure,
    };
  }

  /**
   * Publishes the run control if it changed since it was last sent.
   *
   * @remarks
   * Snapshots carry it too, so a new epoch's snapshot counts as sending it.
   *
   * @sideEffects May publish `control_updated`.
   */
  function controlChanged(): void {
    const now = control();
    const json = JSON.stringify(now);
    if (json === sentControl) return;
    sentControl = json;
    emit({ type: "control_updated", control: now });
  }

  /**
   * The session's state now.
   *
   * @remarks
   * The latest turns only; older ones come through `fetch_transcript`.
   *
   * @sideEffects none
   * @returns The snapshot.
   */
  function snapshot(): SessionSnapshotEvent {
    return {
      type: "session_snapshot",
      sessionId,
      epoch,
      seq,
      traceId: run?.traceId ?? null,
      ...transcript.latest(),
      run: run === null ? null : { runId: run.runId, startedAt: run.startedAt },
      exited,
      control: control(),
      model,
      fast,
      metrics: metrics.current(),
    };
  }

  /**
   * Takes the model pi reports, publishing it if it changed.
   *
   * @remarks
   * pi sends no event for a new model (pi-internals.md §3), so the controller reads it after
   * every change it asks for. The context is split again: through Claude Code, the system prompt
   * is another (SPEC-0001, "M1.13 的上下文细分与套餐用量").
   *
   * @sideEffects May publish `model_updated` and `metrics_updated`.
   * @param now - The model pi uses.
   */
  function modelIs(now: SessionModel | null): void {
    if (JSON.stringify(now) === JSON.stringify(model)) return;
    model = now;
    emit({ type: "model_updated", model });
    metrics.modelChanged();
  }

  /**
   * Changes pi's model or thinking level as you chose, then reads back what pi uses.
   *
   * @remarks
   * pi keeps the thinking level within what the model supports, so the level read back may differ
   * from the one asked for. What pi then uses is reported as your choice; the entry pi wrote for
   * it is read like any other (SPEC-0001, "模型与输入框"). A change pi took stands even when the
   * model cannot be read back; it is read again after the next entries.
   *
   * @sideEffects Calls pi; may publish `model_updated` and `metrics_updated`; reports the choice; starts a refresh.
   * @param change - The request to pi.
   * @throws {CommandError} `session_stopping`, `pi_unavailable`, or pi's refusal of the change.
   */
  async function choose(change: () => Promise<void>): Promise<void> {
    refuseWhenExited();
    refuseWhileStopping();
    try {
      await change();
    } catch (error) {
      throw promptFailure(error);
    }
    choiceToRead = true;
    try {
      await readChoice();
    } catch {
      // pi took the change; the model is read again after the entries (SPEC-0001, "模型与输入框").
    }
    // Another model has another context window (SPEC-0001, "状态栏（M1.8）").
    metrics.refresh();
    // Fire and forget: `refresh` reports its own failures.
    void refresh();
  }

  /**
   * Reads the model pi uses after a choice, and reports it as chosen.
   *
   * @remarks
   * Once read, it is not read again.
   *
   * @sideEffects Calls pi; may publish `model_updated` and `metrics_updated`; reports the choice.
   * @throws {Error} When pi does not answer.
   */
  async function readChoice(): Promise<void> {
    const now = await pi.model();
    modelIs(now);
    if (model !== null) options.onModelChosen?.(model);
    // Done only once reported, so a failure on the way reads it again after the next entries.
    choiceToRead = false;
  }

  /**
   * Starts a new epoch and sends every viewer its snapshot.
   *
   * @remarks
   * After a rebuild that changed more than notices, and when a new pi takes over.
   *
   * @sideEffects Advances the epoch; publishes the snapshot.
   */
  function newEpoch(): void {
    epoch += 1;
    seq = 0;
    const fresh = snapshot();
    sentControl = JSON.stringify(fresh.control);
    options.publish(fresh);
  }

  /**
   * Ends the run in progress.
   *
   * @remarks
   * The turn finishes first, so `run_settled` comes after `turn_finished`. Without a turn (pi
   * started no turn this run) the run counts as completed, unless pi went away. A run that did
   * not fail resets the restart count (SPEC-0001, "运行控制").
   *
   * @sideEffects Publishes the turn's last events and `run_settled`.
   * @param crashed - Whether pi exited mid-run.
   * @returns How the run ended, or `null` when none was in progress.
   */
  function settle(crashed: boolean): RunSettledEvent["outcome"] | null {
    if (run === null) return null;
    const events = transcript.settle(crashed);
    for (const event of events) emit(event);
    const finished = events.find((event) => event.type === "turn_finished");
    const outcome = crashed ? "failed" : finished === undefined ? "completed" : RUN_OUTCOMES[finished.outcome];
    emit({ type: "run_settled", runId: run.runId, outcome, settledAt: clock.now() });
    if (outcome !== "failed") restarts = 0;
    run = null;
    return outcome;
  }

  /**
   * Reads pi's new entries and rebuilds the transcript, until no more reads were asked for.
   *
   * @remarks
   * One read at a time; a request while one runs makes it read again afterwards. A run that
   * started meanwhile postpones the rebuild to its end, since its turn is being built live. An
   * unknown cursor reads everything again; other failures are reported and wait for the next
   * read.
   *
   * @sideEffects Calls pi; publishes `notice_added`, or a new epoch's snapshot.
   */
  async function refresh(): Promise<void> {
    if (refreshing !== null) {
      refreshAgain = true;
      return;
    }
    const done = Promise.withResolvers<void>();
    refreshing = done.promise;
    try {
      do {
        refreshAgain = false;
        if (run !== null || exited) return;
        let reset = false;
        let page: EntriesPage;
        try {
          page = await pi.getEntries(transcript.cursor);
        } catch (error) {
          if (!isUnknownCursor(error)) throw error;
          reset = true;
          page = await pi.getEntries(undefined);
        }
        if (run !== null) return;
        const result = transcript.rebuild(page, reset);
        if (result.kind === "notices") for (const event of result.events) emit(event);
        if (result.kind === "changed") newEpoch();
        const { all, branch } = transcript.entries();
        metrics.entriesChanged(all, branch);
        confirmDeliveries();
        if (choiceToRead) await readChoice();
      } while (refreshAgain);
    } catch (error) {
      options.onRefreshFailed(error);
    } finally {
      refreshing = null;
      done.resolve();
    }
  }

  /**
   * Who sent the message a new turn opens with: the oldest one waiting.
   *
   * @remarks
   * Marks it as taken by pi, which tells a restart not to send it again.
   *
   * @sideEffects Takes the message off the waiting list.
   * @returns Its request and whether the host sent it.
   */
  function origin(): TurnOrigin {
    const next = waiting.shift();
    if (next === undefined) return { clientMessageId: null, auto: false };
    next.echoed = true;
    if (next === unconfirmed) unconfirmed = null;
    return { clientMessageId: next.requestId, auto: next.auto };
  }

  /**
   * Applies one translated pi event to the runtime state and publishes what changed.
   *
   * @remarks
   * See `createSessionController`.
   *
   * @sideEffects Updates the runtime state; publishes events; may start a refresh or send the
   * next queued message.
   * @param event - The translated event.
   */
  function apply(event: TranslatedEvent): void {
    metrics.observe(event);
    switch (event.kind) {
      case "agent_started":
        starting = false;
        if (run !== null) return;
        runsStarted += 1;
        run = {
          runId: newId(),
          startedAt: clock.now(),
          traceId: waiting[0]?.traceId ?? null,
          input: waiting[0] ?? null,
        };
        emit({ type: "run_started", runId: run.runId, startedAt: run.startedAt });
        failure = null;
        lost = null;
        // A steer the run before ended without took this run up instead (SPEC-0002, "送达").
        runDeliveries = deliveryRun ?? (run.input === null ? steered : null);
        steered = null;
        erred.clear();
        options.deliveries?.runStarted(
          runDeliveries === null ? (run.input?.auto === true ? "auto" : "user") : { deliveries: runDeliveries },
        );
        deliveryRun = null;
        deliveryGuard?.();
        controlChanged();
        return;
      case "agent_settled": {
        const opened = runDeliveries;
        runDeliveries = null;
        const outcome = settle(false);
        const turnId = transcript.items().findLast((item) => item.kind === "turn")?.id ?? null;
        // `refresh` reports its own failures and never rejects.
        const read = refresh();
        if (outcome !== null)
          options.deliveries?.runSettled(
            outcome,
            false,
            read.then(() => lastReply(opened, turnId)),
          );
        dispatch();
        askPlan();
        return;
      }
      case "compaction_started":
        compacting = true;
        controlChanged();
        return;
      case "compaction_finished":
        // The step first: the line saying pi compacts goes once the step stands in its place.
        for (const published of transcript.apply(event, origin)) emit(published);
        compacting = false;
        controlChanged();
        // Fire and forget: `refresh` reports its own failures.
        void refresh();
        dispatch();
        return;
      case "steering_changed":
        delivered(event.steering);
        return;
      case "agent_message": {
        // Seen in the run it was steered into: that run is not the next one's, and the notices held behind it may go.
        const seen = steered?.some((id) => event.details.deliveries.includes(id)) === true;
        if (seen) steered = null;
        for (const published of transcript.apply(event, origin)) emit(published);
        if (seen) dispatch();
        return;
      }
      case "note_added":
        // pi wrote the note to its file already; the read places it where a rebuild would (SPEC-0002).
        // Fire and forget: `refresh` reports its own failures.
        void refresh();
        return;
      case "thinking_changed":
        if (model !== null) modelIs({ ...model, thinkingLevel: event.level });
        return;
      case "dialog_requested":
        ask(event.dialog);
        return;
      // Only the status bar's timing reads these, above.
      // Stryker disable next-line StringLiteral: a case left out does nothing either.
      case "request_started":
      // Stryker disable next-line StringLiteral: see above.
      case "output_started":
        return;
      case "notified":
        log(event.level === "error" ? "error" : event.level === "warning" ? "warn" : "info", "extension notified", {
          sessionId,
          text: event.text.slice(0, NOTIFY_LOG_LIMIT),
          length: event.text.length,
        });
        return;
      case "assistant_started":
      case "part_started":
      case "part_delta":
      case "message_finished":
      case "tool_output":
      case "retry_started":
        for (const published of transcript.apply(event, origin)) emit(published);
    }
  }

  /**
   * Keeps the steers pi still holds; the others were delivered.
   *
   * @remarks
   * pi lists its steers' texts whole each time, one change an update: it adds the steers it takes
   * at the back and delivers from the front (pi-internals.md §2). Its texts are expanded and need
   * not be what the host sent, so steers are counted, not matched: a longer list took the earliest
   * steers not listed yet; a shorter one delivered the earliest listed. Steers go to pi one at a
   * time, so they reach its queue in the order sent. While a stop takes the steers back, pi's
   * emptied queue says nothing about delivery, so updates wait for the stop's answer.
   *
   * @sideEffects Updates the steers; publishes `control_updated`.
   * @param held - The texts pi holds.
   */
  function delivered(held: readonly string[]): void {
    if (clearing) return;
    const listed = steers.filter((steer) => steer.listed);
    // Stryker disable next-line EqualityOperator: a list as long as before adds none and delivers none either way.
    if (held.length > listed.length) {
      let taken = held.length - listed.length;
      for (const steer of steers) {
        if (steer.listed) continue;
        if (taken === 0) break;
        steer.listed = true;
        taken -= 1;
      }
    } else {
      const gone = new Set(listed.slice(0, listed.length - held.length));
      steers = steers.filter((steer) => !gone.has(steer));
    }
    controlChanged();
  }

  /**
   * Keeps an extension's question until it is answered or its deadline passes.
   *
   * @remarks
   * pi goes on with its default at the deadline; the host only takes the question away then.
   *
   * @sideEffects Schedules the deadline; publishes `control_updated`.
   * @param dialog - The question.
   */
  function ask(dialog: Dialog): void {
    const interaction = toInteraction(dialog, clock.now());
    const expire =
      dialog.timeoutMs === null
        ? () => undefined
        : clock.setTimeout(() => close(dialog.id, "timed_out", null), dialog.timeoutMs);
    interactions.set(dialog.id, { interaction, expire });
    controlChanged();
  }

  /**
   * Ends a question, noting in the transcript how it ended.
   *
   * @remarks
   * The notice says what was asked and the answer, if there was one (SPEC-0001, "对话框").
   *
   * @sideEffects Cancels its deadline; publishes `notice_added` and `control_updated`.
   * @param id - The question.
   * @param outcome - How it ended.
   * @param answer - The answer given, if any.
   */
  function close(
    id: string,
    outcome: "answered" | "cancelled" | "timed_out" | "stale",
    answer: InteractionAnswer | null,
  ): void {
    const open = interactions.get(id);
    if (open === undefined) return;
    open.expire();
    interactions.delete(id);
    emit(
      transcript.noteInteraction({
        title: open.interaction.title,
        outcome,
        value: answer !== null && "value" in answer ? answer.value : null,
        confirmed: answer !== null && "confirmed" in answer ? answer.confirmed : null,
      }),
    );
    controlChanged();
  }

  /**
   * Whether a message sent now would go to pi at once.
   *
   * @remarks
   * pi takes a message when no run goes on or is about to start, nothing is on its way, it does
   * not compact, no fork reads its file, it is not being restarted and it is there.
   *
   * @sideEffects none
   * @returns Whether the session is idle.
   */
  function idle(): boolean {
    return (
      run === null && !sending && !starting && !compacting && !forking && !editing && restarting === null && !exited
    );
  }

  /**
   * Sends a message to pi as a prompt.
   *
   * @remarks
   * It waits to open a turn until pi echoes it, and stays the session's unconfirmed message until
   * then, unless pi handled it, refused it, or went away, in which case a restart sends it again.
   * The caller moves the queue on afterwards; doing it here would send the next message before
   * the caller decided what to do with a refused one.
   *
   * @sideEffects Calls pi; publishes `prompt_handled`.
   * @param message - The message and its images.
   * @param from - The request that sent it, its trace, and whether the host sent it.
   * @param fromQueue - Whether it came from the queue, which takes it back when pi goes away.
   * @returns pi's disposition.
   * @throws {CommandError} As `promptFailure` makes them.
   */
  async function send(
    message: Outgoing,
    from: { readonly requestId: string | null; readonly traceId: string | null; readonly auto: boolean },
    fromQueue = false,
  ): Promise<"started" | "handled"> {
    const entry: Waiting = { ...from, text: message.text, images: message.images, echoed: false, requeued: false };
    waiting.push(entry);
    unconfirmed = entry;
    sending = true;
    const runsBefore = runsStarted;
    /**
     * Stops waiting for pi to echo this message.
     *
     * @remarks
     * The echo, or pi's exit, may already have taken the entry; then there is nothing to remove,
     * and removing by index -1 would drop another message's entry.
     *
     * @sideEffects Updates the waiting list and the unconfirmed message.
     * @param keep - Whether it stays the unconfirmed message, for a restart to send again.
     */
    const forget = (keep: boolean): void => {
      const index = waiting.indexOf(entry);
      if (index !== -1) waiting.splice(index, 1);
      if (!keep && unconfirmed === entry) unconfirmed = null;
    };
    try {
      const { disposition } = await pi.prompt(message.text, message.images);
      if (disposition !== "handled") {
        // pi may answer before or after the run's events; until its `agent_start` arrives, the run
        // is pi's even though no event says so yet.
        starting = runsStarted === runsBefore;
        return "started";
      }
      forget(false);
      if (from.requestId !== null) emit({ type: "prompt_handled", clientMessageId: from.requestId });
      return "handled";
    } catch (error) {
      const failed = promptFailure(error);
      // A message pi did not take because it went away is sent again: a queued one by the queue,
      // which takes it back, any other by the restart. pi's exit may have taken it already.
      const gone = isGone(failed);
      if (gone && fromQueue) entry.requeued = true;
      forget(gone && !fromQueue);
      throw failed;
    } finally {
      sending = false;
    }
  }

  /**
   * Sends the next queued message if the session can take it.
   *
   * @remarks
   * A queue that is paused, stopping or restarting does not move. A refused message goes back to
   * the front before anything else is sent: pi busy waits for the next chance, pi gone waits for
   * the restart, and any other refusal pauses the queue, so the user sees it and decides.
   *
   * @sideEffects May call pi; publishes `control_updated`.
   */
  function dispatch(): void {
    if (pumpDeliveries()) return;
    if (!idle() || paused !== null || stopping !== null) return;
    const item = queue.shift();
    if (item === undefined) return;
    controlChanged();
    send(item, { requestId: item.requestId, traceId: item.traceId, auto: false }, true).then(
      () => dispatch(),
      (error: unknown) => {
        queue.unshift(item);
        if (!isBusy(error) && !isGone(error)) {
          pauseQueue("stopped");
          log("warn", "queued message refused", { sessionId, code: error instanceof CommandError ? error.code : null });
        }
        controlChanged();
      },
    );
  }

  /**
   * Hands pi what waits for the session, when the session can take it now.
   *
   * @remarks
   * SPEC-0002, "送达"'s table. Nothing goes while the deliveries are held after a restart, pi is
   * gone, stopping, compacting, forking, restarting or a message is on its way, nor while the queue
   * is paused unless you sent a message since. In a run, notices go at once, as one steer, unless
   * the last ones steered are not in the run yet: pi takes one steer a turn boundary, so the ones
   * that come meanwhile wait to go as one once they are (2026-10-20); tasks wait for the run's
   * end. Idle, the oldest of the queue and the deliveries goes first: notices waiting all go as
   * one, a task alone.
   *
   * @sideEffects May hand pi deliveries.
   * @returns Whether deliveries go now, so the queue waits.
   */
  function pumpDeliveries(): boolean {
    const box = options.deliveries;
    if (box === undefined || box.held() !== null) return false;
    if (
      exited ||
      // Stryker disable next-line ConditionalExpression: a stop pauses the queue and takes back your message's release, which holds them below all the same.
      stopping !== null ||
      compacting ||
      forking ||
      editing ||
      restarting !== null ||
      sending ||
      starting
    )
      // Stryker disable next-line BooleanLiteral: then the session is not idle or a stop waits, so `dispatch` sends nothing either way.
      return false;
    // Stryker disable next-line BooleanLiteral: a paused queue sends nothing in `dispatch` either way.
    if (paused !== null && !released) return false;
    const ready = box.list().filter((delivery) => delivery.state === "waiting");
    if (run !== null) {
      const notices = steered === null ? ready.filter((delivery) => delivery.kind === "report") : [];
      // Fire and forget: `deliver` puts back what it could not hand over, and never rejects.
      if (notices.length > 0) void deliver(notices, false);
      // Stryker disable next-line BooleanLiteral: a run going, `dispatch` sends nothing either way.
      return false;
    }
    const first = ready.toSorted((a, b) => a.at - b.at)[0];
    if (first === undefined) return false;
    const next = queue[0];
    if (next !== undefined && paused === null && next.createdAt <= first.at) return false;
    // Fire and forget: `deliver` puts back what it could not hand over, and never rejects.
    void deliver(first.kind === "task" ? [first] : ready.filter((delivery) => delivery.kind === "report"), true);
    // Stryker disable next-line BooleanLiteral: `deliver` marks a message on its way before it first waits, so `dispatch` sends nothing either way.
    return true;
  }

  /**
   * Hands pi deliveries through Atrium's extension.
   *
   * @remarks
   * They are marked `sending` before the command goes (SPEC-0002, "送达 · 确认"). Whether they go
   * is judged again as the command is about to go: a stop, a pause, a hold, or pi gone or replaced
   * meanwhile puts them back as waiting; a run begun meanwhile takes notices as a steer, a run
   * ended meanwhile is opened by them. Into an idle pi they start a run, which counts as submitting
   * until it begins; one that does not begin in `DELIVERY_START_MS` holds the deliveries for you.
   * Steered into a run, they are watched for in it, and open the next run if it ended first. A
   * failure puts them back as waiting, for the next chance to send: trying again at once would
   * spin while pi refuses or is gone.
   *
   * @sideEffects Writes the deliveries' states; calls pi; publishes `control_updated`.
   * @param batch - The deliveries.
   * @param opening - Whether pi was idle when they were picked, so they start a run.
   */
  async function deliver(batch: readonly PendingDelivery[], opening: boolean): Promise<void> {
    const box = options.deliveries;
    // Stryker disable next-line ConditionalExpression: only `pumpDeliveries` calls it, with a box.
    if (box === undefined) return;
    const ids = batch.map((delivery) => delivery.id);
    const current = pi;
    let failed = false;
    sending = true;
    // Stryker disable next-line CallExpression: only the deliveries' states change before `finally`, which publishes them; this shows the moment before.
    controlChanged();
    try {
      await box.mark(ids, "sending");
      const command = await box.command(ids);
      if (command === null) {
        await box.confirm(ids);
        return;
      }
      const opens = run === null;
      if (
        exited ||
        pi !== current ||
        stopping !== null ||
        (paused !== null && !released) ||
        box.held() !== null ||
        (opening && !opens)
      ) {
        await box.mark(ids, "waiting");
        return;
      }
      const runsBefore = runsStarted;
      if (opens) deliveryRun = ids;
      else steered = ids;
      await current.command(command);
      // Stryker disable next-line ConditionalExpression: only an opening sets `deliveryRun` to these, and a run's start or pi's exit clears it, so the last check alone decides.
      if (opens && runsStarted === runsBefore && deliveryRun === ids) awaitRun(ids);
    } catch (error) {
      failed = true;
      if (deliveryRun === ids) deliveryRun = null;
      if (steered === ids) steered = null;
      log("warn", "delivery not handed to pi", { sessionId, code: error instanceof CommandError ? error.code : null });
      await box.mark(ids, "waiting").catch(() => undefined);
    } finally {
      sending = false;
      controlChanged();
      if (!failed) dispatch();
    }
  }

  /**
   * Waits for the run deliveries handed to pi are to start.
   *
   * @remarks
   * It counts as submitting until it begins; one that does not begin in `DELIVERY_START_MS` holds
   * the deliveries for you, as not taken (SPEC-0002, "送达").
   *
   * @sideEffects Sets a timer; may hold the deliveries and publish `control_updated`.
   * @param ids - The deliveries.
   */
  function awaitRun(ids: readonly string[]): void {
    deliveryRun = ids;
    starting = true;
    deliveryGuard = clock.setTimeout(() => {
      if (deliveryRun !== ids) return;
      deliveryRun = null;
      starting = false;
      log("warn", "delivery did not start a run", { sessionId, count: ids.length });
      options.deliveries?.stalled(ids);
      controlChanged();
    }, DELIVERY_START_MS);
  }

  /**
   * Removes the deliveries pi has on file, and puts back the ones handed to it that it lost.
   *
   * @remarks
   * SPEC-0002, "送达 · 确认": a delivery counts once its message is on file, and a wait's notice
   * once the wait's result is. pi writes nothing until its first reply, then every entry as it
   * comes, so an entry counts only once the session has a reply. A delivery pi was handed and
   * does not have, with no run going nor beginning, goes back to waiting; one steered into a run
   * that ended without it opens the next run instead, which it waits for.
   *
   * @sideEffects Writes the deliveries; may hand pi the next ones.
   */
  function confirmDeliveries(): void {
    const box = options.deliveries;
    if (box === undefined) return;
    const { all } = transcript.entries();
    const onFile = all.some((entry) => entry.kind === "assistant");
    const onFileIds = new Set<string>();
    const results = new Set<string>();
    for (const entry of onFile ? all : []) {
      if (entry.kind === "agent") for (const id of entry.details.deliveries) onFileIds.add(id);
      if (entry.kind === "toolResult") results.add(entry.callId);
    }
    const pending = box.list();
    const done = pending.filter(
      (delivery) => onFileIds.has(delivery.id) || (delivery.claimedBy !== undefined && results.has(delivery.claimedBy)),
    );
    let settled = run === null && deliveryRun === null && !sending && !starting;
    if (settled && steered !== null) {
      // Steered into a run that ended without them: pi opens the next run with them (SPEC-0002, "送达").
      const late = steered;
      steered = null;
      if (!late.some((id) => onFileIds.has(id))) {
        awaitRun(late);
        settled = false;
      }
    }
    const gone = settled
      ? pending.filter((delivery) => delivery.state === "sending" && !onFileIds.has(delivery.id))
      : [];
    if (done.length > 0)
      // Fire and forget: what is not removed now is found on file again at the next look.
      void box
        .confirm(done.map((delivery) => delivery.id))
        .catch((error: unknown) => log("warn", "deliveries not confirmed", { sessionId, err: error }));
    if (gone.length > 0) {
      // Fire and forget: what is not put back now is found missing again at the next look.
      void box
        .mark(
          gone.map((delivery) => delivery.id),
          "waiting",
        )
        .then(dispatch, (error: unknown) => log("warn", "deliveries not put back", { sessionId, err: error }));
    }
  }

  /**
   * The entry of a run's last reply.
   *
   * @remarks
   * Read once the entries after a run are in (SPEC-0002, "送达": a notice keeps where its reply is).
   * Only a reply after the run's opening counts: the message of the deliveries it opened with, or
   * the user message of its turn. A run stopped before it replied has none, and a child's first
   * task does not take the last message of the conversation it was forked with.
   *
   * @sideEffects none
   * @param opened - The deliveries the run opened with, if it did.
   * @param turnId - The run's turn, for a run opened otherwise.
   * @returns Its id, or `null` without one.
   */
  function lastReply(opened: readonly string[] | null, turnId: string | null): string | null {
    const { branch } = transcript.entries();
    const entryId = opened === null && turnId !== null ? transcript.entryOfTurn(turnId) : null;
    const from =
      opened === null
        ? branch.findIndex((entry) => entry.id === entryId)
        : branch.findLastIndex(
            (entry) => entry.kind === "agent" && entry.details.deliveries.some((id) => opened.includes(id)),
          );
    if (from === -1) return null;
    return branch.slice(from + 1).findLast((entry) => entry.kind === "assistant")?.id ?? null;
  }

  /**
   * Adds a message to the end of the queue.
   *
   * @remarks
   * See `createSessionController`.
   *
   * @sideEffects Publishes `control_updated`.
   * @param message - The message and its images.
   * @param requestId - The command that sent it.
   * @param traceId - Its trace.
   * @returns The queued item's id.
   */
  function enqueue(message: Outgoing, requestId: string | null, traceId: string | null): string {
    const item: QueueItem = {
      id: newId(),
      text: message.text,
      images: message.images,
      createdAt: clock.now(),
      requestId,
      traceId,
    };
    queue.push(item);
    controlChanged();
    return item.id;
  }

  /**
   * Puts a message back at the front of the queue, as a new item.
   *
   * @remarks
   * For steers pi gave back and a message a crash interrupted after a stop.
   *
   * @sideEffects Updates the queue; does not publish.
   * @param messages - The messages and their images, in order.
   */
  function requeue(messages: readonly Outgoing[]): void {
    queue.unshift(
      ...messages.map(({ text, images }) => ({
        id: newId(),
        text,
        images,
        createdAt: clock.now(),
        requestId: null,
        traceId: null,
      })),
    );
  }

  /**
   * The steers pi gave back, as the host sent them, with their images.
   *
   * @remarks
   * pi gives back the last of the steers it listed, by its own texts; each goes back as it was
   * sent, so a skill is expanded again when it goes. Every steer has reached pi by then. A text
   * past the host's steers, which pi had from elsewhere, goes as pi gave it, without images.
   *
   * @sideEffects none
   * @param texts - The texts pi gave back.
   * @returns The messages.
   */
  function steersFor(texts: readonly string[]): Outgoing[] {
    // pi lists a steer before it answers, and a stop waits for every answer, so all are listed by
    // now (pi-internals.md §2); only those listed count, as SPEC-0001 says.
    // Stryker disable next-line MethodExpression: see above.
    const listed = steers.filter((steer) => steer.listed);
    const ours = listed.slice(Math.max(0, listed.length - texts.length));
    const others = texts.slice(0, texts.length - ours.length).map((text) => ({ text, images: [] }));
    return [...others, ...ours.map(({ text, images }) => ({ text, images }))];
  }

  /**
   * Sends a message, or queues it when the session is not idle or the queue goes first.
   *
   * @remarks
   * A message sent while idle goes out even when the queue is paused (SPEC-0001, "运行控制"). One
   * pi refuses as busy waits in the queue: a run pi began on its own goes first.
   *
   * @sideEffects Calls pi or updates the queue; publishes; moves the queue on.
   * @param message - The message and its images.
   * @param requestId - The command that sent it.
   * @param traceId - Its trace.
   * @returns The disposition, with the queued item's id when queued.
   * @throws {CommandError} As `promptFailure` makes them, other than busy.
   */
  async function submit(
    message: Outgoing,
    requestId: string | null,
    traceId: string | null,
  ): Promise<CommandResult<"prompt">> {
    if (!idle() || (queue.length > 0 && paused === null)) {
      return { disposition: "queued", itemId: enqueue(message, requestId, traceId) };
    }
    let disposition: "started" | "handled";
    try {
      disposition = await send(message, { requestId, traceId, auto: false });
    } catch (error) {
      // Busy: pi runs or compacts, and its end moves the queue on.
      if (isBusy(error)) return { disposition: "queued", itemId: enqueue(message, requestId, traceId) };
      dispatch();
      throw error;
    }
    dispatch();
    return { disposition };
  }

  /**
   * Notes that you sent a message.
   *
   * @remarks
   * A wait in the parent's agent returns at once (SPEC-0002, "等待的规则"), and deliveries held by a
   * paused queue go with your message (SPEC-0002, "送达").
   *
   * @sideEffects Tells the deliveries; may release them.
   */
  function spoke(): void {
    options.deliveries?.userSpoke();
    if (paused !== null) released = true;
  }

  /**
   * Refuses a message while a stop waits for pi.
   *
   * @remarks
   * Keeps the host and pi from disagreeing about what runs (SPEC-0001, "中断").
   *
   * @sideEffects none
   * @throws {CommandError} `session_stopping`.
   */
  function refuseWhileStopping(): void {
    if (stopping !== null) throw new CommandError("session_stopping");
    if (editing) throw new CommandError("session_busy");
  }

  /**
   * Refuses a message when the session's pi has gone and none replaces it.
   *
   * @remarks
   * The manager starts pi for a session that has none before passing a message on.
   *
   * @sideEffects none
   * @throws {CommandError} `pi_unavailable` with status `exited`.
   */
  function refuseWhenExited(): void {
    if (exited && restarting === null) throw new CommandError("pi_unavailable", { status: "exited" });
  }

  /**
   * Finds a queued message.
   *
   * @remarks
   * Items are named by the id `prompt` answered with.
   *
   * @sideEffects none
   * @param itemId - The item.
   * @returns It and its place.
   * @throws {CommandError} `queue_item_not_found`.
   */
  function queued(itemId: string): { readonly item: QueueItem; readonly index: number } {
    const index = queue.findIndex((item) => item.id === itemId);
    const item = queue[index];
    if (item === undefined) throw new CommandError("queue_item_not_found", { itemId });
    return { item, index };
  }

  /**
   * Sends a steer to pi while a run goes on, or the message as `submit` would otherwise.
   *
   * @remarks
   * pi's `steer` starts no run and is only delivered into one, so without a run the steer would
   * sit in pi's queue (SPEC-0001, "运行控制"). The steer is listed at once, so a queue update read
   * before pi answers still counts it; one pi handled or refused goes off the list again. Steers go
   * to pi one at a time, each once pi has answered the one before: pi runs extensions' input
   * handlers before queueing, which could reorder steers sent together. One whose turn comes after
   * the run ended goes as a message, and one whose turn comes once a stop began is refused. Images
   * alone go with `IMAGES_ONLY` as their text.
   *
   * @sideEffects Calls pi or updates the queue; publishes `control_updated` or `prompt_handled`.
   * @param message - The steer and its images.
   * @param requestId - The command that sent it.
   * @param traceId - Its trace.
   * @returns The disposition.
   * @throws {CommandError} As `promptFailure` makes them.
   */
  async function steerNow(
    message: Outgoing,
    requestId: string | null,
    traceId: string | null,
  ): Promise<CommandResult<"steer">> {
    if (run === null) {
      const { disposition } = await submit(message, requestId, traceId);
      return { disposition };
    }
    const steer: Steer = { id: requestId ?? newId(), text: message.text, images: message.images, listed: false };
    steers.push(steer);
    controlChanged();
    const before = steerTurn;
    const turn = Promise.withResolvers<void>();
    steerTurn = turn.promise;
    /**
     * Takes the steer off the list again.
     *
     * @remarks
     * pi handled or refused it.
     *
     * @sideEffects Updates the steers; publishes `control_updated`.
     */
    const withdraw = (): void => {
      steers = steers.filter((candidate) => candidate !== steer);
      controlChanged();
    };
    /**
     * Sends the steer once the one before has been answered.
     *
     * @remarks
     * See `steerNow`.
     *
     * @sideEffects Calls pi; may withdraw the steer or send it as a message.
     * @returns The disposition.
     */
    const sendInTurn = async (): Promise<CommandResult<"steer">> => {
      try {
        await before;
        // A stop has begun: the steer never reached pi, so it goes back to whoever sent it.
        if (stopping !== null) throw new CommandError("session_stopping");
        if (run === null) {
          withdraw();
          const { disposition } = await submit(message, requestId, traceId);
          return { disposition };
        }
        // Stryker disable next-line EqualityOperator: a message has text or images, never neither (`hasContent`).
        const text = message.text === "" && message.images.length > 0 ? IMAGES_ONLY : message.text;
        const { disposition } = await pi.steer(text, message.images);
        if (disposition === "handled") {
          withdraw();
          if (requestId !== null) emit({ type: "prompt_handled", clientMessageId: requestId });
        }
        return { disposition };
      } catch (error) {
        withdraw();
        throw promptFailure(error);
      } finally {
        turn.resolve();
      }
    };
    const answer = sendInTurn();
    steering.add(answer);
    try {
      return await answer;
    } finally {
      steering.delete(answer);
    }
  }

  /**
   * Hands the session a newly started pi.
   *
   * @remarks
   * Its entries are read whole, and every viewer gets a snapshot in a new epoch. Only a session
   * whose pi has exited takes a new one: two pi processes must never write one session file
   * (pi-internals.md §3).
   *
   * @sideEffects Subscribes to the new pi; publishes the snapshot.
   * @param started - The pi and its entries.
   * @throws {Error} When the session's pi still runs.
   */
  function attachPi(started: Respawned): void {
    if (!exited) throw new Error("the session's pi still runs");
    unsubscribe();
    pi = started.pi;
    exited = false;
    compacting = false;
    translate = createEventTranslator(() => clock.now());
    unsubscribe = pi.onEvent(heard);
    // Fire and forget: `exited` never rejects.
    void watchExit(pi);
    transcript.rebuild(started.entries, true);
    model = started.model ?? null;
    newEpoch();
    confirmDeliveries();
    // After the snapshot, so what the new pi's entries add follows it in the new epoch.
    const { all, branch } = transcript.entries();
    metrics.entriesChanged(all, branch);
    metrics.refresh();
    askPlan();
  }

  /**
   * Starts pi again after a crash.
   *
   * @remarks
   * See `createSessionController`. A start that fails counts as a restart; the count only resets
   * when a run ends without failing. A `shutdown` meanwhile stops the new pi instead. Another start
   * under way may hand the session its pi instead of this one.
   *
   * @sideEffects Starts pi; publishes the new epoch's snapshot and the restart notice.
   * @param respawn - How to start pi.
   * @returns Whether the session has a pi again.
   */
  async function restart(respawn: () => Promise<Respawned | null>): Promise<boolean> {
    for (;;) {
      // `shutdown` may come while pi starts, so this is asked again on every round.
      if (restarts >= MAX_RESTARTS || shuttingDown) return false;
      restarts += 1;
      let started: Respawned | null;
      try {
        started = await respawn();
      } catch (error) {
        log("warn", "pi restart failed", { sessionId, attempt: restarts, error: String(error) });
        continue;
      }
      if (shuttingDown) {
        await started?.pi.stop();
        return false;
      }
      if (started !== null) attachPi(started);
      if (exited) continue;
      emit(transcript.noteRestart(restarts));
      return true;
    }
  }

  /**
   * Picks up after pi started again: the interrupted message, then the queue.
   *
   * @remarks
   * A message pi had not echoed goes again as it was; one it had gets `CONTINUE_TEXT` after it.
   * After a stop nothing is sent: a message pi had not taken goes back to the front of the paused
   * queue, unless `force` (the user asked to retry). A queued message the queue took back is left
   * to the queue.
   *
   * @sideEffects Calls pi; publishes.
   * @param interrupted - The message the interrupted run was on, if any.
   * @param force - Whether to go on even after a stop.
   */
  async function carryOn(interrupted: Waiting | null, force: boolean): Promise<void> {
    // A queued message pi did not take is back in the queue already.
    const message = interrupted?.requeued === true ? null : interrupted;
    if (paused === "crashed") pauseQueue(null);
    if (paused === "stopped" && !force) {
      if (message !== null && !message.echoed) requeue([message]);
      controlChanged();
      return;
    }
    controlChanged();
    if (message !== null) {
      const resend = message.echoed
        ? {
            message: { text: CONTINUE_TEXT, images: [] },
            from: { requestId: null, traceId: message.traceId, auto: true },
          }
        : { message, from: { requestId: message.requestId, traceId: message.traceId, auto: message.auto } };
      try {
        await send(resend.message, resend.from);
      } catch (error) {
        log("warn", "resending after a restart failed", {
          sessionId,
          code: error instanceof CommandError ? error.code : null,
        });
      }
    }
    dispatch();
  }

  /**
   * Reports pi's exit and carries on without it, or with a new one after a crash.
   *
   * @remarks
   * pi will print nothing more, so a run in progress can only have failed. A pi that was replaced
   * meanwhile is no longer the session's. The exit also ends a stop that waited for pi.
   *
   * @sideEffects Publishes the turn's last events, `run_settled`, `control_updated` and
   * `session_exited`; may start pi again.
   * @param watched - The pi to watch.
   */
  async function watchExit(watched: SessionPi): Promise<void> {
    const wakers = new Set<(value: undefined) => void>();
    exitWakers.set(watched, wakers);
    const end = await watched.exited;
    exitWakers.delete(watched);
    for (const wake of wakers) wake(undefined);
    if (watched !== pi) return;
    exited = true;
    metrics.piChanged();
    const interrupted = run?.input ?? unconfirmed;
    unconfirmed = null;
    const crashed = !end.requested && !shuttingDown;
    const outcome = settle(true);
    if (outcome !== null) options.deliveries?.runSettled(outcome, crashed, Promise.resolve(null));
    // Stryker disable next-line ConditionalExpression: a guard is waiting only while `deliveryRun` is set, so cancelling it without one changes nothing.
    if (deliveryRun !== null) {
      deliveryRun = null;
      deliveryGuard?.();
    }
    steered = null;
    runDeliveries = null;
    waiting.length = 0;
    sending = false;
    starting = false;
    compacting = false;
    for (const id of interactions.keys()) close(id, "stale", null);
    if (steers.length > 0) {
      requeue(steers);
      steers = [];
    }
    stopping = null;
    if (crashed && queue.length > 0 && paused === null) pauseQueue("crashed");
    const respawn = options.respawn;
    // A replacement interrupted between rewind and submit must not resume the original branch.
    if (crashed && respawn !== undefined && !editing) {
      restarting = (async () => {
        const back = await restart(respawn);
        restarting = null;
        if (back) {
          // Fire and forget: `carryOn` reports its own failures, and a crash meanwhile restarts again.
          void carryOn(interrupted, false);
        } else if (!shuttingDown) {
          lost = interrupted;
          failure = { reason: "crashed", attempts: restarts };
          options.deliveries?.gaveUp();
        }
        controlChanged();
      })();
    }
    controlChanged();
    emit({
      type: "session_exited",
      reason: end.requested ? "requested" : "crashed",
      code: end.code,
      signal: end.signal,
    });
  }
  // Fire and forget: `exited` never rejects.
  void watchExit(pi);
  // After a restart of the host, what pi already has on file is not handed to it again (SPEC-0002, "送达").
  confirmDeliveries();

  /**
   * Ends a stop: the session takes messages again.
   *
   * @remarks
   * When pi confirms the abort, or exits.
   *
   * @sideEffects Publishes `control_updated`.
   */
  function endStop(): void {
    stopping = null;
    controlChanged();
  }

  /**
   * Waits for `work`, or for `current` to exit, whichever comes first.
   *
   * @remarks
   * `Promise.race` with `current.exited` would leave a reaction on it every time, holding the
   * caller's context and trace until pi exits; a long-lived pi stopped again and again piles them
   * up (found by the sessions soak). Here `watchExit`, which waits for each pi's exit anyway, wakes
   * the waits, and a wait that ends first takes itself off.
   *
   * @sideEffects none
   * @param work - What to wait for; it must not reject.
   * @param current - The pi.
   * @returns What `work` gave, or `undefined` once pi has exited.
   */
  async function untilExit<T>(work: Promise<T>, current: SessionPi): Promise<T | undefined> {
    const wakers = exitWakers.get(current);
    if (wakers === undefined) return undefined;
    const gone = Promise.withResolvers<undefined>();
    wakers.add(gone.resolve);
    const result = await Promise.race([work, gone.promise]);
    // Stryker disable next-line all: left in, each wait would hold its caller's context until pi exits; only the leak test (session-controller.leak.test.ts) sees that, and leak tests do not run per mutant.
    wakers.delete(gone.resolve);
    return result;
  }

  /**
   * Takes back pi's steers and aborts, waiting `STOP_CONFIRM_MS` from the stop for pi to confirm.
   *
   * @remarks
   * Both requests go at once. Unconfirmed, the stop ends when pi confirms later or exits; a
   * failed abort is no confirmation (SPEC-0001, "运行控制").
   *
   * @sideEffects Calls pi; schedules a timer; publishes `control_updated`.
   * @returns Whether pi confirmed in time.
   */
  async function halt(): Promise<CommandResult<"stop">> {
    const timedOut = Promise.withResolvers<false>();
    const cancel = clock.setTimeout(() => timedOut.resolve(false), STOP_CONFIRM_MS);
    const current = pi;
    const cleared = (async () => {
      try {
        // A steer still on its way would reach pi after the clear and wait there for the next run.
        if (steering.size > 0) await Promise.allSettled(steering);
        clearing = true;
        const { steering: held } = await current.clearQueue();
        requeue(steersFor(held));
        steers = [];
        controlChanged();
      } catch {
        // pi has gone; its exit takes the steers back.
      } finally {
        clearing = false;
      }
    })();
    const aborted = current.abort().then(
      () => true,
      () => false,
    );
    const confirmed = await Promise.race([aborted, timedOut.promise]);
    cancel();
    await untilExit(cleared, current);
    if (confirmed) {
      endStop();
    } else {
      // Fire and forget: the stop ends when pi confirms or exits, whichever comes first.
      void (async () => {
        // A failed abort is no confirmation: then only pi's exit ends the stop.
        if ((await untilExit(aborted, current)) !== true) await current.exited;
        if (stopping !== null) endStop();
      })();
    }
    return { confirmed };
  }

  return {
    sessionId,
    get exited() {
      return exited;
    },
    get restarting() {
      return restarting !== null;
    },
    get submitting() {
      return sending || starting || editing;
    },
    get forking() {
      return forking || editing;
    },
    snapshot,
    control,
    model: () => model,
    items: () => transcript.items(),
    attach(started) {
      // Started anew after the host stopped it for good, as when a session is opened again: before
      // the new pi is taken, so its figures are read and its subscription followed again.
      shuttingDown = false;
      metrics.reopen();
      attachPi(started);
      dispatch();
    },
    async prompt(command, images = []) {
      refuseWhenExited();
      refuseWhileStopping();
      spoke();
      // Stryker disable next-line OptionalChaining: commands are validated, so their traceparent always parses.
      const traceId = parseTraceparent(command.traceparent)?.traceId ?? null;
      return submit({ text: command.text, images }, command.requestId, traceId);
    },
    async editStoppedMessage(command, images = []) {
      refuseWhenExited();
      refuseWhileStopping();
      if (!idle()) throw new CommandError("session_busy");
      if (command.epoch !== epoch) throw new CommandError("transcript_changed");
      const last = transcript.items().findLast((item) => item.kind === "turn");
      if (last?.id !== command.turnId) throw new CommandError("transcript_changed");
      if (
        last.outcome !== "stopped" ||
        last.source !== null ||
        last.user.auto ||
        last.user.command !== null ||
        last.user.text.trimStart().startsWith("/") ||
        last.steps.some((step) => step.kind === "steer" || step.kind === "agent") ||
        command.text.trimStart().startsWith("/")
      ) {
        throw new CommandError("turn_not_editable");
      }
      editing = true;
      pauseQueue("stopped");
      controlChanged();
      try {
        await refreshing;
        if (
          command.epoch !== epoch ||
          transcript.items().findLast((item) => item.kind === "turn")?.id !== command.turnId
        ) {
          throw new CommandError("transcript_changed");
        }
        const entryId = transcript.entryOfTurn(command.turnId);
        if (entryId === null) throw new CommandError("transcript_changed");
        const result = await editStoppedBranch({
          pi,
          entryId,
          token: newId(),
          onBranch(page) {
            if (run !== null) return;
            transcript.rebuild(page, true);
            newEpoch();
            const { all, branch } = transcript.entries();
            metrics.entriesChanged(all, branch);
          },
          send: () =>
            send(
              { text: command.text, images },
              {
                requestId: command.requestId,
                traceId: parseTraceparent(command.traceparent)?.traceId ?? null,
                auto: false,
              },
            ),
        });
        spoke();
        return result;
      } finally {
        editing = false;
        controlChanged();
        dispatch();
      }
    },
    async steer(command, images = []) {
      refuseWhenExited();
      refuseWhileStopping();
      spoke();
      // Stryker disable next-line OptionalChaining: commands are validated, so their traceparent always parses.
      const traceId = parseTraceparent(command.traceparent)?.traceId ?? null;
      return steerNow({ text: command.text, images }, command.requestId, traceId);
    },
    stop() {
      if (editing) throw new CommandError("session_busy");
      if (stopping !== null) return stopping;
      if (restarting !== null) {
        // pi is not back yet: the restart puts the interrupted message in the paused queue.
        pauseQueue("stopped");
        controlChanged();
        return Promise.resolve({ confirmed: true });
      }
      if (run === null && !sending && !starting && !compacting) return Promise.resolve({ confirmed: true });
      pauseQueue("stopped");
      // pi's queue is cleared: a delivery steered in and not seen yet is gone with it (SPEC-0002, "送达").
      steered = null;
      stopping = halt();
      controlChanged();
      return stopping;
    },
    resumeQueue() {
      refuseWhileStopping();
      pauseQueue(null);
      controlChanged();
      dispatch();
      return {};
    },
    clearQueue() {
      queue.length = 0;
      controlChanged();
      return {};
    },
    updateQueued(itemId, text) {
      queued(itemId).item.text = text;
      controlChanged();
      return {};
    },
    removeQueued(itemId) {
      queue.splice(queued(itemId).index, 1);
      controlChanged();
      return {};
    },
    async steerQueued(itemId) {
      refuseWhenExited();
      refuseWhileStopping();
      const { item, index } = queued(itemId);
      queue.splice(index, 1);
      controlChanged();
      try {
        return await steerNow(item, item.requestId, item.traceId);
      } catch (error) {
        queue.splice(index, 0, item);
        controlChanged();
        throw error;
      }
    },
    answerInteraction(interactionId, answer) {
      const open = interactions.get(interactionId);
      if (open === undefined) throw new CommandError("interaction_closed", { interactionId });
      if (!fits(open.interaction.kind, answer)) throw new CommandError("invalid_message");
      pi.respond({ id: interactionId, ...answer });
      close(interactionId, "cancelled" in answer ? "cancelled" : "answered", answer);
      return {};
    },
    async setModel(ref) {
      await choose(() => pi.setModel(ref));
      return {};
    },
    async setThinkingLevel(level) {
      await choose(() => pi.setThinkingLevel(level));
      return {};
    },
    async setFast(enabled) {
      refuseWhenExited();
      refuseWhileStopping();
      try {
        await pi.setFast(enabled);
      } catch (error) {
        throw promptFailure(error);
      }
      options.onFastChosen?.(enabled);
      if (fast !== enabled) {
        fast = enabled;
        emit({ type: "fast_updated", fast });
      }
      return {};
    },
    async compact(instructions) {
      refuseWhenExited();
      // pi's `compact` stops a run first; Atrium refuses instead (SPEC-0001, "M1.11 的 `/` 命令 · 压缩").
      if (!idle() || stopping !== null) throw new CommandError("session_busy");
      compacting = true;
      controlChanged();
      try {
        await pi.compact(instructions);
      } catch (error) {
        if (!isPiFailure(error)) throw error;
        // Too little, or nothing new, is an answer; anything else fails without pi's words.
        // Stryker disable next-line StringLiteral: without pi's text there is nothing to tell apart.
        const code = compactRejection(error.detail ?? "");
        if (code !== null) throw new CommandError(code);
        log("warn", "compaction failed", { sessionId, reason: error.reason });
        throw new CommandError("compact_failed");
      } finally {
        compacting = false;
        controlChanged();
        dispatch();
      }
      return {};
    },
    async exportHtml(outputPath) {
      refuseWhenExited();
      try {
        await pi.exportHtml(outputPath);
      } catch (error) {
        if (!isPiFailure(error)) throw error;
        // pi's words stay out of the reply and the log (SPEC-0001, "M1.11 的 `/` 命令 · 其他宿主命令").
        log("warn", "export failed", { sessionId, reason: error.reason });
        throw new CommandError("export_failed", { reason: "failed" });
      }
    },
    async listCommands() {
      refuseWhenExited();
      try {
        return { commands: await pi.commands() };
      } catch (error) {
        throw promptFailure(error);
      }
    },
    async retryRun() {
      refuseWhileStopping();
      if (run !== null || sending || starting || restarting !== null) return {};
      if (exited) {
        const respawn = options.respawn;
        if (respawn === undefined) throw new CommandError("pi_unavailable", { status: "exited" });
        // Counts as a restart, so messages queue and another retry waits meanwhile.
        const pending = respawn();
        restarting = pending.then(
          () => undefined,
          () => undefined,
        );
        controlChanged();
        let started: Respawned | null;
        try {
          started = await pending;
        } finally {
          restarting = null;
          controlChanged();
        }
        if (shuttingDown) {
          await started?.pi.stop();
          return {};
        }
        if (started !== null) attachPi(started);
        // Another start under way was to hand the session its pi, and did not.
        if (exited) throw new CommandError("pi_unavailable", { status: "exited" });
      }
      restarts = 0;
      failure = null;
      const last = transcript.items().findLast((item) => item.kind === "turn");
      const interrupted =
        lost ??
        (last?.kind === "turn" && last.outcome === "failed"
          ? {
              requestId: null,
              traceId: null,
              text: last.user.text,
              // Stryker disable next-line ArrayDeclaration: an echoed message is never sent again; "继续" goes instead.
              images: [],
              // Stryker disable next-line BooleanLiteral: as above.
              auto: false,
              echoed: true,
              requeued: false,
            }
          : null);
      lost = null;
      await carryOn(interrupted, true);
      return {};
    },
    fetchTranscript(command) {
      const page = command.epoch === epoch ? transcript.before(command.before, command.limit) : null;
      if (page === null) throw new CommandError("transcript_changed");
      return page;
    },
    fetchStep(command) {
      const step = command.epoch === epoch ? transcript.step(command.turnId, command.stepId) : null;
      if (step === null) throw new CommandError("transcript_changed");
      return { step };
    },
    entryOfTurn: (turnId) => transcript.entryOfTurn(turnId),
    deliveriesChanged() {
      controlChanged();
      dispatch();
    },
    entriesRead: () => refreshing ?? Promise.resolve(),
    childrenChanged(totals) {
      metrics.childrenChanged(totals);
    },
    forkPoint(turnId) {
      // A run, a stop or a compaction still writes the file the fork reads; a pi that has exited
      // writes nothing, and the fork has a pi of its own.
      if (
        run !== null ||
        sending ||
        starting ||
        compacting ||
        forking ||
        editing ||
        stopping !== null ||
        restarting !== null
      ) {
        throw new CommandError("session_busy");
      }
      const turns = transcript.items().filter((item) => item.kind === "turn");
      const at = turns.findIndex((turn) => turn.id === turnId);
      if (at === -1) throw new CommandError("turn_not_found");
      const next = turns[at + 1];
      if (next === undefined) return null;
      // pi forks only at a user message; a turn notices or a task opened has none (SPEC-0002, "入口").
      if (next.source !== null) throw new CommandError("turn_not_found", { reason: "agent_turn" });
      // Only a turn seen live and never tied to its entry has none, and an idle session has none.
      const entryId = transcript.entryOfTurn(next.id);
      if (entryId === null) throw new CommandError("turn_not_found");
      return entryId;
    },
    holdForFork() {
      forking = true;
      return () => {
        forking = false;
        // Messages sent meanwhile went to the queue.
        dispatch();
      };
    },
    async shutdown() {
      shuttingDown = true;
      metrics.close();
      if (!exited) await pi.stop();
      await restarting;
    },
  };
}
