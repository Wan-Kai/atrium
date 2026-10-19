import type { UsageReader } from "@atrium/pi";
import type { SessionMetrics, SessionSummary } from "@atrium/protocol";
import { ancestorsOf, descendantsOf } from "./child-tree";

/** What the totals read of a session. */
export type UsageEntry = Pick<SessionSummary, "sessionId" | "containerId" | "parent" | "archived" | "file"> & {
  readonly usageAfter: string | null;
};

/** Adds up what each session's child conversations produced (SPEC-0002, "用量合计"). */
export interface ChildrenUsage {
  /** Works out a session's totals again and gives them to `onTotals`. */
  refresh(sessionId: string): void;
  /** Works out again the totals of every session above this one, as once its file grew. */
  refreshAbove(sessionId: string): void;
  /** Resolves once every refresh asked for so far has given its totals. */
  settled(): Promise<void>;
  /** Forgets what was read of a file no session above counts any more, as a detached child's. */
  forget(file: string): void;
  /** Stops the reads under way and refreshes no more; resolves once they ended. */
  close(): Promise<void>;
}

/**
 * Creates the children's totals.
 *
 * @remarks
 * SPEC-0002 ("用量合计"): a session's figure is what all its descendants, archived ones too,
 * produced since they began, read from their files so a child whose pi is not running counts too, and
 * without the history a child copied (its `usageAfter`). A detached subtree no longer counts for
 * its old ancestors, since it is not below them any more. `null` for a session without such
 * descendants; a descendant whose file is not written yet adds nothing. Refreshes of one session
 * run one at a time, and one asked for meanwhile runs once after, so totals never go back to an
 * older read; a read that fails is only skipped. Tokens are whole, as the protocol counts them,
 * though a file's own may not be.
 *
 * @sideEffects none until a refresh; refreshes read files and call `onTotals`.
 * @param options - The sessions, the file reader, and where the totals go.
 * @returns The totals.
 */
export function createChildrenUsage(options: {
  readonly entries: () => readonly UsageEntry[];
  readonly reader: UsageReader;
  readonly onTotals: (sessionId: string, totals: SessionMetrics["children"]) => void;
}): ChildrenUsage {
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const stopping = new AbortController();

  /**
   * Adds up one session's descendants.
   *
   * @remarks
   * See `createChildrenUsage`.
   *
   * @sideEffects Reads files.
   * @param sessionId - The session.
   * @returns The totals.
   */
  async function totalsOf(sessionId: string): Promise<SessionMetrics["children"]> {
    // Archived ones spent what they spent; only a detached subtree is no longer below.
    const below = descendantsOf(options.entries(), sessionId);
    if (below.length === 0) return null;
    let tokens = 0;
    let cost = 0;
    for (const entry of below) {
      if (entry.file === null) continue;
      const usage = await options.reader.read(entry.file, entry.usageAfter, stopping.signal);
      tokens += usage?.tokens ?? 0;
      cost += usage?.cost ?? 0;
    }
    return { tokens: Math.min(Math.round(tokens), Number.MAX_SAFE_INTEGER), cost };
  }

  /**
   * Refreshes one session, or asks for one more refresh after the one under way.
   *
   * @remarks
   * See `createChildrenUsage`.
   *
   * @sideEffects Reads files; calls `onTotals`.
   * @param sessionId - The session.
   */
  function refresh(sessionId: string): void {
    if (stopping.signal.aborted) return;
    if (running.has(sessionId)) {
      again.add(sessionId);
      return;
    }
    const run = (async () => {
      do {
        again.delete(sessionId);
        try {
          options.onTotals(sessionId, await totalsOf(sessionId));
        } catch {
          // A file that could not be read keeps the totals as they were.
        }
      } while (again.has(sessionId));
    })().finally(() => {
      running.delete(sessionId);
      // One asked for between the last look and now runs too.
      if (again.delete(sessionId)) refresh(sessionId);
    });
    running.set(sessionId, run);
  }

  return {
    refresh,
    refreshAbove(sessionId) {
      for (const ancestor of ancestorsOf(options.entries(), sessionId)) refresh(ancestor);
    },
    async settled() {
      while (running.size > 0) await Promise.all(running.values());
    },
    forget(file) {
      options.reader.forget(file);
    },
    async close() {
      stopping.abort();
      while (running.size > 0) await Promise.all(running.values());
    },
  };
}
