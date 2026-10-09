import type { LogEntry } from "@atrium/pi";
import type { Notice, TranscriptItem } from "@atrium/protocol";
import { TurnDraft, type TurnFacts } from "./turn-draft";

/** A rebuilt transcript, with which entry opened each turn. */
export interface Projection {
  readonly items: readonly TranscriptItem[];
  /** The user message entry that opened each turn, in order. */
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
 * running then (SPEC-0001, `steer`). Assistant messages add
 * their blocks as steps; a failed reply that pi took out of the context (an omission) is followed
 * by a retry step, numbered as pi counts: consecutive failures count up, a successful reply
 * resets, and an empty error reads as pi's "Unknown error". An omission followed straight by a
 * compaction is pi recovering from a context overflow, which is no retry (pi-internals.md §3).
 * Tool results pair with their calls by call id. A compaction becomes a notice after the turn it happened in, or in place between turns.
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
 * @returns The items and the entries that opened turns.
 */
export function projectTranscript(
  branch: readonly LogEntry[],
  sessionId: string,
  facts: ReadonlyMap<string, TurnFacts>,
  opened: ReadonlySet<string> = new Set(),
  auto: ReadonlySet<string> = new Set(),
): Projection {
  // Stryker disable next-line ConditionalExpression,ArrayDeclaration: only looked up by entry id, which is never undefined or made up.
  const omitted = new Set(branch.flatMap((entry) => (entry.kind === "omission" ? [entry.targetId] : [])));
  const recovered = overflowRecoveries(branch);
  const items: TranscriptItem[] = [];
  const turnEntryIds: string[] = [];
  let draft: { readonly turn: TurnDraft; readonly entryId: string } | null = null;
  let notices: Notice[] = [];
  let retries = 0;

  /**
   * Ends the turn being built, followed by the notices that happened in it.
   *
   * @remarks
   * A notice never splits a turn (SPEC-0001, "提示条").
   *
   * @sideEffects Updates the items.
   */
  const close = (): void => {
    if (draft !== null) items.push(draft.turn.finish(facts.get(draft.entryId)).turn);
    items.push(...notices);
    draft = null;
    notices = [];
  };

  for (const entry of branch) {
    switch (entry.kind) {
      case "user": {
        if (draft !== null && !facts.has(entry.id) && !opened.has(entry.id) && draft.turn.takesSteer) {
          draft.turn.steer(entry.text, entry.timestamp);
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
        draft?.turn.toolResult(entry.callId, entry, entry.timestamp);
        break;
      case "compaction": {
        const notice: Notice = {
          kind: "notice",
          id: historyId(sessionId, entry.id),
          notice: "compacted",
          tokensBefore: entry.tokensBefore,
          summary: entry.summary,
          timestamp: entry.timestamp,
        };
        // Before any turn, the next turn's start puts it in place all the same.
        notices.push(notice);
        break;
      }
      // Stryker disable next-line StringLiteral,ConditionalExpression: these cases do nothing, as no case does for other kinds.
      case "omission":
      // Stryker disable next-line StringLiteral,ConditionalExpression: see above.
      case "other":
        break;
    }
  }
  close();
  return { items, turnEntryIds };
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
