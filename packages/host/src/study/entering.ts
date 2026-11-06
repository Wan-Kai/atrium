import type { Layouts } from "../sessions/layouts";

/**
 * Wraps the layouts so a client going into a container is told.
 *
 * @remarks
 * The learning home's "继续" is the direction opened last (SPEC-0008, "入口"): a client goes into
 * one by `select_container`, or by opening or creating a session there that takes it along. Told
 * only once the layout is written; an open that leaves the client where it was tells nothing.
 *
 * @sideEffects none until a change; then as the layouts, and calls `entered`.
 * @param layouts - The layouts.
 * @param entered - Told the container a client went into, or `null` for nowhere.
 * @returns The layouts.
 */
export function withEntries(layouts: Layouts, entered: (containerId: string | null) => void): Layouts {
  return {
    ...layouts,
    async open(clientId, containerId, sessionId, go = true) {
      await layouts.open(clientId, containerId, sessionId, go);
      if (go) entered(containerId);
    },
    async select(clientId, containerId) {
      await layouts.select(clientId, containerId);
      entered(containerId);
    },
  };
}
