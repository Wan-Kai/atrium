import { useCallback, useSyncExternalStore } from "react";
import type { DraftText } from "../chat/composer-text";
import type { CompressedImage } from "../chat/images";

/** An image in a session's box; `image` is `null` while it is compressed, `attachmentId` while it uploads. */
export interface KeptImage {
  readonly id: string;
  readonly image: CompressedImage | null;
  readonly attachmentId: string | null;
}

/** What a session's box holds: the text, the capsules and the images. */
export interface Draft extends DraftText {
  readonly images: readonly KeptImage[];
}

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

/** Every session's draft, kept in the page's memory and mirrored into storage. */
export interface Drafts {
  /** The draft under a key; the same object until it changes. */
  read(key: string): Draft;
  /** Changes the draft under a key. */
  update(key: string, change: (draft: Draft) => Draft): void;
  /** Hears each change of the draft under a key; returns how to stop. */
  subscribe(key: string, listener: () => void): () => void;
  /** Changes an image in whichever draft holds it; `null` takes it off. */
  updateImage(id: string, change: (image: KeptImage) => KeptImage | null): void;
  /** Moves a draft to another key, as the empty state's goes to the session it created. */
  handOver(from: string, to: string): void;
  /** Puts a message that did not go back into its draft, when the draft is empty. */
  restore(key: string, text: string, images: readonly KeptImage[]): void;
  /** Forgets drafts, images too. */
  drop(keys: Iterable<string>): void;
}

const EMPTY: Draft = { text: "", pastes: [], files: [], images: [] };

/** One draft, and what storage held when it was read or written. */
interface Entry {
  readonly draft: Draft;
  /** The stored text the draft was read from or written as; `null` for none. */
  readonly stored: string | null;
  /** Storage could not take the draft, so memory has the only copy. */
  readonly unsaved: boolean;
}

/**
 * Whether a draft holds nothing.
 *
 * @remarks
 * Only such a draft takes a message that did not go back.
 *
 * @sideEffects none
 * @param draft - The draft.
 * @returns Whether it is empty.
 */
function isEmpty(draft: Draft): boolean {
  return draft.text === "" && draft.pastes.length === 0 && draft.files.length === 0 && draft.images.length === 0;
}

/**
 * The draft stored as this text, without images.
 *
 * @remarks
 * Anything a past version or a hand wrote that is not a draft reads as an empty one.
 *
 * @sideEffects none
 * @param stored - What storage holds, or `null`.
 * @returns The draft's text and capsules.
 */
