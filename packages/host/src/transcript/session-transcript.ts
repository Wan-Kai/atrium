import type { LogEntry, TranslatedEvent } from "@atrium/pi";
import {
  type Notice,
  type NoticeAddedEvent,
  SNAPSHOT_TURNS,
  type Step,
  type StepAddedEvent,
  type StepDeltaEvent,
  type StepUpdatedEvent,
  type TranscriptItem,
  type TurnFinishedEvent,
  type TurnStartedEvent,
} from "@atrium/protocol";
import { projectTranscript } from "./projection";
import { type SessionLog, createSessionLog } from "./session-log";
import { TurnDraft, type TurnFacts } from "./turn-draft";

/** Fields the controller adds to every event it publishes. */
type Envelope = "sessionId" | "epoch" | "seq" | "traceId";

/** A transcript event before the controller numbers it. */
export type TranscriptEvent =
  | Omit<TurnStartedEvent, Envelope>
  | Omit<StepAddedEvent, Envelope>
  | Omit<StepDeltaEvent, Envelope>
  | Omit<StepUpdatedEvent, Envelope>
  | Omit<TurnFinishedEvent, Envelope>
  | Omit<NoticeAddedEvent, Envelope>;

/** Entries pi returned for `get_entries`, converted. */
export interface EntriesPage {
  readonly entries: readonly LogEntry[];
  readonly leafId: string | null;
}

/** What a rebuild found, compared with what clients were sent. */
export type RebuildResult =
  | { readonly kind: "same" }
  /** Only notices were added at the end; each goes out as `notice_added`. */
  | { readonly kind: "appended"; readonly events: TranscriptEvent[] }
  /** Anything else: clients need a new snapshot in a new epoch. */
  | { readonly kind: "changed" };

/** A window of items, with whether earlier ones exist. */
interface TranscriptPage {
  readonly items: TranscriptItem[];
  readonly hasOlder: boolean;
}

/** One session's transcript: rebuilt from pi's entries, and built live from pi's events. */
export interface SessionTranscript {
  /** The last entry received, to ask pi only for newer ones. */
  readonly cursor: string | undefined;
  /** Whether a turn is being built live. */
  readonly live: boolean;
  /** Every item, the turn running now included. */
  items(): TranscriptItem[];
  /**
   * Applies one of pi's translated events.
   *
   * @param event - The event.
   * @param clientMessageId - Gives the `requestId` of the `prompt` a new turn answers; called once per turn.
   * @returns The events to publish.
   */
  apply(event: TranslatedEvent, clientMessageId: () => string | null): TranscriptEvent[];
  /** Ends the turn running now, when the run settles; returns the events to publish. */
  settle(): TranscriptEvent[];
  /**
   * Adds entries pi returned and rebuilds the transcript from the current branch.
   *
   * @param page - The entries and leaf.
   * @param reset - Whether the page holds the whole session rather than what follows the cursor.
   */
  rebuild(page: EntriesPage, reset: boolean): RebuildResult;
  /** The latest turns, with the notices among and after them. */
  latest(): TranscriptPage;
  /** Up to `limit` items before the one with id `before`; `null` if there is no such item. */
  before(before: string, limit: number): TranscriptPage | null;
}

/**
 * Creates a session's transcript.
 *
 * @remarks
 * Live, a turn starts when pi echoes a user message and ends when the run settles; its steps
 * follow pi's events through a `TurnDraft`, the same builder a rebuild uses, and the host times
 * the turn and its thinking with its own clock. A user message right after a tool result is a
 * steer instead. A user message while a turn runs that is not a steer ends that turn and starts
 * another, as a follow-up would. What was measured live is kept by turn ("当场计时的数据") and,
 * after a rebuild, tied to the entries that opened those turns: the newest unclaimed turn entries
 * from that read, matched from the end, so the rebuilt turns keep their live ids and timings and
 * a normal run rebuilds exactly as it was sent (SPEC-0001, "快照与分页"). Rebuilds only happen
 * between runs; the caller makes sure of that.
 *
 * @sideEffects none; the returned object keeps the session's state and calls `newId` and `now`.
 * @param options - The session id, a source of turn ids and the host's clock.
 * @returns The transcript.
 */
