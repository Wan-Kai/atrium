import type { AtriumClient } from "@atrium/client";
import type { DisplayMode } from "@atrium/protocol";
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { type StoreApi, createStore } from "zustand/vanilla";

export type { DisplayMode };

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

/**
 * Creates a display mode store.
 *
 * @remarks
 * The choice is global and remembered by the host with the other preferences (SPEC-0001,
 * "显示模式"; "项目、工作区与会话"); the app passes a `save` that sends it there and keeps the
 * store in step with the list (`followPreferences`). Summary is the default.
 *
 * @sideEffects none until a change; then calls `save`.
 * @param initial - The mode to start with.
 * @param save - Where a chosen mode goes.
 * @returns The store.
 */
export function createDisplayMode(
  initial: DisplayMode = "summary",
  save: (mode: DisplayMode) => void = () => undefined,
): StoreApi<DisplayModeState> {
  return createStore<DisplayModeState>()((setState, getState) => {
    /**
     * Sets the mode and saves it.
     *
     * @remarks
     * See `createDisplayMode`.
     *
     * @sideEffects Updates the store; calls `save`.
     * @param mode - The mode.
     */
    const set = (mode: DisplayMode): void => {
      setState({ mode });
      save(mode);
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

/**
 * Keeps a display mode store in step with the preferences in a client's list.
 *
 * @remarks
 * Another client, or the host's first snapshot, may change the mode.
 *
 * @sideEffects Subscribes to the client's list until the returned function is called.
 * @param store - The store.
 * @param client - The client.
 * @returns A function that stops following.
 */
export function followPreferences(store: StoreApi<DisplayModeState>, client: AtriumClient): () => void {
  /**
   * Copies the list's mode into the store when it differs.
   *
   * @remarks
   * See `followPreferences`.
   *
   * @sideEffects May update the store.
   */
  const copy = (): void => {
    const mode = client.index.getState().preferences.displayMode;
    if (store.getState().mode !== mode) store.setState({ mode });
  };
  copy();
  return client.index.subscribe(copy);
}

/** The display mode the app provides; tests without a provider get one that remembers nothing. */
export const DisplayModeContext = createContext<StoreApi<DisplayModeState>>(createDisplayMode());

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
