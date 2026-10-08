import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { type StoreApi, createStore } from "zustand/vanilla";

/** How much of a turn's process shows (SPEC-0001, "显示模式"). */
export type DisplayMode = "summary" | "thinking" | "detailed";

/** The modes in the order Ctrl+O goes through them, with their names. */
export const DISPLAY_MODES: readonly { readonly mode: DisplayMode; readonly label: string; readonly hint: string }[] = [
  { mode: "summary", label: "摘要", hint: "只突出回复，过程折叠" },
  { mode: "thinking", label: "思考", hint: "另外展开推理过程" },
  { mode: "detailed", label: "详细", hint: "展开每一步" },
];

/** The display mode and how to change it. */
export interface DisplayModeState {
  readonly mode: DisplayMode;
  readonly set: (mode: DisplayMode) => void;
  /** Goes to the next mode, as Ctrl+O does. */
  readonly cycle: () => void;
}

/** Where the choice is kept; it applies to every session. */
const STORAGE_KEY = "atrium.displayMode";

/**
 * Creates the display mode store, remembering the choice in `storage`.
 *
 * @remarks
 * The choice is global and remembered (SPEC-0001, "显示模式"); summary is the default, and so is
 * anything unreadable in storage. A storage that refuses to write only loses the memory.
 *
 * @sideEffects Reads `storage` now; writes it on every change.
 * @param storage - Where to keep the choice.
 * @returns The store.
 */
export function createDisplayMode(storage: Pick<Storage, "getItem" | "setItem">): StoreApi<DisplayModeState> {
  const saved = storage.getItem(STORAGE_KEY);
  const initial = DISPLAY_MODES.find((entry) => entry.mode === saved)?.mode ?? "summary";
  return createStore<DisplayModeState>()((setState, getState) => {
    /**
     * Sets and remembers the mode.
     *
     * @remarks
     * See `createDisplayMode`.
     *
     * @sideEffects Updates the store; writes `storage`.
     * @param mode - The mode.
     */
    const set = (mode: DisplayMode): void => {
      setState({ mode });
      try {
        storage.setItem(STORAGE_KEY, mode);
      } catch {
        // Storage full or disabled: the mode still applies for now.
      }
    };
    return {
      mode: initial,
      set,
      cycle: () => {
        const index = DISPLAY_MODES.findIndex((entry) => entry.mode === getState().mode);
        set(DISPLAY_MODES[(index + 1) % DISPLAY_MODES.length]?.mode ?? "summary");
      },
    };
  });
}

/** The display mode the app provides; tests without a provider get one that remembers nothing. */
export const DisplayModeContext = createContext<StoreApi<DisplayModeState>>(
  createDisplayMode({ getItem: () => null, setItem: () => undefined }),
);

/**
 * Subscribes a component to the display mode.
 *
 * @remarks
 * The only bridge from the store to React, as with the client's stores.
 *
 * @sideEffects Re-renders the calling component when the mode changes.
 * @returns The mode and its setters.
 */
export function useDisplayMode(): DisplayModeState {
  return useStore(useContext(DisplayModeContext));
}
