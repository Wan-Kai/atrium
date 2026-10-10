import type { Dialog, PiEvent, PiStats, TranslatedEvent } from "@atrium/pi";
import { createEventTranslator, isBusyRejection } from "@atrium/pi";
import {
  CommandError,
  type CommandResult,
  type Control,
  type FetchStepCommand,
  type FetchTranscriptCommand,
  type Interaction,
  type InteractionAnswer,
  type ModelRef,
  type PendingSteer,
  type PromptCommand,
  type RunSettledEvent,
  type SessionEvent,
  type SessionModel,
  type SessionSnapshotEvent,
  type SlashCommand,
  type SteerCommand,
  type ThinkingLevel,
  type TranscriptItem,
  parseTraceparent,
} from "@atrium/protocol";
import type { Clock } from "../platform/clock";
import { createMetricsTracker } from "./session-metrics";
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
  /** The model pi uses now, from `get_state`; `null` when it has none. */
  model(): Promise<SessionModel | null>;
  /** Sends `set_model`. */
  setModel(model: ModelRef): Promise<void>;
  /** Sends `set_thinking_level`. */
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  /** pi's slash commands, from `get_commands`. */
  commands(): Promise<SlashCommand[]>;
  /** pi's statistics for the status bar, from `get_session_stats`. */
  stats(): Promise<PiStats>;
  /** Stops pi; resolves once it has exited. */
  stop(): Promise<unknown>;
}

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
  /** Every item from the session's start, whole, unlike a snapshot's latest ones. */
  items(): TranscriptItem[];
  /** Hands a session whose pi exited a newly started one, which carries on in a new epoch. */
  attach(started: Respawned): void;
  /** Sends a message with its images, or queues it behind the run in progress. */
  prompt(command: PromptCommand, images?: readonly PromptImage[]): Promise<CommandResult<"prompt">>;
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
  /** pi's `/` commands, asked for each time the list opens. */
  listCommands(): Promise<CommandResult<"list_commands">>;
  /** Runs the last turn again, as after an automatic restart; starts pi first if it has exited. */
  retryRun(): Promise<CommandResult<"retry_run">>;
  /** Items before one the client has, for scrolling back. */
  fetchTranscript(command: FetchTranscriptCommand): CommandResult<"fetch_transcript">;
  /** One step whole, for one that traveled as a preview. */
  fetchStep(command: FetchStepCommand): CommandResult<"fetch_step">;
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
 * @sideEffects Subscribes to pi's events; calls `publish` for every event; calls `newId`; reads
 * pi's entries after runs and compactions, reporting failures to `onRefreshFailed`; schedules
 * timers on the clock; starts pi again through `respawn`; logs through `log`.
 * @param options - The session id, its pi, the entries it had at start, where events go, the
 * clock, an id source, where refresh failures and log lines go, the epoch to start in, the
 * session's turn starts (SPEC-0001, `steer`), and how to start pi again.
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
  /** Entries earlier host runs saw open a turn, and where newly seen ones go. */
  readonly turnStarts?: {
    readonly opened: ReadonlySet<string>;
    readonly auto?: ReadonlySet<string>;
    readonly record: (entryIds: readonly string[], autoIds: readonly string[]) => void;
  };
  /**
   * Starts the session's pi again; without it a crash is final. Resolves with `null` when another
   * start, already under way, hands the session its pi instead.
   */
  readonly respawn?: () => Promise<Respawned | null>;
  /** The model pi started with; none when left out. */
  readonly model?: SessionModel | null;
  /** Told the model and thinking level pi uses after you chose one, to remember for new sessions. */
  readonly onModelChosen?: (model: SessionModel) => void;
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
  /** Whether a refresh is running, and whether another was asked for meanwhile. */
  let refreshing = false;
  // Stryker disable next-line BooleanLiteral: the loop clears it before each read.
  let refreshAgain = false;
  let translate = createEventTranslator(() => clock.now());
  let unsubscribe = pi.onEvent((event) => {
    for (const translated of translate(event)) apply(translated);
  });

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
  const metrics = createMetricsTracker({
    clock,
    entries: transcript.entries(),
    readStats: () => pi.stats(),
    onChange: (now) => emit({ type: "metrics_updated", metrics: now }),
    onReadFailed: (error) => {
      // pi going away fails every request; its exit is reported as such.
      if (isPiFailure(error) && (error.reason === "exited" || error.reason === "stopped")) return;
      log("warn", "session stats not read", { sessionId, reason: isPiFailure(error) ? error.reason : "unknown" });
    },
  });
  metrics.refresh();

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
      paused,
      steers: steers.map(({ id, text }): PendingSteer => ({ id, text })),
      stopping: stopping !== null,
      restarting: restarting !== null,
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
      metrics: metrics.current(),
    };
  }

  /**
   * Takes the model pi reports, publishing it if it changed.
   *
   * @remarks
   * pi sends no event for a new model (pi-internals.md §3), so the controller reads it after
   * every change it asks for.
   *
   * @sideEffects May publish `model_updated`.
   * @param now - The model pi uses.
   */
  function modelIs(now: SessionModel | null): void {
    if (JSON.stringify(now) === JSON.stringify(model)) return;
    model = now;
    emit({ type: "model_updated", model });
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
   * @sideEffects Calls pi; may publish `model_updated`; reports the choice; starts a refresh.
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
   * @sideEffects Calls pi; may publish `model_updated`; reports the choice.
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
   */
  function settle(crashed: boolean): void {
    if (run === null) return;
    const events = transcript.settle(crashed);
    for (const event of events) emit(event);
    const finished = events.find((event) => event.type === "turn_finished");
    const outcome = crashed ? "failed" : finished === undefined ? "completed" : RUN_OUTCOMES[finished.outcome];
    emit({ type: "run_settled", runId: run.runId, outcome, settledAt: clock.now() });
    if (outcome !== "failed") restarts = 0;
    run = null;
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
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
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
        if (choiceToRead) await readChoice();
      } while (refreshAgain);
    } catch (error) {
      options.onRefreshFailed(error);
    } finally {
      refreshing = false;
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
        controlChanged();
        return;
      case "agent_settled":
        settle(false);
        // Fire and forget: `refresh` reports its own failures.
        void refresh();
        dispatch();
        return;
      case "compaction_started":
        compacting = true;
        return;
      case "compaction_finished":
        compacting = false;
        // Fire and forget: `refresh` reports its own failures.
        void refresh();
        dispatch();
        return;
      case "steering_changed":
        delivered(event.steering);
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
   * not compact, it is not being restarted and it is there.
   *
   * @sideEffects none
   * @returns Whether the session is idle.
   */
  function idle(): boolean {
    return run === null && !sending && !starting && !compacting && restarting === null && !exited;
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
    if (!idle() || paused !== null || stopping !== null) return;
    const item = queue.shift();
    if (item === undefined) return;
    controlChanged();
    send(item, { requestId: item.requestId, traceId: item.traceId, auto: false }, true).then(
      () => dispatch(),
      (error: unknown) => {
        queue.unshift(item);
        if (!isBusy(error) && !isGone(error)) {
          paused = "stopped";
          log("warn", "queued message refused", { sessionId, code: error instanceof CommandError ? error.code : null });
        }
        controlChanged();
      },
    );
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
    unsubscribe = pi.onEvent((event) => {
      for (const translated of translate(event)) apply(translated);
    });
    // Fire and forget: `exited` never rejects.
    void watchExit(pi);
    transcript.rebuild(started.entries, true);
    model = started.model ?? null;
    newEpoch();
    // After the snapshot, so what the new pi's entries add follows it in the new epoch.
    const { all, branch } = transcript.entries();
    metrics.entriesChanged(all, branch);
    metrics.refresh();
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
    if (paused === "crashed") paused = null;
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
    settle(true);
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
    const crashed = !end.requested && !shuttingDown;
    if (crashed && queue.length > 0 && paused === null) paused = "crashed";
    const respawn = options.respawn;
    if (crashed && respawn !== undefined) {
      restarting = (async () => {
        const back = await restart(respawn);
        restarting = null;
        if (back) {
          // Fire and forget: `carryOn` reports its own failures, and a crash meanwhile restarts again.
          void carryOn(interrupted, false);
        } else if (!shuttingDown) {
          lost = interrupted;
          failure = { reason: "crashed", attempts: restarts };
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
      return sending || starting;
    },
    snapshot,
    items: () => transcript.items(),
    attach(started) {
      attachPi(started);
      // Started anew after the host stopped it for good, as when a session is opened again.
      shuttingDown = false;
      dispatch();
    },
    async prompt(command, images = []) {
      refuseWhenExited();
      refuseWhileStopping();
      // Stryker disable next-line OptionalChaining: commands are validated, so their traceparent always parses.
      const traceId = parseTraceparent(command.traceparent)?.traceId ?? null;
      return submit({ text: command.text, images }, command.requestId, traceId);
    },
    async steer(command, images = []) {
      refuseWhenExited();
      refuseWhileStopping();
      // Stryker disable next-line OptionalChaining: commands are validated, so their traceparent always parses.
      const traceId = parseTraceparent(command.traceparent)?.traceId ?? null;
      return steerNow({ text: command.text, images }, command.requestId, traceId);
    },
    stop() {
      if (stopping !== null) return stopping;
      if (restarting !== null) {
        // pi is not back yet: the restart puts the interrupted message in the paused queue.
        paused = "stopped";
        controlChanged();
        return Promise.resolve({ confirmed: true });
      }
      if (run === null && !sending && !starting && !compacting) return Promise.resolve({ confirmed: true });
      paused = "stopped";
      stopping = halt();
      controlChanged();
      return stopping;
    },
    resumeQueue() {
      refuseWhileStopping();
      paused = null;
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
    async shutdown() {
      shuttingDown = true;
      metrics.close();
      if (!exited) await pi.stop();
      await restarting;
    },
  };
}
