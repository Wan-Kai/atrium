import type { SessionSummary } from "@atrium/protocol";

/** The status a row shows; `null` for idle, which shows nothing. */
export type RowStatus = "asking" | "auth" | "error" | "running" | null;

/** Statuses from the highest down (SPEC-0001, "会话状态"). */
const PRIORITY: readonly Exclude<RowStatus, null>[] = ["asking", "auth", "error", "running"];

/** How many sessions the inbox shows before "还有 N 条". */
export const INBOX_SHOWN = 3;

/**
 * A session's status for its row.
 *
 * @remarks
 * Highest first (SPEC-0001, "会话状态"): a question waiting, then a sign-in problem, then an
 * error, which stays until the next run starts even once seen and while the session runs again.
 *
 * @sideEffects none
 * @param session - The session.
 * @returns Its status.
 */
export function sessionStatus(session: Pick<SessionSummary, "asking" | "attention" | "running">): RowStatus {
  if (session.asking !== null) return "asking";
  if (session.attention !== null) return session.attention.reason;
  return session.running ? "running" : null;
}

/**
 * The highest of several statuses, for a workspace or project row.
 *
 * @remarks
 * See `sessionStatus`.
 *
 * @sideEffects none
 * @param statuses - Its sessions' statuses.
 * @returns The highest.
 */
export function topStatus(statuses: readonly RowStatus[]): RowStatus {
  return PRIORITY.find((status) => statuses.includes(status)) ?? null;
}

/** A session in the inbox. */
export interface InboxEntry {
  readonly session: SessionSummary;
  readonly status: "asking" | "auth" | "error";
  /** Since when: the question's or the attention's time. */
  readonly at: number;
}

/**
 * The sessions that need the user, for the inbox.
 *
 * @remarks
 * SPEC-0001 ("收件箱"): sessions not archived that wait for an answer or a sign-in, or have an
 * error not seen yet; by priority, then newest first.
 *
 * @sideEffects none
 * @param sessions - Every session.
 * @returns The inbox, in order.
 */
export function inboxOf(sessions: readonly SessionSummary[]): InboxEntry[] {
  const entries: InboxEntry[] = [];
  for (const session of sessions) {
    if (session.archived) continue;
    if (session.asking !== null) entries.push({ session, status: "asking", at: session.asking });
    else if (session.attention !== null && !(session.attention.reason === "error" && session.attention.cleared)) {
      entries.push({ session, status: session.attention.reason, at: session.attention.at });
    }
  }
  return entries.toSorted((a, b) => PRIORITY.indexOf(a.status) - PRIORITY.indexOf(b.status) || b.at - a.at);
}
