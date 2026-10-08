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
import { forTransport, itemForTransport } from "./rules";
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
  /** Only notices were added; each goes out as `notice_added` with where it goes. */
  | { readonly kind: "notices"; readonly events: TranscriptEvent[] }
  /** Anything else: clients need a new snapshot in a new epoch. */
  | { readonly kind: "changed" };

/** A window of items, as they travel, with whether earlier ones exist. */
interface TranscriptPage {
  readonly items: TranscriptItem[];
  readonly hasOlder: boolean;
}

/** The most bytes of JSON a snapshot or a page carries (SPEC-0001, "快照与分页"). */
export const PAGE_BYTES = 4 * 1024 * 1024;

/** One session's transcript: rebuilt from pi's entries, and built live from pi's events. */
export interface SessionTranscript {
  /** The last entry received, to ask pi only for newer ones. */
  readonly cursor: string | undefined;
  /** Whether a turn is being built live. */
  readonly live: boolean;
  /** Every item, whole, the turn running now included. */
  items(): TranscriptItem[];
  /**
   * Applies one of pi's translated events.
   *
   * @param event - The event.
   * @param clientMessageId - Gives the `requestId` of the `prompt` a new turn answers; called once per turn.
   * @returns The events to publish.
   */
  apply(event: TranslatedEvent, clientMessageId: () => string | null): TranscriptEvent[];
  /**
   * Ends the turn running now, when the run settles or pi goes away.
   *
   * @param crashed - Whether pi went away mid-run.
   * @returns The events to publish.
   */
  settle(crashed?: boolean): TranscriptEvent[];
  /**
   * Adds entries pi returned and rebuilds the transcript from the current branch.
   *
   * @param page - The entries and leaf.
   * @param reset - Whether the page holds the whole session rather than what follows the cursor.
   */
  rebuild(page: EntriesPage, reset: boolean): RebuildResult;
  /** The latest turns, with the notices among and after them, as they travel. */
  latest(): TranscriptPage;
  /** Up to `limit` items before the one with id `before`, as they travel; `null` if there is no such item. */
  before(before: string, limit: number): TranscriptPage | null;
  /** One step, whole; `null` if there is no such step. */
  step(turnId: string, stepId: string): Step | null;
}

/**
 * A user message seen live that opened a turn, with what was measured of it once the turn ends.
 *
 * @remarks
 * A steer is recorded as `null`: it only keeps the order. Live, a message is a steer exactly when
 * pi's file shows one, right after a tool result (SPEC-0001, `steer`), so the rebuild already
 * agrees; what it cannot tell is that a message after a tool result opened a turn.
 */
interface SeenTurn {
  facts: TurnFacts | null;
}

