import type { SessionSnapshotEvent, SnapshotBudget, TranscriptItem } from "@atrium/protocol";

/**
 * Cuts a snapshot down to a phone's budget.
 *
 * @remarks
 * A budget is never larger than the default snapshot (`SNAPSHOT_TURNS` turns, `PAGE_BYTES`), so
 * cutting the default snapshot's items gives what cutting the whole transcript would: the same
 * rule, taking from the end until the turns are counted or the next item would pass the bytes, at
 * least one item (SPEC-0005, "MP4a 定的细节"). Items travel already shaped for transport, so their
 * encoded size here is the one the transcript counted. Without a budget, or when everything fits,
 * the snapshot comes back as it is.
 *
 * @sideEffects none
 * @param snapshot - The default snapshot.
 * @param budget - The connection's budget; `undefined` for the default.
 * @returns The snapshot, with fewer items when the budget asks for it.
 */
export function withinBudget(snapshot: SessionSnapshotEvent, budget: SnapshotBudget | undefined): SessionSnapshotEvent {
  if (budget === undefined) return snapshot;
  const taken: TranscriptItem[] = [];
  let turns = 0;
  let bytes = 0;
  for (const item of snapshot.items.toReversed()) {
    if (turns >= budget.turns) break;
    // Stryker disable next-line StringLiteral: an empty encoding is UTF-8.
    const size = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (taken.length > 0 && bytes + size > budget.bytes) break;
    taken.unshift(item);
    bytes += size;
    if (item.kind === "turn") turns += 1;
  }
  if (taken.length === snapshot.items.length) return snapshot;
  return { ...snapshot, items: taken, hasOlder: true };
}
