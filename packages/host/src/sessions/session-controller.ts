import type { PiEvent, TranslatedEvent } from "@atrium/pi";
import { createEventTranslator, isBusyRejection } from "@atrium/pi";
import {
  CommandError,
  type CommandResult,
  type FetchTranscriptCommand,
  type PromptCommand,
  type RunSettledEvent,
  type SessionEvent,
  type SessionSnapshotEvent,
  parseTraceparent,
} from "@atrium/protocol";
import { type EntriesPage, type TranscriptEvent, createSessionTranscript } from "../transcript/session-transcript";

/** How pi ended, as the controller needs it. */
interface PiEnd {
  readonly code: number | null;
  readonly signal: string | null;
  readonly requested: boolean;
}

/** The part of a running pi a session controller uses; the manager adapts a traced pi to it. */
export interface SessionPi {
  onEvent(listener: (event: PiEvent) => void): () => void;
  readonly exited: Promise<PiEnd>;
  /** Sends `prompt` and returns pi's disposition. */
  prompt(message: string): Promise<{ readonly disposition: "started" | "queued" | "handled" }>;
  /** Reads the session's entries after `since`, or all of them, converted. */
  getEntries(since: string | undefined): Promise<EntriesPage>;
  /** Stops pi; resolves once it has exited. */
  stop(): Promise<unknown>;
}

/** One session's live state and the commands on it (domain-model §3). */
export interface SessionController {
  readonly sessionId: string;
  /** The session's state now, for a client that just subscribed. */
  snapshot(): SessionSnapshotEvent;
  /** Sends a message to pi. */
  prompt(command: PromptCommand): Promise<CommandResult<"prompt">>;
  /** Items before one the client has, for scrolling back. */
  fetchTranscript(command: FetchTranscriptCommand): CommandResult<"fetch_transcript">;
  /** Stops pi, which publishes `session_exited`. */
  stop(): Promise<void>;
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
 * Turns a failed `prompt` into the error code the client gets.
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
  return isPiFailure(error) && error.reason === "rejected" && (error.detail ?? "").startsWith("Entry not found");
}

/**
 * Creates the controller of one session, driving its pi and publishing what happens.
 *
 * @remarks
 * The runtime state (the transcript, with the turn being built live, and the run in progress)
 * lives here, and snapshots and events are both made from it, so a client that subscribes gets a
 * snapshot and then exactly the events after it (domain-model §7). Every published event is
 * numbered within the session's epoch and carries the trace of the run it belongs to. A run starts
 * with the first `agent_start` after idle, so its `run_started` comes before the user message pi
 * echoes, and ends only at `agent_settled`, after its turn's `turn_finished`; its trace is the one
 * the `prompt` command carried. A turn pi opens is matched to the oldest `prompt` still waiting
 * and carries that command's `requestId` as `clientMessageId`, so the client can replace its
 * pending copy. After a run and after a compaction the controller reads pi's new entries and
 * rebuilds the transcript, never during a run (SPEC-0001, "快照与分页"): only notices added at
 * the end go out as `notice_added`; any other difference starts a new epoch and sends every
 * subscriber a fresh snapshot. When pi exits, a run in progress ends as failed, then
 * `session_exited` follows.
 *
 * @sideEffects Subscribes to pi's events; calls `publish` for every event; calls `newId`; reads
 * pi's entries after runs and compactions, reporting failures to `onRefreshFailed`.
 * @param options - The session id, its pi, the entries it had at start, where events go, the clock,
 * an id source, where refresh failures go, and the epoch to start in.
 * @returns The controller.
 */
