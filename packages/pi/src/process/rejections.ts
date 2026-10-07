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