/**
 * Creates a session's transcript.
 *
 * @remarks
 * Live, a turn starts when pi echoes a user message and ends when the run settles; its steps
 * follow pi's events through a `TurnDraft`, the same builder a rebuild uses, and the host times
 * the turn and its thinking with its own clock. A user message right after a tool result is a
 * steer instead. A user message while a turn runs that is not a steer ends that turn and starts
 * another, as a follow-up would. Every user message seen live is recorded, in order, as a new turn
 * with what was measured of it, or a steer (`SeenTurn`, "当场计时的数据"). After a rebuild the
 * records are tied to the new user message entries of that read, matched from the end, and the
 * rebuild follows them: the turns keep their live ids and timings, and a turn stays a turn even
 * where pi's file would suggest a steer (SPEC-0001, `steer`), so a normal run rebuilds exactly as
 * it was sent.
 * Events, snapshots and pages carry steps as they travel (`forTransport`); the transcript keeps
 * them whole. Rebuilds only happen between runs; the caller makes sure of that.
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
  /** Finished items, whole, in order. */
  let items: TranscriptItem[] = [];
  /** Facts of turns seen live, by the entry that opened them. */
  const factsByEntry = new Map<string, TurnFacts>();
  /** User messages seen live since the last rebuild, oldest first, not yet tied to entries. */
  // Stryker disable next-line ArrayDeclaration: a made-up record has no facts and only shifts nothing at the start.
  let seen: (SeenTurn | null)[] = [];
  let live: {
    readonly draft: TurnDraft;
    readonly record: SeenTurn;
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
   * @param current - The live turn.
   * @returns The events to publish.
   */
  function endThinking(current: NonNullable<typeof live>): TranscriptEvent[] {
    if (current.thinking === null) return [];
    const durationMs = Math.max(0, now() - current.thinking.since);
    current.thinkingMs.set(current.thinking.id, durationMs);
    const step = current.draft.timeThinking(current.thinking.id, durationMs);
    current.thinking = null;
    // Stryker disable next-line ConditionalExpression,ArrayDeclaration: only a thinking step is ever timed, which timing always updates.
    return step === null ? [] : [{ type: "step_updated", turnId: current.draft.id, step }];
  }

  /**
   * Ends the live turn.
   *
   * @remarks
   * Its facts wait in its record to be tied to the entry that opened it at the next rebuild.
   *
   * @sideEffects Moves the turn to the finished items; records its facts.
   * @param crashed - Whether pi went away mid-run.
   * @returns The events to publish.
   */
  function finishLive(crashed: boolean): TranscriptEvent[] {
    if (live === null) return [];
    const events = endThinking(live);
    const facts: TurnFacts = {
      turnId: live.draft.id,
      clientMessageId: live.draft.user.clientMessageId,
      durationMs: Math.max(0, now() - live.startedAt),
      thinkingMs: live.thinkingMs,
    };
    const { changed, turn } = live.draft.finish(facts, crashed);
    for (const step of changed) events.push({ type: "step_updated", turnId: turn.id, step: forTransport(step) });
    events.push({
      type: "turn_finished",
      turnId: turn.id,
      outcome: turn.outcome,
      error: turn.error,
      durationMs: turn.durationMs,
      usage: turn.usage,
      changes: turn.changes,
    });
    live.record.facts = facts;
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
   * @sideEffects Updates the live turn and the record of user messages.
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
        seen.push(null);
        return [{ type: "step_added", turnId: live.draft.id, step: live.draft.steer(message.text, message.timestamp) }];
      }
      const events = finishLive(false);
      const draft = new TurnDraft(newId(), {
        text: message.text,
        images: message.images,
        clientMessageId: clientMessageId(),
        timestamp: message.timestamp,
      });
      const record: SeenTurn = { facts: null };
      seen.push(record);
      live = { draft, record, startedAt: now(), thinkingMs: new Map(), thinking: null };
      events.push({ type: "turn_started", turn: draft.running() });
      return events;
    }
    if (live === null) return [];
    const turnId = live.draft.id;
    if (message.kind === "assistant") {
      return [...endThinking(live), ...live.draft.finishAssistant(message).map((change) => stepEvent(turnId, change))];
    }
    const step = live.draft.toolResult(message.callId, message, message.timestamp);
    return step === null ? [] : [{ type: "step_updated", turnId, step: forTransport(step) }];
  }

  /**
   * Ties the user messages seen live to the new user message entries of a read.
   *
   * @remarks
   * Matched from the end: the newest entries are the ones the host saw. Records that find no
   * entry are dropped; they would never match later.
   *
   * @sideEffects Records facts by entry; clears the records.
   * @param fresh - Ids of the entries this read added.
   */
  function bindSeen(fresh: ReadonlySet<string>): void {
    const users = log.branch().filter((entry) => entry.kind === "user" && fresh.has(entry.id));
    const count = Math.min(users.length, seen.length);
    const entries = users.slice(users.length - count);
    const records = seen.slice(seen.length - count);
    entries.forEach((entry, index) => {
      const facts = records[index]?.facts;
      if (facts !== undefined && facts !== null) factsByEntry.set(entry.id, facts);
    });
    // Stryker disable next-line ArrayDeclaration: see `seen`.
    seen = [];
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
        return endThinking(live);
      }
      if (event.kind === "part_started") {
        const events = endThinking(live);
        const change = live.draft.setPart(event.index, event.part);
        // Stryker disable next-line ConditionalExpression: timing another block leaves its step as it is, and only thinking steps' durations are read.
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
        return step === null ? [] : [{ type: "step_updated", turnId, step: forTransport(step) }];
      }
      if (event.kind === "retry_started") {
        return [{ type: "step_added", turnId, step: live.draft.retry(event.attempt, event.error) }];
      }
      // Runs and compactions are the controller's business.
      return [];
    },
    settle: (crashed = false) => finishLive(crashed),
    rebuild(page, reset) {
      if (reset) log.clear();
      bindSeen(log.append(page.entries, page.leafId));
      const before = items;
      items = [...projectTranscript(log.branch(), sessionId, factsByEntry).items];
      return compare(before, items);
    },
    latest() {
      const all = this.items();
      return takeFromEnd(all, (taken) => taken.filter((item) => item.kind === "turn").length >= SNAPSHOT_TURNS);
    },
    before(id, limit) {
      const all = this.items();
      const end = all.findIndex((item) => item.id === id);
      if (end === -1) return null;
      return takeFromEnd(all.slice(0, end), (taken) => taken.length >= limit);
    },
    step(turnId, stepId) {
      const turn = this.items().findLast((item) => item.id === turnId);
      return turn?.kind === "turn" ? (turn.steps.find((step) => step.id === stepId) ?? null) : null;
    },
  };
}

