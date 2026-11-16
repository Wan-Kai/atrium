import type { AtriumClient } from "@atrium/client";

/** How many times each client's watched set was claimed; the latest claim is the one in force. */
const claims = new WeakMap<AtriumClient, number>();

/**
 * Watches sessions as the one in force, and gives back a way to let go that never undoes a newer claim.
 *
 * @remarks
 * `client.watch` replaces the whole set, so two parts of the page that each watch something take the set from one
 * another. The task area has several such owners (a list row watching the node that asks, a task's conversation, a
 * node's tab), and one that is dropped should stop the host sending what nobody shows any more (T8 review fix 14):
 * `release` empties the set, but only when no later claim has been made, so a newer owner's watch is never cleared
 * by an older one going away late.
 *
 * @sideEffects Sends the watch through the client.
 * @param client - The client.
 * @param sessionIds - The sessions to watch.
 * @returns The watch's outcome, and the function that lets go of this claim.
 */
export function claimWatch(
  client: AtriumClient,
  sessionIds: readonly string[],
): { readonly watched: Promise<void>; readonly release: () => void } {
  const turn = (claims.get(client) ?? 0) + 1;
  claims.set(client, turn);
  return {
    watched: client.watch(sessionIds),
    release: () => {
      if (claims.get(client) !== turn) return;
      // Fire and forget: a lost connection has nothing left to stop.
      client.watch([]).catch(() => undefined);
    },
  };
}
