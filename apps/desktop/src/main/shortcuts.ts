/** The page's actions the main process passes on for keys the page may not hear (SPEC-0007, "键盘"). */
export type MenuShortcut = "close-tab" | "settings";

/**
 * Which of the shortcuts kept from visuals a key is: ⌘W closes the tab, ⌘, opens the settings.
 *
 * @remarks
 * Only the bare command key with it; any other is the page's, or a visual's.
 *
 * @sideEffects none
 * @param input - The key.
 * @returns The shortcut, or `null`.
 */
export function menuShortcut(
  input: Pick<Electron.Input, "type" | "key" | "meta" | "control" | "alt" | "shift">,
): MenuShortcut | null {
  if (input.type !== "keyDown" || !input.meta || input.control || input.alt || input.shift) return null;
  if (input.key.toLowerCase() === "w") return "close-tab";
  return input.key === "," ? "settings" : null;
}
