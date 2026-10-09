import type { TranscriptItem } from "@atrium/protocol";

/** One file the session changed, as "本会话改动" lists it. */
interface SessionFileChange {
  readonly path: string;
  /** Lines added and removed by every edit, summed. */
  readonly added: number;
  readonly removed: number;
  /** Whether a write touched it, which has no line counts. */
  readonly written: boolean;
  /** The last turn that changed it, which a click goes to. */
  readonly turnId: string;
}

/** What "本会话改动" shows. */
export interface SessionChanges {
  readonly added: number;
  readonly removed: number;
  /** In the order first changed. */
  readonly files: readonly SessionFileChange[];
}

/**
 * Adds up the files the session's turns changed.
 *
 * @remarks
 * The same measure as each turn's summary (SPEC-0001, "每轮改动汇总"): edits and writes the tools
 * made, edits summed as edited, not net, a write counted without lines. Only the turns loaded
 * count.
 *
 * @sideEffects none
 * @param items - The transcript, oldest first.
 * @returns The totals and the files.
 */
export function sessionChanges(items: readonly TranscriptItem[]): SessionChanges {
  const files = new Map<string, SessionFileChange>();
  for (const item of items) {
    if (item.kind !== "turn") continue;
    for (const change of item.changes) {
      const before = files.get(change.path);
      files.set(change.path, {
        path: change.path,
        added: (before?.added ?? 0) + (change.added ?? 0),
        removed: (before?.removed ?? 0) + (change.removed ?? 0),
        written: (before?.written ?? false) || change.added === null,
        turnId: item.id,
      });
    }
  }
  const all = [...files.values()];
  return {
    added: all.reduce((sum, file) => sum + file.added, 0),
    removed: all.reduce((sum, file) => sum + file.removed, 0),
    files: all,
  };
}