/**
 * Takes items from the end of a list, as they travel, until a count or the size limit is reached.
 *
 * @remarks
 * At least one item is always taken, however big (SPEC-0001, "快照与分页"). Counting turns stops
 * at a turn, so notices after the earliest turn taken come along and those before it wait for
 * the next page.
 *
 * @sideEffects none
 * @param from - The items to take from, whole.
 * @param enough - Whether the items taken so far are enough.
 * @returns The items taken, in order, and whether earlier ones remain.
 */
function takeFromEnd(
  from: readonly TranscriptItem[],
  enough: (taken: readonly TranscriptItem[]) => boolean,
): TranscriptPage {
  const taken: TranscriptItem[] = [];
  let bytes = 0;
  for (const whole of from.toReversed()) {
    if (enough(taken)) break;
    const item = itemForTransport(whole);
    // Stryker disable next-line StringLiteral: an empty encoding is UTF-8.
    const size = Buffer.byteLength(JSON.stringify(item), "utf8");
    // Stryker disable next-line EqualityOperator: exactly at the limit is within it by one byte either way.
    if (taken.length > 0 && bytes + size > PAGE_BYTES) break;
    taken.unshift(item);
    bytes += size;
  }
  return { items: taken, hasOlder: taken.length < from.length };
}

/**
 * Compares a rebuild with the items clients were sent.
 *
 * @remarks
 * Equal is nothing to send. If the only difference is notices, wherever they are, each goes out
 * as `notice_added` with the item it goes before, the earliest first, so a client inserting them
 * in turn ends with the rebuilt list. Anything else changed (SPEC-0001, "快照与分页").
 *
 * @sideEffects none
 * @param sent - The items clients have.
 * @param rebuilt - The rebuilt items.
 * @returns What changed.
 */
function compare(sent: readonly TranscriptItem[], rebuilt: readonly TranscriptItem[]): RebuildResult {
  const known = new Set(sent.map((item) => item.id));
  const kept = rebuilt.filter((item) => known.has(item.id));
  if (kept.length !== sent.length || !kept.every((item, index) => sameItem(item, sent[index]))) {
    return { kind: "changed" };
  }
  const added = rebuilt.filter((item) => !known.has(item.id));
  if (added.length === 0) return { kind: "same" };
  if (!added.every(isNotice)) return { kind: "changed" };
  return {
    kind: "notices",
    events: added.map((notice) => {
      const next = rebuilt.slice(rebuilt.indexOf(notice) + 1).find((item) => known.has(item.id));
      return { type: "notice_added", notice, before: next?.id ?? null };
    }),
  };
}

/**
 * The event for a step that was added or changed.
 *
 * @remarks
 * A block that was already in place live is updated rather than added again; the step travels
 * as `forTransport` makes it.
 *
 * @sideEffects none
 * @param turnId - The turn's id.
 * @param change - The step and whether it is new.
 * @returns The event.
 */
function stepEvent(turnId: string, change: { readonly step: Step; readonly added: boolean }): TranscriptEvent {
  return { type: change.added ? "step_added" : "step_updated", turnId, step: forTransport(change.step) };
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
