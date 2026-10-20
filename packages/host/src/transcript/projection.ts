import { type LogEntry, agentSource } from "@atrium/pi";
import type { Notice, TranscriptItem } from "@atrium/protocol";
import { inputTokens } from "./rules";
import { type CompactionStep, TurnDraft, type TurnFacts, messageCommand, noUser, steerText } from "./turn-draft";

/** A compaction entry. */
type CompactionEntry = Extract<LogEntry, { kind: "compaction" }>;

/** What set off a compaction the host saw during a run; `null` when it was not told. */
export type SeenCompaction = CompactionStep["reason"];

/** A rebuilt transcript, with which entry opened each turn. */
export interface Projection {
  readonly items: readonly TranscriptItem[];
  /** The user message, notice or task entry that opened each turn, in order. */
  readonly turnEntryIds: readonly string[];
}

/**
 * The id of an item that only history knows: the session id and the entry id.
 *
 * @remarks
 * Entry ids are only unique within a file (domain-model §2).
 *
 * @sideEffects none
 * @param sessionId - The session's id.
 * @param entryId - The entry's id.
 * @returns The id.
 */
function historyId(sessionId: string, entryId: string): string {
  return `${sessionId}:${entryId}`;
}

/**
 * Builds the transcript of a session's current branch from its entries (domain-model §2).
 *
 * @remarks
 * A user message the host saw open a turn opens one (`facts` from this host run, `opened` from
 * earlier ones); pi's file does not say, so any other
 * opens a turn unless it directly follows a tool result, which makes it a steer in the turn
 * running then (SPEC-0001, `steer`). Atrium's notices and tasks go by the same rule: a turn of their
 * own with them as its source, or a step (SPEC-0002, "对话记录里的自定义消息"). Assistant messages add
 * their blocks as steps; a failed reply that pi took out of the context (an omission) is followed
 * by a retry step, numbered as pi counts: consecutive failures count up, a successful reply
 * resets, and an empty error reads as pi's "Unknown error". An omission followed straight by a
 * compaction is pi recovering from a context overflow, which is no retry (pi-internals.md §3).
 * Tool results pair with their calls by call id. A compaction is a step where it happened when
 * the turn goes on after it, its first step if it came right after the user message; one right
 * before the next turn is a notice between the two, unless the host saw it during this turn's run
 * (`compactions`), which makes it the turn's last step; one before any turn is a notice in place
 * (SPEC-0001, `compaction`). Either way it has the input of the first later reply that says one.
 * Model changes, labels, system messages and other entries are skipped. Assistant messages before
 * any user message belong to no turn and are skipped too. A turn the host saw live gets the id,
 * `clientMessageId`, timings and whether the host sent it on its own that it had then, from
 * `facts`; one an earlier host run sent on its own is marked from `auto`.
 *
 * @sideEffects none
 * @param branch - The branch's entries, root first.
 * @param sessionId - The session's id, for history-only ids.
 * @param facts - What the host measured of turns it saw live, by the id of the entry opening them.
 * @param opened - Entries an earlier host run saw open a turn; nothing was measured of them then
 * that survived.
 * @param auto - Entries of messages an earlier host run sent on its own (SPEC-0001, "运行控制").
 * @param compactions - Compaction entries the host saw during a run, with what set each off.
 * @returns The items and the entries that opened turns.
 */
