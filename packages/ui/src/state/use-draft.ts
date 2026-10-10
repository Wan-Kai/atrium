import { useCallback, useSyncExternalStore } from "react";
import { type Draft, type Drafts, createDrafts } from "./drafts";

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
