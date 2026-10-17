import type { SessionSummary } from "@atrium/protocol";

/** What the tree rules read of a session. */
export type TreeEntry = Pick<SessionSummary, "sessionId" | "containerId" | "parent" | "archived">;

/**
 * A session's child conversations, in the order the entries list them.
 *
 * @remarks
 * Archived children included; the caller filters what it shows.
 *
 * @sideEffects none
 * @param entries - Every session.
 * @param sessionId - The parent.
 * @returns Its children.
 */
export function childrenOf<E extends TreeEntry>(entries: readonly E[], sessionId: string): E[] {
  return entries.filter((entry) => entry.parent?.sessionId === sessionId);
}

/**
 * A session's descendants: its children, theirs, and so on, each once.
 *
 * @remarks
 * A chain of parents that loops back, as a hand-edited index could make, stops where it comes
 * back to the ancestor, the only place it can, as each session has one parent (SPEC-0002,
 * "概念 · 层数"); the session itself is never its own descendant.
 *
 * @sideEffects none
 * @param entries - Every session.
 * @param sessionId - The ancestor.
 * @returns The descendants, parents before their children.
 */
export function descendantsOf<E extends TreeEntry>(entries: readonly E[], sessionId: string): E[] {
  const found: E[] = [];
  const queue = [sessionId];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of childrenOf(entries, next)) {
      // Each session has one parent, so only a loop back to the ancestor comes round again.
      if (child.sessionId === sessionId) continue;
      found.push(child);
      queue.push(child.sessionId);
    }
  }
  return found;
}

/**
 * A session's ancestors: its parent, the parent's parent, and so on.
 *
 * @remarks
 * A loop is treated as a break where it closes (SPEC-0002, "概念 · 层数"); a parent the entries do
 * not list ends the chain too.
 *
 * @sideEffects none
 * @param entries - Every session.
 * @param sessionId - The descendant.
 * @returns The ancestors' ids, nearest first.
 */
export function ancestorsOf(entries: readonly TreeEntry[], sessionId: string): string[] {
  const byId = new Map(entries.map((entry) => [entry.sessionId, entry]));
  const seen = new Set([sessionId]);
  const found: string[] = [];
  for (let parent = byId.get(sessionId)?.parent?.sessionId; parent !== undefined && !seen.has(parent);) {
    const entry = byId.get(parent);
    if (entry === undefined) break;
    seen.add(parent);
    found.push(parent);
    parent = entry.parent?.sessionId;
  }
  return found;
}

/** What archiving some sessions does to their descendants. */
export interface ArchivePlan {
  /** Descendants archived with them: those in the same container, below others in it. */
  readonly archive: readonly string[];
  /** Descendants in another container, detached instead; what is below them stays theirs. */
  readonly detach: readonly string[];
}

/**
 * Works out what archiving sessions of one container does to the sessions below them.
 *
 * @remarks
 * SPEC-0002 ("归档、脱离、交接"): from each archived session down, its descendants in the same
 * container, drafts too, are archived with it; a branch in another container is detached instead,
 * and the relations below it stay. Sessions archived already are not listed but gone through,
 * as an archiving cut short can leave one with live sessions below; those being archived
 * (`roots`) are not listed again.
 *
 * @sideEffects none
 * @param entries - Every session.
 * @param roots - The sessions being archived, all of `containerId`.
 * @param containerId - Their container.
 * @returns What to archive and what to detach.
 */
export function archivePlan(entries: readonly TreeEntry[], roots: readonly string[], containerId: string): ArchivePlan {
  const seen = new Set(roots);
  const archive: string[] = [];
  const detach: string[] = [];
  const queue = [...roots];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of childrenOf(entries, next)) {
      if (seen.has(child.sessionId)) continue;
      seen.add(child.sessionId);
      if (child.containerId === containerId) {
        // One archived already is gone through: what is still below it goes too.
        if (!child.archived) archive.push(child.sessionId);
        queue.push(child.sessionId);
      } else if (!child.archived) {
        detach.push(child.sessionId);
      }
    }
  }
  return { archive, detach };
}