export function projectTranscript(
  branch: readonly LogEntry[],
  sessionId: string,
  facts: ReadonlyMap<string, TurnFacts>,
  opened: ReadonlySet<string> = new Set(),
  auto: ReadonlySet<string> = new Set(),
  compactions: ReadonlyMap<string, SeenCompaction> = new Map(),
): Projection {
  // Stryker disable next-line ConditionalExpression,ArrayDeclaration: only looked up by entry id, which is never undefined or made up.
  const omitted = new Set(branch.flatMap((entry) => (entry.kind === "omission" ? [entry.targetId] : [])));
  const recovered = overflowRecoveries(branch);
  const after = inputsAfter(branch);
  const items: TranscriptItem[] = [];
  const turnEntryIds: string[] = [];
  let draft: { readonly turn: TurnDraft; readonly entryId: string } | null = null;
  /** What follows the turn so far: notices, and compactions nothing of the turn came after yet. */
  let notices: (Notice | CompactionEntry)[] = [];
  let retries = 0;

  /**
   * Makes a compaction a step of the turn being built.
   *
   * @remarks
   * See `projectTranscript`.
   *
   * @sideEffects Updates the turn.
   * @param turn - The turn.
   * @param entry - The compaction.
   */
  const step = (turn: TurnDraft, entry: CompactionEntry): void => {
    turn.compaction(
      {
        tokensBefore: entry.tokensBefore,
        tokensAfter: after.get(entry.id) ?? null,
        summary: entry.summary,
        reason: compactions.get(entry.id) ?? null,
      },
      entry.timestamp,
    );
  };

  /**
   * Makes the compactions waiting after the turn its steps, since the turn goes on after them.
   *
   * @remarks
   * See `projectTranscript`.
   *
   * @sideEffects Updates the turn and what follows it.
   * @param turn - The turn.
   */
  const goOn = (turn: TurnDraft): void => {
    for (const waiting of notices) if (waiting.kind === "compaction") step(turn, waiting);
    notices = notices.filter((waiting) => waiting.kind !== "compaction");
  };

  /**
   * Ends the turn being built, followed by the notices that happened in it.
   *
   * @remarks
   * A notice never splits a turn (SPEC-0001, "提示条"). A compaction still waiting is the turn's
   * last step if the host saw it in the run, and a notice between the turns otherwise.
   *
   * @sideEffects Updates the items.
   */
  const close = (): void => {
    const turn = draft?.turn;
    const following: Notice[] = [];
    for (const waiting of notices) {
      if (waiting.kind === "notice") following.push(waiting);
      else if (turn !== undefined && compactions.has(waiting.id)) step(turn, waiting);
      else following.push(compactedNotice(waiting, sessionId, after.get(waiting.id) ?? null));
    }
    if (draft !== null) items.push(draft.turn.finish(facts.get(draft.entryId)).turn);
    items.push(...following);
    draft = null;
    notices = [];
  };

  for (const entry of branch) {
    switch (entry.kind) {
      case "user": {
        if (draft !== null && !facts.has(entry.id) && !opened.has(entry.id) && draft.turn.takesSteer) {
          goOn(draft.turn);
          draft.turn.steer(steerText(entry), entry.timestamp);
          break;
        }
        close();
        const known = facts.get(entry.id);
        draft = {
          turn: new TurnDraft(
            known?.turnId ?? historyId(sessionId, entry.id),
            {
              text: entry.text,
              images: entry.images,
              clientMessageId: known?.clientMessageId ?? null,
              auto: known?.auto ?? auto.has(entry.id),
              command: messageCommand(entry),
              timestamp: entry.timestamp,
            },
            known?.retryLimit ?? null,
          ),
          entryId: entry.id,
        };
        turnEntryIds.push(entry.id);
        retries = 0;
        break;
      }
      case "assistant":
        if (draft === null) break;
        goOn(draft.turn);
        draft.turn.startAssistant();
        draft.turn.finishAssistant(entry);
        if (entry.stopReason !== "error") retries = 0;
        else if (omitted.has(entry.id) && !recovered.has(entry.id)) {
          retries += 1;
          draft.turn.retry(
            retries,
            entry.errorMessage === null || entry.errorMessage === "" ? "Unknown error" : entry.errorMessage,
          );
        }
        break;
      case "toolResult":
        // pi compacts between requests, never between a call and its result.
        draft?.turn.toolResult(entry.callId, entry, entry.timestamp);
        break;
      case "compaction":
        // Where it goes is known once what follows it is; before any turn, the next turn's start
        // puts it in place as a notice.
        notices.push(entry);
        break;
      case "agent": {
        // Notices or a task: a step where a steer would be, a turn of their own otherwise (SPEC-0002).
        const source = agentSource(entry.details);
        if (source === null) break;
        if (draft !== null && !facts.has(entry.id) && !opened.has(entry.id) && draft.turn.takesSteer) {
          goOn(draft.turn);
          draft.turn.delivered(source, entry.timestamp);
          break;
        }
        close();
        const known = facts.get(entry.id);
        draft = {
          turn: new TurnDraft(
            known?.turnId ?? historyId(sessionId, entry.id),
            noUser(entry.timestamp),
            known?.retryLimit ?? null,
            source,
          ),
          entryId: entry.id,
        };
        turnEntryIds.push(entry.id);
        retries = 0;
        break;
      }
      case "note":
        // The host's note to the model is a line of its own, not a turn (SPEC-0002, "对话记录里的自定义消息").
        notices.push({
          kind: "notice",
          id: historyId(sessionId, entry.id),
          notice: "note",
          ...entry.note,
          timestamp: entry.timestamp,
        });
        break;
      // Stryker disable next-line StringLiteral,ConditionalExpression: these cases do nothing, as no case does for other kinds.
      case "omission":
      // Stryker disable next-line StringLiteral,ConditionalExpression: see above.
      case "system":
      // Stryker disable next-line StringLiteral,ConditionalExpression: see above.
      case "other":
        break;
    }
  }
  close();
  return { items, turnEntryIds };
}

