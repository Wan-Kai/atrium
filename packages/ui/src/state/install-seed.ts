import type { AtriumClient } from "@atrium/client";
import { useState } from "react";
import { useStore } from "zustand";

/**
 * The seed of this install's dot pattern, from the host's welcome.
 *
 * @remarks
 * The host makes it from the install id in `~/.atrium`, so the pattern stays the same for each
 * install (SPEC-0001, "首次启动 · 接口"; design-language, "点阵"). It is kept while the connection
 * is down, so the dots do not change while reconnecting, and is 1 before any host has welcomed.
 *
 * @sideEffects Subscribes the calling component to the connection.
 * @param connection - The client's connection.
 * @returns The seed, a positive integer.
 */
export function useInstallSeed(connection: AtriumClient["connection"]): number {
  const current = useStore(connection, (state) => (state.status === "connected" ? state.installSeed : null));
  const [kept, setKept] = useState(current ?? 1);
  // Adjusting state while rendering: a new seed shows in this same render.
  if (current !== null && current !== kept) setKept(current);
  return current ?? kept;
}
