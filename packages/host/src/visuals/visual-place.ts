import { join } from "node:path";

/** pi's rule for session ids (pi-internals.md §1), which also keeps them safe as one path part. */
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

/**
 * Where an ordinary session's visuals go: `visuals/<session id>/` in Atrium's home.
 *
 * @remarks
 * SPEC-0007 ("一个演示 = 一个文件"): not in the workspace, so the repository stays clean. A
 * container with its own place for visuals, as a study direction's `visuals/` (SPEC-0008), gives
 * it instead; this is the default. A session id that is not pi's own shape cannot name a folder
 * safely, so such a session has none.
 *
 * @sideEffects none
 * @param home - Atrium's home.
 * @param sessionId - The session.
 * @returns The directory, or `null`.
 */
export function defaultVisualsDir(home: string, sessionId: string): string | null {
  return SAFE_ID.test(sessionId) ? join(home, "visuals", sessionId) : null;
}

/** The most sessions up a line a fork or child may read visuals from; any real line is shorter. */
const MOST_ANCESTORS = 64;

/**
 * The sessions a session came from, nearest first: its parent, or the one it was detached from,
 * and theirs.
 *
 * @remarks
 * SPEC-0007, MV1 details (2026-11-06): a fork or child carries history that names its ancestors'
 * visuals, so it may read their directories. A loop in hand-edited records is walked once; an
 * ancestor no longer recorded ends the line after it.
 *
 * @sideEffects none
 * @param sessionId - The session.
 * @param find - A session's parent and the parent it was detached from, if it is recorded.
 * @returns Its ancestors' ids.
 */
export function ancestorsOf(
  sessionId: string,
  find: (
    sessionId: string,
  ) => { readonly parent: string | null; readonly detachedFrom?: string | undefined } | undefined,
): string[] {
  const seen = new Set([sessionId]);
  const line: string[] = [];
  for (let at = find(sessionId); at !== undefined && line.length < MOST_ANCESTORS;) {
    const up = at.parent ?? at.detachedFrom;
    if (up === undefined || seen.has(up)) break;
    seen.add(up);
    line.push(up);
    at = find(up);
  }
  return line;
}

/**
 * Where a session's visuals may be: its working directory, its own directory for visuals, and its
 * ancestors' directories, nearest first.
 *
 * @remarks
 * SPEC-0007, MV1 details: new visuals go to the session's own directory; the ancestors' are read
 * only. A session not recorded, or with no directory of its own, has none; an ancestor without one
 * is skipped.
 *
 * @sideEffects none
 * @param sessionId - The session.
 * @param find - A session's working directory and lineage, if it is recorded.
 * @param dirOf - A session's own directory for visuals, or `null`.
 * @returns The place, or `undefined`.
 */
export function visualPlaceOf(
  sessionId: string,
  find: (
    sessionId: string,
  ) => { readonly cwd: string; readonly parent: string | null; readonly detachedFrom?: string | undefined } | undefined,
  dirOf: (sessionId: string) => string | null,
): { readonly cwd: string; readonly dir: string; readonly ancestors: readonly string[] } | undefined {
  const cwd = find(sessionId)?.cwd;
  const dir = dirOf(sessionId);
  if (cwd === undefined || dir === null) return undefined;
  const ancestors = ancestorsOf(sessionId, find)
    .map((id) => dirOf(id))
    .filter((up) => up !== null);
  return { cwd, dir, ancestors };
}
