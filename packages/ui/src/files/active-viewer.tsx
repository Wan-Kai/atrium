import type { AtriumClient } from "@atrium/client";
import type { StoreApi } from "zustand";
import { type WorkspaceViews, openDiff } from "../state/workspace-views";
import { DiffViewer } from "./diff-viewer";
import { FileViewer } from "./file-viewer";
import { useDiffMode, useShownDiff } from "./use-diff";

/**
 * The viewer tab shown, in place of the conversation.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"): the whole area, its input box, capsules and status
 * bar too, gives way to it. The caller draws it afresh for each tab of each workspace, so a tab's
 * reading, scroll and wrapping are its own; a file tab has the file's diff when the diff is
 * watched and has one.
 *
 * @sideEffects Subscribes to the client and the views; through the tab, reads the file or shows
 * the diff.
 * @param props - The client, the workspace, the views, and the tab's key.
 * @returns The tab's content.
 */
export function ActiveViewer({
  client,
  workspaceId,
  views,
  viewerKey,
}: {
  readonly client: AtriumClient;
  readonly workspaceId: string;
  readonly views: StoreApi<WorkspaceViews>;
  readonly viewerKey: string;
}) {
  const mode = useDiffMode(client, views, workspaceId);
  const shown = useShownDiff(client, workspaceId, mode);
  if (viewerKey === "diff") return <DiffViewer client={client} workspaceId={workspaceId} views={views} mode={mode} />;
  const path = viewerKey.slice("file:".length);
  const diff = shown?.files.find((file) => file.path === path) ?? null;
  return (
    <FileViewer
      client={client}
      workspaceId={workspaceId}
      views={views}
      path={path}
      diff={diff}
      onShowDiff={() => openDiff(views, workspaceId, path)}
    />
  );
}