function parseStored(stored: string | null): DraftText {
  if (stored === null) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(stored);
    return isDraft(parsed) ? { text: parsed.text, pastes: parsed.pastes, files: parsed.files } : EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * Creates the drafts kept over a storage.
 *
 * @remarks
 * SPEC-0001 ("模型与输入框"): each session's draft lives in the page's memory, which every box
 * showing it reads, and its text and capsules are written through to storage so they outlive a
 * restart; images stay in memory. Storage that cannot take a draft leaves memory the only copy,
 * and the older stored one goes, so it cannot come back. Storage changed elsewhere, as a test
 * clearing it, is read again, the images kept. An image is found by its id wherever its draft has
 * gone, so an upload that ends after the box went away, or after the empty state handed its draft
 * over, still lands.
 *
 * @sideEffects none until used; then reads and writes storage.
 * @param storage - Where drafts are mirrored.
 * @returns The drafts.
 */
export function createDrafts(storage: DraftStorage): Drafts {
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<() => void>>();

  /**
   * What storage holds for a key.
   *
   * @remarks
   * Storage that cannot be read counts as holding nothing.
   *
   * @sideEffects Reads storage.
   * @param key - The draft's key.
   * @returns The stored text, or `null`.
   */
  const storedAt = (key: string): string | null => {
    try {
      return storage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  };

  /**
   * Removes the stored copy of a draft.
   *
   * @remarks
   * Storage that cannot be written to has nothing to remove.
   *
   * @sideEffects Writes storage.
   * @param key - The draft's key.
   */
  const unstore = (key: string): void => {
    try {
      storage.removeItem(PREFIX + key);
    } catch {
      // Nothing to do: see above.
    }
  };

  /**
   * Tells those listening to a key that its draft changed.
   *
   * @remarks
   * See `subscribe`.
   *
   * @sideEffects Calls the listeners.
   * @param key - The draft's key.
   */
  const changed = (key: string): void => {
    for (const listener of listeners.get(key) ?? []) listener();
  };

  /**
   * Keeps a draft in memory and in storage.
   *
   * @remarks
   * An empty text and no capsules leave nothing stored.
   *
   * @sideEffects Writes storage; updates memory.
   * @param key - The draft's key.
   * @param draft - The draft.
   */
  const keep = (key: string, draft: Draft): void => {
    if (draft.text === "" && draft.pastes.length === 0 && draft.files.length === 0) {
      unstore(key);
      entries.set(key, { draft, stored: null, unsaved: false });
      return;
    }
    const stored = JSON.stringify({ text: draft.text, pastes: draft.pastes, files: draft.files });
    try {
      storage.setItem(PREFIX + key, stored);
      entries.set(key, { draft, stored, unsaved: false });
    } catch {
      unstore(key);
      entries.set(key, { draft, stored: null, unsaved: true });
    }
  };

  const drafts: Drafts = {
    read(key) {
      const stored = storedAt(key);
      const entry = entries.get(key);
      if (entry !== undefined && (entry.unsaved || entry.stored === stored)) return entry.draft;
      const parsed = parseStored(stored);
      const draft: Draft = { ...parsed, images: entry?.draft.images ?? [] };
      entries.set(key, { draft, stored, unsaved: false });
      return draft;
    },
    update(key, change) {
      const before = drafts.read(key);
      const after = change(before);
      if (after === before) return;
      keep(key, after);
      changed(key);
    },
    subscribe(key, listener) {
      const heard = listeners.get(key) ?? new Set();
      heard.add(listener);
      listeners.set(key, heard);
      return () => {
        heard.delete(listener);
        if (heard.size === 0) listeners.delete(key);
      };
    },
    updateImage(id, change) {
      for (const [key, entry] of entries) {
        if (!entry.draft.images.some((image) => image.id === id)) continue;
        drafts.update(key, (draft) => ({
          ...draft,
          images: draft.images.flatMap((image) => (image.id === id ? (change(image) ?? []) : [image])),
        }));
      }
    },
    handOver(from, to) {
      const draft = drafts.read(from);
      if (isEmpty(draft)) return;
      drafts.update(to, () => draft);
      drafts.update(from, () => EMPTY);
    },
    restore(key, text, images) {
      drafts.update(key, (draft) => (isEmpty(draft) ? { ...EMPTY, text, images } : draft));
    },
    drop(keys) {
      for (const key of keys) {
        unstore(key);
        const had = entries.delete(key);
        if (had) changed(key);
      }
    },
  };
  return drafts;
}

/** The page's drafts, made on first use; see `pageDrafts`. */
let page: Drafts | undefined;

/**
 * The page's drafts, mirrored into `localStorage`.
 *
 * @remarks
 * One for the page, so every box, the area that hands the empty state's draft over and the
 * cleanup of sessions gone share it. Made on first use, as `localStorage` exists only in a page.
 *
 * @sideEffects Creates the drafts on first use.
 * @returns The drafts.
 */
export function pageDrafts(): Drafts {
  page ??= createDrafts(localStorage);
  return page;
}

/**
 * The page's draft under a key, rendering again as it changes.
 *
 * @remarks
 * See `createDrafts`.
 *
 * @sideEffects Subscribes to the draft while mounted.
 * @param key - The session id, or `new:<container>` before the session exists.
 * @returns The draft.
 */
export function useDraft(key: string): Draft {
  const subscribe = useCallback((listener: () => void) => pageDrafts().subscribe(key, listener), [key]);
  const read = useCallback(() => pageDrafts().read(key), [key]);
  return useSyncExternalStore(subscribe, read);
}
