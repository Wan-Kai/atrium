import { type IndexFile, loadIndexFile } from "./index-file";
import { type TurnStartsDocument, turnStartsFile } from "./index-schema";

/** The user message entries a session's host saw open a turn. */
export interface TurnStarts {
  readonly opened: ReadonlySet<string>;
  /** Adds entries and writes them. */
  record(entryIds: readonly string[]): Promise<void>;
}

/** pi's rule for session ids (pi-internals.md §1), which also keeps them safe as file names. */
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Loads a session's turn starts from `turns/<session id>.json`.
 *
 * @remarks
 * A session id that is not pi's own shape (a hand-made file) cannot name a file safely; its
 * starts are kept in memory only. A damaged file starts empty (domain-model §1, "索引的存储"):
 * the rebuild then falls back to telling steers by their position.
 *
 * @sideEffects Reads the file; may set aside a damaged one.
 * @param home - Atrium's home.
 * @param sessionId - The session.
 * @param now - The time, for naming a damaged file's copy.
 * @returns The starts, and where a damaged file went.
 * @throws {IndexTooNewError} When a newer Atrium wrote the file.
 */
export async function loadTurnStarts(
  home: string,
  sessionId: string,
  now: number,
): Promise<{ readonly starts: TurnStarts; readonly setAside: string | null }> {
  if (!SAFE_ID.test(sessionId)) return { starts: inMemory(new Set()), setAside: null };
  const { file, setAside } = await loadIndexFile(home, turnStartsFile(sessionId), now);
  return { starts: onFile(file), setAside };
}

/**
 * Turn starts kept only in memory.
 *
 * @remarks
 * See `loadTurnStarts`.
 *
 * @sideEffects none
 * @param opened - The starts.
 * @returns The starts.
 */
function inMemory(opened: Set<string>): TurnStarts {
  return {
    opened,
    async record(entryIds) {
      for (const id of entryIds) opened.add(id);
    },
  };
}

/**
 * Turn starts backed by their file.
 *
 * @remarks
 * Each new entry is added once; nothing is written when nothing is new.
 *
 * @sideEffects none until `record`; then writes the file.
 * @param file - The loaded file.
 * @returns The starts.
 */
function onFile(file: IndexFile<TurnStartsDocument>): TurnStarts {
  const opened = new Set(file.read().entries);
  return {
    opened,
    async record(entryIds) {
      const added = entryIds.filter((id) => !opened.has(id));
      if (added.length === 0) return;
      for (const id of added) opened.add(id);
      await file.save({ ...file.read(), entries: [...opened] });
    },
  };
}
