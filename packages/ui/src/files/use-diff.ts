import type { AtriumClient, ChangesView, DiffView } from "@atrium/client";
import type { DiffMode } from "@atrium/protocol";
import { useEffect, useRef, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { diffModeOf } from "../chat/changes";
import { type WorkspaceViews, chooseDiff, viewOf } from "../state/workspace-views";

/** The changes of no workspace, for chats. */
export const NO_CHANGES = createStore<ChangesView>(() => null);

/**
 * The diff mode a workspace's panel and 改动 tab show.
 *
 * @remarks
 * See `diffModeOf`: the choice is the container's, shared by both. A chat has none to show, and
 * reads as having no changes.
 *
 * @sideEffects Subscribes to the workspace's changes and the views.
 * @param client - The client.
 * @param views - The workspace views.
 * @param workspaceId - The workspace, or `null` in a chat.
 * @returns The mode.
 */
export function useDiffMode(
  client: AtriumClient,
  views: StoreApi<WorkspaceViews>,
  workspaceId: string | null,
): DiffMode {
  const dirty = useStore(workspaceId === null ? NO_CHANGES : client.changes(workspaceId), (changes) => changes?.dirty);
  const choice = useStore(views, (state) => (workspaceId === null ? null : viewOf(state, workspaceId).choice));
  return diffModeOf(choice, dirty ?? false);
}

/**
 * The diff the host sends for a workspace and mode, or `null` while it sends another or none.
 *
 * @remarks
 * Only one is watched at a time (`watch_diff`); the conversation area watches it (SPEC-0001,
 * "M1.12 的文件与更改 · 右栏").
 *
 * @sideEffects Subscribes to the client's diff.
 * @param client - The client.
 * @param workspaceId - The workspace.
 * @param mode - The mode.
 * @returns The diff.
 */
export function useShownDiff(client: AtriumClient, workspaceId: string, mode: DiffMode): DiffView | null {
  const view = useStore(client.diff);
  return view.target?.workspaceId === workspaceId && view.target.mode === mode ? view : null;
}

/**
 * Watches a workspace's diff while it is wanted, and forgets a mode chosen once the tree's state changes.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 右栏"): wanted while the right panel is open or the 改动 tab
 * shows; with neither, `watch_diff(null)`, sent only after a watch. A choice made while the tree
 * was otherwise is gone for good once it changes, as in Paseo.
 *
 * @sideEffects Sends `watch_diff`; writes the views.
 * @param client - The client.
 * @param views - The workspace views.
 * @param workspaceId - The workspace, or `null` in a chat.
 * @param wanted - Whether the diff is wanted.
 */
export function useDiffWatch(
  client: AtriumClient,
  views: StoreApi<WorkspaceViews>,
  workspaceId: string | null,
  wanted: boolean,
): void {
  const mode = useDiffMode(client, views, workspaceId);
  const dirty = useStore(workspaceId === null ? NO_CHANGES : client.changes(workspaceId), (changes) => changes?.dirty);
  const choice = useStore(views, (state) => (workspaceId === null ? null : viewOf(state, workspaceId).choice));
  useEffect(() => {
    if (workspaceId !== null && choice !== null && choice.dirty !== (dirty ?? false))
      chooseDiff(views, workspaceId, null);
  }, [views, workspaceId, choice, dirty]);
  const watched = useRef(false);
  useEffect(() => {
    if (wanted && workspaceId !== null) {
      watched.current = true;
      // Fire and forget: a failure leaves the diff loading until the next connection asks again.
      client.watchDiff({ workspaceId, mode }).catch(() => undefined);
    } else if (watched.current) {
      watched.current = false;
      // Fire and forget: see above.
      client.watchDiff(null).catch(() => undefined);
    }
  }, [client, wanted, workspaceId, mode]);
  useEffect(
    () => () => {
      // Fire and forget: see above.
      if (watched.current) client.watchDiff(null).catch(() => undefined);
    },
    [client],
  );
}

/**
 * A count that goes up each time a run in a workspace ends.
 *
 * @remarks
 * The files tree and a file tab read again then (SPEC-0001, "M1.12 的文件与更改"): fewer of the
 * workspace's sessions are running than before.
 *
 * @sideEffects Subscribes to the client's list.
 * @param client - The client.
 * @param workspaceId - The workspace.
 * @returns The count, 0 at first.
 */
export function useRunEnds(client: AtriumClient, workspaceId: string): number {
  const running = useStore(
    client.index,
    (index) => index.sessions.filter((session) => session.containerId === workspaceId && session.running).length,
  );
  const [seen, setSeen] = useState({ running, ends: 0 });
  // Adjusting state while rendering, as React advises for state that follows other values.
  if (running !== seen.running) setSeen({ running, ends: seen.ends + Number(running < seen.running) });
  return seen.ends;
}
