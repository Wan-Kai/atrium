/** The keys each shortcut the main process passes on stands for. */
const KEYS = { "close-tab": "w", settings: "," } as const;

/**
 * Plays the shortcuts the main process takes, ⌘W and ⌘,, as the page's own key presses.
 *
 * @remarks
 * SPEC-0007 ("键盘", MV1 details): with the focus in a visual the page hears no key, so the main
 * process takes these two and tells the page; the page's handlers for its own ⌘W and ⌘, then do
 * what they always do.
 *
 * @sideEffects Listens to the bridge until stopped; dispatches key events on the window.
 * @param listen - The bridge's `onShortcut`, if the page runs in the app.
 * @returns Stops listening.
 */
export function playMenuShortcuts(
  listen: ((listener: (shortcut: "close-tab" | "settings") => void) => () => void) | undefined,
): () => void {
  if (listen === undefined) return () => undefined;
  return listen((shortcut) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: KEYS[shortcut], metaKey: true, cancelable: true }));
  });
}
