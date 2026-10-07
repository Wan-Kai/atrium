import type { AtriumClient, ConnectionState } from "@atrium/client";
import { useStore } from "zustand";

/**
 * Subscribes a component to a connection's state.
 *
 * @remarks
 * The client keeps state in a DOM-free vanilla store; this hook is the only bridge from it to
 * React (overview.md, "代码结构", `ui/src/state`).
 *
 * @sideEffects Subscribes the calling component to the store; it re-renders on every change.
 * @param client - The client whose connection to watch.
 * @returns The current state.
 */
export function useConnectionState(client: AtriumClient): ConnectionState {
  return useStore(client.connection);
}
