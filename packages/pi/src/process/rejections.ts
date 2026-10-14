/** pi's error texts when it takes no new message right now (pi 1.0.2, `agent-session.js`). */
const BUSY_TEXTS = ["Agent is already processing", "Cannot submit a prompt while compaction is in progress"];

/**
 * Whether pi refused a prompt because it is busy, not because something is wrong.
 *
 * @remarks
 * pi answers a prompt sent during a run or a compaction with an error rather than a status, so
 * its text is the only signal. Knowing pi's wording belongs in the pi package (domain-model §6,
 * PiIntegration); the host only maps the answer to an error code.
 *
 * @sideEffects none
 * @param detail - pi's error text.
 * @returns Whether it means "busy, try later".
 */
export function isBusyRejection(detail: string): boolean {
  return BUSY_TEXTS.some((text) => detail.startsWith(text));
}

/** Why pi had nothing to compact, by the start of its error text (pi 1.0.2, `agent-session.js`). */
const COMPACT_TEXTS = [
  ["Nothing to compact", "nothing_to_compact"],
  ["Already compacted", "already_compacted"],
] as const;

/**
 * Why pi refused a manual compaction, when it is one Atrium tells apart.
 *
 * @remarks
 * pi's `compact` throws "Nothing to compact (session too small)" when too little would go, and
 * "Already compacted" when the branch ends in a compaction; both are answers, not faults
 * (SPEC-0001, "M1.11 的 `/` 命令 · 压缩"). Any other text is a failure the host does not tell
 * apart.
 *
 * @sideEffects none
 * @param detail - pi's error text.
 * @returns The error code for it, or `null`.
 */
export function compactRejection(detail: string): "nothing_to_compact" | "already_compacted" | null {
  return COMPACT_TEXTS.find(([text]) => detail.startsWith(text))?.[1] ?? null;
}
