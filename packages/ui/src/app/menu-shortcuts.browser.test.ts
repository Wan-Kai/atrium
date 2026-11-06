import { describe, expect, it } from "vitest";
import { playMenuShortcuts } from "./menu-shortcuts";

/**
 * A key as the test writes it: ⌘ in front when the command key is down.
 *
 * @remarks
 * For comparing whole presses at once.
 *
 * @sideEffects none
 * @param event - The key event.
 * @returns Its name.
 */
function keyName(event: KeyboardEvent): string {
  return `${event.metaKey ? "⌘" : ""}${event.key}`;
}

describe("playMenuShortcuts", () => {
  it("plays ⌘W and ⌘, from the main process as the page's own keys, until stopped", () => {
    const bridge: { tell: ((shortcut: "close-tab" | "settings") => void) | null } = { tell: null };
    const keys: string[] = [];
    const heard = (event: KeyboardEvent): void => {
      keys.push(keyName(event));
    };
    window.addEventListener("keydown", heard);
    const stop = playMenuShortcuts((listener) => {
      bridge.tell = listener;
      return () => {
        bridge.tell = null;
      };
    });

    bridge.tell?.("close-tab");
    bridge.tell?.("settings");
    stop();
    window.removeEventListener("keydown", heard);

    expect(keys).toStrictEqual(["⌘w", "⌘,"]);
    expect(bridge.tell).toBeNull();
    expect(playMenuShortcuts(undefined)()).toBeUndefined();
  });
});