export function createSessionController(options: {
  readonly sessionId: string;
  readonly pi: SessionPi;
  readonly entries: EntriesPage;
  readonly publish: (event: SessionEvent) => void;
  readonly clock: { now(): number };
  readonly newId: () => string;
  readonly onRefreshFailed: (error: unknown) => void;
  /** The epoch to start in; after the session's previous controller, one past its last. */
  readonly epoch?: number;
}): SessionController {
  const { sessionId, pi, clock, newId } = options;
  let epoch = options.epoch ?? 1;
  let seq = 0;
  const transcript = createSessionTranscript({ sessionId, newId, now: () => clock.now() });
  transcript.rebuild(options.entries, true);
  let run: { readonly runId: string; readonly startedAt: number; readonly traceId: string | null } | null = null;
  /** `prompt`s pi has not echoed yet, oldest first. */
  const waiting: { readonly requestId: string; readonly traceId: string | null }[] = [];
  let exited = false;
  /** Whether a refresh is running, and whether another was asked for meanwhile. */
  let refreshing = false;
  let refreshAgain = false;
  const translate = createEventTranslator(() => clock.now());

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
    };
  }

  /**
   * Ends the run in progress.
   *
   * @remarks
   * The turn finishes first, so `run_settled` comes after `turn_finished`. Without a turn (pi
   * started no turn this run) the run counts as completed, unless pi went away.
   *
   * @sideEffects Publishes the turn's last events and `run_settled`.
   * @param crashed - Whether pi exited mid-run.
   */
  function settle(crashed: boolean): void {
    if (run === null) return;
    const events = transcript.settle();
    for (const event of events) emit(event);
    const finished = events.find((event) => event.type === "turn_finished");
    const outcome = crashed ? "failed" : finished === undefined ? "completed" : RUN_OUTCOMES[finished.outcome];
    emit({ type: "run_settled", runId: run.runId, outcome, settledAt: clock.now() });
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
        if (result.kind === "appended") for (const event of result.events) emit(event);
        if (result.kind === "changed") {
          epoch += 1;
          seq = 0;
          options.publish(snapshot());
        }
      } while (refreshAgain);
    } catch (error) {
      options.onRefreshFailed(error);
    } finally {
      refreshing = false;
    }
  }

  /**
   * Applies one translated pi event to the runtime state and publishes what changed.
   *
   * @remarks
   * See `createSessionController`.
   *
   * @sideEffects Updates the runtime state; publishes events; may start a refresh.
   * @param event - The translated event.
   */
  function apply(event: TranslatedEvent): void {
    if (event.kind === "agent_started") {
      if (run !== null) return;
      run = { runId: newId(), startedAt: clock.now(), traceId: waiting[0]?.traceId ?? null };
      emit({ type: "run_started", runId: run.runId, startedAt: run.startedAt });
      return;
    }
    if (event.kind === "agent_settled" || event.kind === "compaction_finished") {
      if (event.kind === "agent_settled") settle(false);
      // Fire and forget: `refresh` reports its own failures.
      void refresh();
      return;
    }
    for (const published of transcript.apply(event, () => waiting.shift()?.requestId ?? null)) emit(published);
  }

  pi.onEvent((event) => {
    for (const translated of translate(event)) apply(translated);
  });

  /**
   * Reports pi's exit, ending a run that was still going.
   *
   * @remarks
   * pi will print nothing more, so a run in progress can only have failed.
   *
   * @sideEffects Publishes the turn's last events, `run_settled` and `session_exited`.
   */
  async function watchExit(): Promise<void> {
    const end = await pi.exited;
    exited = true;
    settle(true);
    emit({
      type: "session_exited",
      reason: end.requested ? "requested" : "crashed",
      code: end.code,
      signal: end.signal,
    });
  }
  // Fire and forget: `exited` never rejects.
  void watchExit();

  return {
    sessionId,
    snapshot,
    async prompt(command) {
      if (exited) throw new CommandError("pi_unavailable", { status: "exited" });
      // Stryker disable next-line OptionalChaining: commands are validated, so their traceparent always parses.
      const entry = { requestId: command.requestId, traceId: parseTraceparent(command.traceparent)?.traceId ?? null };
      waiting.push(entry);
      /**
       * Stops waiting for pi to echo this prompt.
       *
       * @remarks
       * The echo may already have taken the entry; then there is nothing to remove, and removing
       * by index -1 would drop another prompt's entry.
       *
       * @sideEffects Updates the waiting list.
       */
      const forget = (): void => {
        const index = waiting.indexOf(entry);
        if (index !== -1) waiting.splice(index, 1);
      };
      try {
        const { disposition } = await pi.prompt(command.text);
        if (disposition === "handled") forget();
        return { disposition };
      } catch (error) {
        forget();
        throw promptFailure(error);
      }
    },
    fetchTranscript(command) {
      const page = command.epoch === epoch ? transcript.before(command.before, command.limit) : null;
      if (page === null) throw new CommandError("transcript_changed");
      return page;
    },
    async stop() {
      await pi.stop();
    },
  };
}
