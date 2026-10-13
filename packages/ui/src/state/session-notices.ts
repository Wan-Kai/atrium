import { type StoreApi, createStore } from "zustand/vanilla";

/** A line beside the tab bar's "···" saying what a command did for a session. */
export interface SessionNotice {
  readonly sessionId: string;
  readonly text: string;
}

/** The page's notice, made on first use; see `pageNotices`. */
let page: StoreApi<SessionNotice | null> | undefined;

/**
 * The notice the tab bar shows, if any.
 *
 * @remarks
 * One for the page, as the conversation area runs the commands and the tab bar, beside it, shows
 * what they did (SPEC-0001, "M1.11 的 `/` 命令": "标签栏旁一行").
 *
 * @sideEffects Creates the store on first use.
 * @returns The store.
 */
export function pageNotices(): StoreApi<SessionNotice | null> {
  page ??= createStore<SessionNotice | null>(() => null);
  return page;
}

/**
 * Shows a notice for a session beside the tab bar, in place of any other.
 *
 * @remarks
 * See `pageNotices`; the line takes itself away.
 *
 * @sideEffects Updates the page's notice.
 * @param sessionId - The session it is about.
 * @param text - What to say.
 */
export function showNotice(sessionId: string, text: string): void {
  // A new object each time, so the line tells one showing of the same words from the next.
  pageNotices().setState({ sessionId, text }, true);
}
