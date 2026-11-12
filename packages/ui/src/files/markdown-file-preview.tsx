import { type AtriumClient, isDirectionId } from "@atrium/client";
import { useMemo } from "react";
import { type StoreApi, useStore } from "zustand";
import { Markdown } from "../chat/markdown";
import { FileParentsContext, OpenFileContext, type FileOpener } from "../chat/file-opener";
import { ReplyImagesContext, replyImageFiles } from "../chat/reply-images";
import { type WorkspaceViews, openFile } from "../state/workspace-views";
import { useViewerPlace } from "./viewer-place";
import { workspacePath } from "./workspace-path";

/** Renders an explicitly opened Markdown preview in the existing file tab.
 * @remarks Reuses the reply renderer's formatting and security policy. Mounting only in preview
 * mode releases diagrams and images on return to source; source keeps its own scrolling viewport.
 * @sideEffects Restores and saves preview scroll; subscribes to workspace metadata; the renderer
 * may load plugins and approved images. File links open window-local tabs only on activation.
 * @param props - Client, window-local views, workspace, file path and already-read text.
 * @returns The preview viewport.
 */
export function MarkdownFilePreview({
  client,
  views,
  workspaceId,
  path,
  text,
}: {
  readonly client: AtriumClient;
  readonly views: StoreApi<WorkspaceViews>;
  readonly workspaceId: string;
  readonly path: string;
  readonly text: string;
}) {
  const { body } = useViewerPlace(views, workspaceId, `file:${path}`, true, "previewScrollTop");
  // A workspace's, or a learning direction's where it is now; only a direction's notes link up with `..` (ML4).
  const direction = isDirectionId(workspaceId);
  const dir = useStore(
    client.index,
    (state) => (direction ? state.directions : state.workspaces).find((one) => one.id === workspaceId)?.dir ?? null,
  );
  const basePath = path.slice(0, path.lastIndexOf("/") + 1);
  const images = useMemo(
    () => (dir === null ? null : replyImageFiles(client, workspaceId, dir, basePath, direction)),
    [client, workspaceId, dir, basePath, direction],
  );
  const opener = useMemo<FileOpener>(
    () => (target, range) => {
      // ReplyFile has already decoded and rejected traversal, schemes and control characters.
      const relative =
        dir === null ? null : workspacePath(target.startsWith("/") ? target : `${basePath}${target}`, dir);
      return relative === null ? null : () => openFile(views, workspaceId, relative, true, range);
    },
    [dir, basePath, views, workspaceId],
  );
  return (
    <div ref={body} className="absolute inset-0 overflow-auto [contain:strict]" data-testid="markdown-preview">
      <div className="mx-auto max-w-[var(--column)] px-6 pt-6 pb-10 text-[length:var(--fs-reply)] leading-[var(--lh-reply)]">
        <FileParentsContext value={direction}>
          <OpenFileContext value={opener}>
            <ReplyImagesContext value={images}>
              <Markdown text={text} streaming={false} />
            </ReplyImagesContext>
          </OpenFileContext>
        </FileParentsContext>
      </div>
    </div>
  );
}