export function createSessionTranscript(options: {
  readonly sessionId: string;
  readonly newId: () => string;
  readonly now: () => number;
}): SessionTranscript {
  const { sessionId, newId, now } = options;
  const log: SessionLog = createSessionLog();
  /** Finished items, in order. */
  let items: TranscriptItem[] = [];
  /** Facts of turns seen live, by the entry that opened them. */
  const factsByEntry = new Map<string, TurnFacts>();
  /** Facts of turns seen live since the last rebuild, oldest first, not yet tied to entries. */
  let unbound: TurnFacts[] = [];
  let live: {
    readonly draft: TurnDraft;
    readonly startedAt: number;
    readonly thinkingMs: Map<string, number>;
    /** The thinking step being timed, and since when. */
    thinking: { readonly id: string; readonly since: number } | null;
  } | null = null;

  /**
   * Stops timing the thinking step in progress.
   *
   * @remarks
   * Thinking ends when the next block starts or its message finishes.
   *
   * @sideEffects Updates the live turn.
   * @returns The events to publish.
   */
  function endThinking(): TranscriptEvent[] {
    if (live === null || live.thinking === null) return [];
    const durationMs = Math.max(0, now() - live.thinking.since);
    live.thinkingMs.set(live.thinking.id, durationMs);
    const step = live.draft.timeThinking(live.thinking.id, durationMs);
    live.thinking = null;
    return step === null ? [] : [{ type: "step_updated", turnId: live.draft.id, step }];
  }

  /**
   * Ends the live turn.
   *
   * @remarks
   * Its facts wait to be tied to the entry that opened it at the next rebuild.
   *
   * @sideEffects Moves the turn to the finished items; records its facts.
   * @returns The events to publish.
   */
  function finishLive(): TranscriptEvent[] {
    if (live === null) return [];
    const events = endThinking();
    const facts: TurnFacts = {
      turnId: live.draft.id,
      clientMessageId: live.draft.user.clientMessageId,
      durationMs: Math.max(0, now() - live.startedAt),
      thinkingMs: live.thinkingMs,
    };
    const { changed, turn } = live.draft.finish(facts);
    for (const step of changed) events.push({ type: "step_updated", turnId: turn.id, step });
    events.push({
      type: "turn_finished",
      turnId: turn.id,
      outcome: turn.outcome,
      error: turn.error,
      durationMs: turn.durationMs,
      usage: turn.usage,
      changes: turn.changes,
    });
    unbound.push(facts);
    items.push(turn);
    live = null;
    return events;
  }

  /**
   * Applies a finished message.
   *
   * @remarks
   * See `createSessionTranscript`.
   *
   * @sideEffects Updates the live turn.
   * @param message - The message.
   * @param clientMessageId - See `SessionTranscript.apply`.
   * @returns The events to publish.
   */
  function finished(
    message: Extract<TranslatedEvent, { kind: "message_finished" }>["message"],
    clientMessageId: () => string | null,
  ): TranscriptEvent[] {
    if (message.kind === "user") {
      if (live?.draft.takesSteer === true) {
        return [{ type: "step_added", turnId: live.draft.id, step: live.draft.steer(message.text, message.timestamp) }];
      }
      const events = finishLive();
      const draft = new TurnDraft(newId(), {
        text: message.text,
        images: message.images,
        clientMessageId: clientMessageId(),
        timestamp: message.timestamp,
      });
      live = { draft, startedAt: now(), thinkingMs: new Map(), thinking: null };
      events.push({ type: "turn_started", turn: draft.running() });
      return events;
    }
    if (live === null) return [];
    const turnId = live.draft.id;
    if (message.kind === "assistant") {
      return [...endThinking(), ...live.draft.finishAssistant(message).map((change) => stepEvent(turnId, change))];
    }
    const step = live.draft.toolResult(message.callId, message, message.timestamp);
    return step === null ? [] : [{ type: "step_updated", turnId, step }];
  }

  return {
    get cursor() {
      return log.cursor;
    },
    get live() {
      return live !== null;
    },
    items: () => (live === null ? [...items] : [...items, live.draft.running()]),
    apply(event, clientMessageId) {
      if (event.kind === "message_finished") return finished(event.message, clientMessageId);
      if (live === null) return [];
      const turnId = live.draft.id;
      if (event.kind === "assistant_started") {
        live.draft.startAssistant();
        return endThinking();
      }
      if (event.kind === "part_started") {
        const events = endThinking();
        const change = live.draft.setPart(event.index, event.part);
        if (event.part.type === "thinking") live.thinking = { id: change.step.id, since: now() };
        events.push(stepEvent(turnId, change));
        return events;
      }
      if (event.kind === "part_delta") {
        const stepId = live.draft.appendText(event.index, event.delta);
        return stepId === null ? [] : [{ type: "step_delta", turnId, stepId, delta: event.delta }];
      }
      if (event.kind === "tool_output") {
        const step = live.draft.toolOutput(event.callId, event.text);
        return step === null ? [] : [{ type: "step_updated", turnId, step }];
      }
      if (event.kind === "retry_started") {
        return [{ type: "step_added", turnId, step: live.draft.retry(event.attempt, event.error) }];
      }
      // Runs and compactions are the controller's business.
      return [];
    },
    settle: finishLive,
    rebuild(page, reset) {
      if (reset) log.clear();
      const fresh = log.append(page.entries, page.leafId);
      let projection = projectTranscript(log.branch(), sessionId, factsByEntry);
      const claimable = projection.turnEntryIds.filter((id) => fresh.has(id) && !factsByEntry.has(id));
      const count = Math.min(claimable.length, unbound.length);
      const claimed = claimable.slice(claimable.length - count);
      const facts = unbound.slice(unbound.length - count);
      claimed.forEach((entryId, index) => {
        const turnFacts = facts[index];
        // Stryker disable next-line ConditionalExpression: both lists are `count` long.
        if (turnFacts !== undefined) factsByEntry.set(entryId, turnFacts);
      });
      unbound = [];
      if (count > 0) projection = projectTranscript(log.branch(), sessionId, factsByEntry);
      const before = items;
      items = [...projection.items];
      const kept = items.slice(0, before.length).every((item, index) => sameItem(item, before[index]));
      if (kept && items.length === before.length) return { kind: "same" };
      const added = items.slice(before.length);
      if (kept && items.length > before.length && added.every(isNotice)) {
        return { kind: "appended", events: added.map((notice) => ({ type: "notice_added", notice })) };
      }
      return { kind: "changed" };
    },
    latest() {
      const all = this.items();
      let start = all.length;
      let turns = 0;
      while (start > 0 && turns < SNAPSHOT_TURNS) {
        start -= 1;
        if (all[start]?.kind === "turn") turns += 1;
      }
      return { items: all.slice(start), hasOlder: start > 0 };
    },
    before(id, limit) {
      const all = this.items();
      const end = all.findIndex((item) => item.id === id);
      if (end === -1) return null;
      const start = Math.max(0, end - limit);
      return { items: all.slice(start, end), hasOlder: start > 0 };
    },
  };
}

/**
 * The event for a step that was added or changed.
 *
 * @remarks
 * A block that was already in place live is updated rather than added again.
 *
 * @sideEffects none
 * @param turnId - The turn's id.
 * @param change - The step and whether it is new.
 * @returns The event.
 */
function stepEvent(turnId: string, change: { readonly step: Step; readonly added: boolean }): TranscriptEvent {
  return { type: change.added ? "step_added" : "step_updated", turnId, step: change.step };
}

/**
 * Whether a rebuilt item is the one clients were sent.
 *
 * @remarks
 * Items are plain JSON built in the same key order either way, so their serializations compare.
 *
 * @sideEffects none
 * @param item - The rebuilt item.
 * @param sent - The item clients have at that place, if any.
 * @returns Whether they are the same.
 */
function sameItem(item: TranscriptItem, sent: TranscriptItem | undefined): boolean {
  return JSON.stringify(item) === JSON.stringify(sent);
}

/**
 * Whether an item is a notice.
 *
 * @remarks
 * Narrows the type for `notice_added`.
 *
 * @sideEffects none
 * @param item - The item.
 * @returns Whether it is a notice.
 */
function isNotice(item: TranscriptItem): item is Notice {
  return item.kind === "notice";
}
