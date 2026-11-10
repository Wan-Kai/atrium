import type { AtriumClient } from "@atrium/client";
import { useMemo } from "react";
import type { StoreApi } from "zustand";
import { VisualCard } from "../chat/visual-card";
import { directionVisualsAccess } from "../chat/visuals-access";
import type { WorkspaceViews } from "../state/workspace-views";
import { useViewerPlace } from "./viewer-place";

/**
 * A demo of a learning direction in its viewer tab: the same sandboxed card, without its title row.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 从档案打开的演示" (prototype study-home 5A): resolved for the
 * direction, so it belongs to no session and sends nothing (`sendMessage` gets `false`); centered,
 * at most 640px, 24px around and 40px below. Its scroll is the tab's preview place.
 *
 * @sideEffects Resolves the file and hears its changes; restores and keeps the scroll.
 * @param props - The client, the views, the direction and the path in it.
 * @returns The preview.
 */
export function DemoPreview({
  client,
  views,
  directionId,
  path,
}: {
  readonly client: AtriumClient;
  readonly views: StoreApi<WorkspaceViews>;
  readonly directionId: string;
  readonly path: string;
}) {
  const { body } = useViewerPlace(views, directionId, `file:${path}`, true, "previewScrollTop");
  const access = useMemo(() => directionVisualsAccess(client, directionId), [client, directionId]);
  return (
    <div ref={body} className="absolute inset-0 overflow-auto" data-testid="demo-preview">
      <div className="mx-auto max-w-[640px] px-6 pt-6 pb-10">
        <VisualCard access={access} path={path} title={null} headless />
      </div>
    </div>
  );
}