/**
 * A compaction between turns, as a notice.
 *
 * @remarks
 * See `projectTranscript`.
 *
 * @sideEffects none
 * @param entry - The compaction.
 * @param sessionId - The session's id, for its id.
 * @param tokensAfter - The input of the first later reply that says one.
 * @returns The notice.
 */
function compactedNotice(entry: CompactionEntry, sessionId: string, tokensAfter: number | null): Notice {
  return {
    kind: "notice",
    id: historyId(sessionId, entry.id),
    notice: "compacted",
    tokensBefore: entry.tokensBefore,
    tokensAfter,
    summary: entry.summary,
    timestamp: entry.timestamp,
  };
}

/**
 * The context after each compaction: the input of the first later reply that says one.
 *
 * @remarks
 * SPEC-0001, `compaction`: the same rule live, where the step is updated once that reply comes.
 *
 * @sideEffects none
 * @param branch - The branch's entries, root first.
 * @returns The tokens by compaction entry id; none for a compaction no reply followed yet.
 */
function inputsAfter(branch: readonly LogEntry[]): Map<string, number> {
  const after = new Map<string, number>();
  let next: number | null = null;
  for (const entry of branch.toReversed()) {
    if (entry.kind === "assistant") next = inputTokens(entry.usage) ?? next;
    // Stryker disable next-line ConditionalExpression,LogicalOperator: only compactions are looked up, and one with no tokens after reads as null either way.
    else if (entry.kind === "compaction" && next !== null) after.set(entry.id, next);
  }
  return after;
}

/**
 * The replies pi took out of the context to recover from an overflow.
 *
 * @remarks
 * pi writes the omissions of the failed reply and its tool results, then at once the compaction,
 * then retries without a retry event (pi-internals.md §3); a retry's omission is followed by the
 * retried reply instead.
 *
 * @sideEffects none
 * @param branch - The branch's entries, root first.
 * @returns The ids of the replies omitted before a compaction.
 */
function overflowRecoveries(branch: readonly LogEntry[]): Set<string> {
  const recovered = new Set<string>();
  branch.forEach((entry, index) => {
    // Stryker disable next-line ConditionalExpression: other entries have no target, and no reply has an undefined id.
    if (entry.kind !== "omission") return;
    const next = branch.slice(index + 1).find((later) => later.kind !== "omission" && later.kind !== "other");
    if (next?.kind === "compaction") recovered.add(entry.targetId);
  });
  return recovered;
}
