import { type TranslatedEvent, createEventTranslator, isBusyRejection } from "@atrium/pi";
import type { PiEvent } from "@atrium/pi";
import {
  type AssistantBlock,
  CommandError,
  type CommandResult,
  type PromptCommand,
  type SessionEvent,
  type SessionSnapshotEvent,
  type StopReason,
  type TranscriptMessage,
  parseTraceparent,
} from "@atrium/protocol";

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

/** How a run ended, from the last assistant message's stop reason. */
const OUTCOMES: Readonly<Record<StopReason, "completed" | "stopped" | "failed">> = {
  stop: "completed",
  length: "completed",
  toolUse: "completed",
  error: "failed",
  aborted: "stopped",
};

/**
 * Creates the controller of one session, driving its pi and publishing what happens.
 *
 * @remarks
 * The runtime state (finished messages, the message streaming, the run in progress) lives here,
 * and snapshots and events are both made from it, so a client that subscribes gets a snapshot and
 * then exactly the events after it (domain-model §7). Every published event is numbered within the
 * session's epoch and carries the trace of the run it belongs to. A run starts with the first
 * `agent_start` after idle, so its `run_started` comes before the user message pi echoes, and ends
 * only at `agent_settled`; its trace is the one the `prompt` command carried. The user message pi
 * echoes is matched to the oldest `prompt` still waiting for it and carries that command's
 * `requestId` as `clientMessageId`, so the client can replace its optimistic copy. When pi exits,
 * a run in progress ends as failed, then `session_exited` follows.
 *
 * @sideEffects Subscribes to pi's events; calls `publish` for every event; calls `newId`.
 * @param options - The session id, its pi, where events go, the clock and an id source.
 * @returns The controller.
 */
export function createSessionController(options: {
  readonly sessionId: string;
  readonly pi: SessionPi;
  readonly publish: (event: SessionEvent) => void;
  readonly clock: { now(): number };
  readonly newId: () => string;
}): SessionController {
  const { sessionId, pi, clock, newId } = options;
  const epoch = 1;
  let seq = 0;
  const messages: TranscriptMessage[] = [];
  let streaming: { readonly messageId: string; content: AssistantBlock[] } | null = null;
  let run: { readonly runId: string; readonly startedAt: number; readonly traceId: string | null } | null = null;
  let lastStopReason: StopReason | null = null;
  /** `prompt`s pi has not echoed yet, oldest first. */
  const waiting: { readonly requestId: string; readonly traceId: string | null }[] = [];
  let exited = false;
  const translate = createEventTranslator(newId);

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
   * Appends streamed text to the message in progress.
   *
   * @remarks
   * A delta for a block that does not exist yet creates it with the delta's kind.
   *
   * @sideEffects Updates the streaming message.
   * @param type - Which kind of block.
   * @param index - The block's index.
   * @param delta - The new text.
   */
  function append(type: AssistantBlock["type"], index: number, delta: string): void {
    // Stryker disable next-line ConditionalExpression: the translator only reports deltas inside a message it started.
    if (streaming === null) return;
    const block = streaming.content[index];
    streaming.content[index] = { type, text: (block?.text ?? "") + delta };
  }

  /**
   * Applies one translated pi event to the runtime state and publishes it.
   *
   * @remarks
   * See `createSessionController`.
   *
   * @sideEffects Updates the runtime state; publishes events.
   * @param event - The translated event.
   */
  function apply(event: TranslatedEvent): void {
    switch (event.kind) {
      case "agent_started": {
        if (run !== null) return;
        run = { runId: newId(), startedAt: clock.now(), traceId: waiting[0]?.traceId ?? null };
        emit({ type: "run_started", runId: run.runId, startedAt: run.startedAt });
        lastStopReason = null;
        return;
      }
      case "message_started":
        streaming = { messageId: event.messageId, content: [] };
        emit({ type: "message_started", messageId: event.messageId });
        return;
      case "text_delta":
      case "reasoning_delta":
        append(event.kind === "text_delta" ? "text" : "reasoning", event.contentIndex, event.delta);
        emit({ type: event.kind, messageId: event.messageId, contentIndex: event.contentIndex, delta: event.delta });
        return;
      case "message_finished": {
        const message =
          event.message.role === "user"
            ? { ...event.message, clientMessageId: waiting.shift()?.requestId ?? null }
            : event.message;
        if (message.role === "assistant") {
          streaming = null;
          lastStopReason = message.stopReason;
        }
        messages.push(message);
        emit({ type: "message_finished", message });
        return;
      }
      case "agent_settled": {
        if (run === null) return;
        const outcome = lastStopReason === null ? "completed" : OUTCOMES[lastStopReason];
        emit({ type: "run_settled", runId: run.runId, outcome, settledAt: clock.now() });
        run = null;
        return;
      }
    }
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
   * @sideEffects Publishes `run_settled` and `session_exited`.
   */
  async function watchExit(): Promise<void> {
    const end = await pi.exited;
    exited = true;
    if (run !== null) {
      emit({ type: "run_settled", runId: run.runId, outcome: "failed", settledAt: clock.now() });
      run = null;
    }
    streaming = null;
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
    snapshot: () => ({
      type: "session_snapshot",
      sessionId,
      epoch,
      seq,
      traceId: run?.traceId ?? null,
      messages: [...messages],
      exited,
      streaming: streaming === null ? null : { messageId: streaming.messageId, content: [...streaming.content] },
      run: run === null ? null : { runId: run.runId, startedAt: run.startedAt },
    }),
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
    async stop() {
      await pi.stop();
    },
  };
}
