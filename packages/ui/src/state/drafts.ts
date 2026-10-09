import type { DraftText } from "../chat/composer-text";

/** The part of `localStorage` drafts use. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIX = "atrium-draft:";

/**
 * Whether a stored value is a pasted text.
 *
 * @remarks
 * See `isDraft`.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns Whether it is one.
 */
function isPaste(value: unknown): value is DraftText["pastes"][number] {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "text" in value &&
    typeof value.id === "string" &&
    typeof value.text === "string"
  );
}

/**
 * Whether a stored value is a draft.
 *
 * @remarks
 * Storage may hold anything a past version or a hand wrote; anything else reads as no draft.
 *
 * @sideEffects none
 * @param value - The parsed value.
 * @returns Whether it is a draft.
 */
function isDraft(value: unknown): value is DraftText {
  if (typeof value !== "object" || value === null) return false;
  if (!("text" in value) || !("pastes" in value) || !("files" in value)) return false;
  const { text, pastes, files } = value;
  return (
    typeof text === "string" &&
    Array.isArray(pastes) &&
    pastes.every(isPaste) &&
    Array.isArray(files) &&
    files.every((file: unknown) => typeof file === "string")
  );
}

/**
 * A session's saved draft.
 *
 * @remarks
 * Drafts are kept per session in the page's storage, so they outlive switching tabs and
 * restarting (SPEC-0001, "模型与输入框"). Images are not kept.
 *
 * @sideEffects Reads storage.
 * @param key - The session id, or `new:<container>` before the session exists.
 * @param storage - Where drafts are kept.
 * @returns The draft, or `null` for none.
 */
export function loadDraft(key: string, storage: DraftStorage = localStorage): DraftText | null {
  const stored = storage.getItem(PREFIX + key);
  if (stored === null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return isDraft(parsed) ? { text: parsed.text, pastes: parsed.pastes, files: parsed.files } : null;
  } catch {
    return null;
  }
}

/**
 * Keeps a session's draft, or forgets it once empty.
 *
 * @remarks
 * When storage is full the draft stays only in the page's memory (SPEC-0001, "模型与输入框").
 *
 * @sideEffects Writes or removes the entry in storage.
 * @param key - The session id, or `new:<container>`.
 * @param draft - What the box holds.
 * @param storage - Where drafts are kept.
 * @returns Whether it was kept.
 */
export function saveDraft(key: string, draft: DraftText, storage: DraftStorage = localStorage): boolean {
  if (draft.text === "" && draft.pastes.length === 0 && draft.files.length === 0) {
    storage.removeItem(PREFIX + key);
    return true;
  }
  try {
    storage.setItem(PREFIX + key, JSON.stringify({ text: draft.text, pastes: draft.pastes, files: draft.files }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Forgets the drafts of sessions that went away.
 *
 * @remarks
 * An archived or discarded session's draft would otherwise stay forever (SPEC-0001,
 * "模型与输入框").
 *
 * @sideEffects Removes entries from storage.
 * @param sessions - The ids of the sessions gone.
 * @param storage - Where drafts are kept.
 */
export function dropDrafts(sessions: Iterable<string>, storage: DraftStorage = localStorage): void {
  for (const id of sessions) storage.removeItem(PREFIX + id);
}
