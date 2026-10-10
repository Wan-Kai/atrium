import type { LogEntry } from "@atrium/pi";

/**
 * The host's copy of a session's entries (domain-model §2).
 *
 * @remarks
 * Fed by `get_entries(since)`. The cursor (the last entry received) and the leaf (where the
 * current branch ends) are kept apart: pi can move the leaf without writing an entry.
 */
export interface SessionLog {
  /** The last entry received, to ask pi only for newer ones; `undefined` before any. */
  readonly cursor: string | undefined;
  /**
   * Adds entries pi returned and the leaf it reported.
   *
   * @returns The ids of entries not seen before.
   */
  append(entries: readonly LogEntry[], leafId: string | null): Set<string>;
  /** Forgets everything, before reading the session again from the start. */
  clear(): void;
  /** The current branch's entries, root first. */
  branch(): LogEntry[];
  /** Every entry, on any branch, in the order pi first gave them. */
  all(): LogEntry[];
}

/**
 * Creates an empty session log.
 *
 * @remarks
 * Entries arrive in file order. The branch is walked from the leaf pi reported through parent
 * ids, so other branches and entries not on the path are left out; a parent the log does not
 * hold ends the walk there, as does a cycle, which a well-formed file never has.
 *
 * @sideEffects none
 * @returns The log.
 */
export function createSessionLog(): SessionLog {
  const entries = new Map<string, LogEntry>();
  let cursor: string | undefined;
  let leafId: string | null = null;

  return {
    get cursor() {
      return cursor;
    },
    append(added, leaf) {
      const fresh = new Set<string>();
      for (const entry of added) {
        if (!entries.has(entry.id)) fresh.add(entry.id);
        entries.set(entry.id, entry);
        cursor = entry.id;
      }
      leafId = leaf;
      return fresh;
    },
    clear() {
      entries.clear();
      cursor = undefined;
      leafId = null;
    },
    branch() {
      const path: LogEntry[] = [];
      const seen = new Set<string>();
      let id = leafId;
      // Stryker disable next-line ConditionalExpression: there is no entry under `null`, which also ends the walk.
      while (id !== null && !seen.has(id)) {
        const entry = entries.get(id);
        if (entry === undefined) break;
        seen.add(id);
        path.push(entry);
        id = entry.parentId;
      }
      return path.toReversed();
    },
    all: () => [...entries.values()],
  };
}
