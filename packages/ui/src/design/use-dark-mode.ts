import { useSyncExternalStore } from "react";

/**
 * Reads whether the page is in dark mode.
 *
 * @remarks
 * `appearance.ts` puts `.dark` on `<html>`; this is the same answer CSS sees.
 *
 * @sideEffects none
 * @returns Whether dark mode is on.
 */
function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

/**
 * Subscribes to class changes on `<html>`.
 *
 * @remarks
 * Appearance changes are rare, so a MutationObserver on one attribute costs nothing.
 *
 * @sideEffects Observes `<html>`'s class attribute until unsubscribed.
 * @param onChange - Called when the class changes.
 * @returns The unsubscribe function.
 */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/**
 * Whether the page is in dark mode, updating when it changes.
 *
 * @remarks
 * For the few things CSS cannot switch by itself, such as Mermaid's theme.
 *
 * @sideEffects Subscribes the component to appearance changes.
 * @returns Whether dark mode is on.
 */
export function useDarkMode(): boolean {
  return useSyncExternalStore(subscribe, isDark);
}
