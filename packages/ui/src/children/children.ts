import type { SessionSummary } from "@atrium/protocol";
import { type RowStatus, sessionStatus, topStatus } from "../sidebar/status";

/** What the child rules read of a session. */
export type TreeSession = Pick<
  SessionSummary,
  "sessionId" | "parent" | "archived" | "updatedAt" | "asking" | "attention" | "running"
>;

/**
 * A session's child conversations not archived, the most recently updated first.
 *
 * @remarks
 * SPEC-0002 ("显示 · 子对话条"): only direct children are listed, archived ones never; the order
 * puts the child that moved last first, as the summaries carry no creation time.
 *
 * @sideEffects none
 * @param sessions - Every session.
 * @param sessionId - The parent.
 * @returns Its children.
 */
export function childrenOf<S extends TreeSession>(sessions: readonly S[], sessionId: string): S[] {
  return (
    sessions
      // A session named its own parent, as a hand-edited index could, is not its own child.
      .filter(
        (session) => session.parent?.sessionId === sessionId && session.sessionId !== sessionId && !session.archived,
      )
      .toSorted((a, b) => b.updatedAt - a.updatedAt)
  );
}

/**
 * A session's descendants not archived: its children, theirs, and so on, each once.
 *
 * @remarks
 * A chain of parents that loops back, as a hand-edited index could make, stops where it comes
 * back to the ancestor (SPEC-0002, "概念 · 层数").
 *
 * @sideEffects none
 * @param sessions - Every session.
 * @param sessionId - The ancestor.
 * @returns The descendants.
 */
export function descendantsOf<S extends TreeSession>(sessions: readonly S[], sessionId: string): S[] {
  const found: S[] = [];
  const queue = [sessionId];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of childrenOf(sessions, next)) {
      // Each session has one parent, so only a loop back to the ancestor comes round again.
      if (child.sessionId === sessionId) continue;
      found.push(child);
      queue.push(child.sessionId);
    }
  }
  return found;
}

/**
 * A child row's status: the highest of its own and its whole subtree's, running included.
 *
 * @remarks
 * SPEC-0002 ("显示 · 子对话条"): a row stands for the child and everything below it.
 *
 * @sideEffects none
 * @param sessions - Every session.
 * @param session - The child.
 * @returns The status.
 */
export function rowStatus(sessions: readonly TreeSession[], session: TreeSession): RowStatus {
  return topStatus([session, ...descendantsOf(sessions, session.sessionId)].map(sessionStatus));
}

/**
 * A session's tab status: its own, raised by a descendant waiting for an answer, a sign-in or a look.
 *
 * @remarks
 * SPEC-0002 ("显示 · 主对话标签的状态图标"): a child running does not raise it; that shows only in
 * the child bar.
 *
 * @sideEffects none
 * @param sessions - Every session.
 * @param session - The session.
 * @returns The status.
 */
export function tabStatus(sessions: readonly TreeSession[], session: TreeSession): RowStatus {
  const below = descendantsOf(sessions, session.sessionId)
    .map(sessionStatus)
    .filter((status) => status !== "running");
  return topStatus([sessionStatus(session), ...below]);
}

/**
 * The chain from a session's top ancestor down to it, for its breadcrumb.
 *
 * @remarks
 * A loop is treated as a break where it closes, and a parent not listed (archived and gone, or
 * not known yet) ends the chain (SPEC-0002, "概念 · 层数").
 *
 * @sideEffects none
 * @param sessions - Every session.
 * @param sessionId - The session.
 * @returns The sessions, top first, the session last; empty for one not listed.
 */
export function chainOf<S extends Pick<SessionSummary, "sessionId" | "parent">>(
  sessions: readonly S[],
  sessionId: string,
): S[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const chain: S[] = [];
  const seen = new Set<string>();
  for (let next = byId.get(sessionId); next !== undefined && !seen.has(next.sessionId);) {
    seen.add(next.sessionId);
    chain.unshift(next);
    next = next.parent === null ? undefined : byId.get(next.parent.sessionId);
  }
  return chain;
}

/** A breadcrumb's part: a session, or the levels folded into "…". */
export type Crumb<S> = { readonly session: S } | { readonly folded: readonly S[] };

/**
 * A breadcrumb's parts, with the middle levels folded once there are more than three.
 *
 * @remarks
 * "根对话 › … › 父对话 › 当前" (SPEC-0002, "显示 · 子对话的标签").
 *
 * @sideEffects none
 * @param chain - The chain, top first.
 * @returns The parts.
 */
export function crumbsOf<S>(chain: readonly S[]): Crumb<S>[] {
  const whole = chain.map((session) => ({ session }));
  if (chain.length <= 3) return whole;
  return [...whole.slice(0, 1), { folded: chain.slice(1, -2) }, ...whole.slice(-2)];
}
