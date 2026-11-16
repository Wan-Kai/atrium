import type { AtriumClient } from "@atrium/client";
import type { DirEntry, Direction } from "@atrium/protocol";
import { useEffect, useState } from "react";
import type { StoreApi } from "zustand";
import { CaretRight } from "../design/icons";
import { FileIcon } from "../files/file-icon";
import { useRunEnds } from "../files/use-diff";
import { type WorkspaceViews, openFile } from "../state/workspace-views";
import { archiveFiles, demoGroups } from "./archive";

/** A folder's listing, as the host answered, or why not. */
type Listing = { readonly entries: readonly DirEntry[]; readonly truncated: boolean } | "failed" | null;

/** The class of a group's small heading, as the gaps' (design-language "学习模式", 4A). */
const GROUP = "mt-3 mb-1 flex items-center gap-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)] first:mt-0";

/**
 * One folder of a direction, listed again whenever `version` changes.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 档案": the direction's list changing, a run ending there and its
 * visuals changing all bring a new version; a failure shows as failed until the next one, which is
 * the retry after an archive or a restore moved the folder meanwhile.
 *
 * @sideEffects Sends `list_dir` on each version.
 * @param client - The client.
 * @param directionId - The direction.
 * @param path - The folder, relative to it; `null` lists nothing.
 * @param version - Changes when it should be listed again.
 * @returns The listing, `null` before the first answer.
 */
function useListing(client: AtriumClient, directionId: string, path: string | null, version: string): Listing {
  const [listing, setListing] = useState<Listing>(null);
  useEffect(() => {
    if (path === null) return undefined;
    let live = true;
    /**
     * Keeps an answer while the folder is still wanted.
     *
     * @remarks
     * See `useListing`.
     *
     * @sideEffects Sets the state while mounted.
     * @param next - The answer.
     */
    const arrived = (next: Listing): void => {
      if (live) setListing(next);
    };
    client.listDir(directionId, path).then(
      (listed) => arrived(listed),
      () => arrived("failed"),
    );
    return () => {
      live = false;
    };
    // Listed again on each version (SPEC-0008, "ML4 定的细节 · 档案").
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above.
  }, [client, directionId, path, version]);
  return listing;
}

/**
 * The version the archive lists at: the direction as listed, its runs ended and its visuals changed.
 *
 * @remarks
 * See `useListing`. Only the visuals resolved for the direction, as its viewer tabs do, are told.
 *
 * @sideEffects Listens to the client's visual changes.
 * @param client - The client.
 * @param direction - The direction.
 * @returns The version.
 */
function useArchiveVersion(client: AtriumClient, direction: Direction): string {
  const runEnds = useRunEnds(client, direction.id);
  const [changes, setChanges] = useState(0);
  useEffect(
    () =>
      client.onVisualChanged((changed) => {
        if (changed.directionId === direction.id) setChanges((count) => count + 1);
      }),
    [client, direction.id],
  );
  return `${direction.dir}\n${String(direction.archived)}\n${JSON.stringify(direction.progress)}\n${String(runEnds)}\n${String(changes)}`;
}

/**
 * A row of the archive's files: a file opens in the viewer tab, a folder opens in place.
 *
 * @remarks
 * design-language "学习模式" (4A): 28px, a folder's chevron or a file's type icon, 14px deeper per
 * level; a link shows as a file and opens as one, where the viewer says it is a link.
 *
 * @sideEffects Lists a folder opened; opens a file in a viewer tab.
 * @param props - The client, the views, the direction and version, the entry, its folder and depth.
 * @returns The row, and a folder's rows when open.
 */
function FileRow({
  client,
  views,
  directionId,
  version,
  entry,
  folder,
  depth,
}: {
  readonly client: AtriumClient;
  readonly views: StoreApi<WorkspaceViews>;
  readonly directionId: string;
  readonly version: string;
  readonly entry: DirEntry;
  readonly folder: string;
  readonly depth: number;
}) {
  const [open, setOpen] = useState(false);
  const path = `${folder}${entry.name}`;
  const dir = entry.kind === "dir";
  return (
    <li>
      <button
        type="button"
        aria-expanded={dir ? open : undefined}
        onClick={() => (dir ? setOpen(!open) : openFile(views, directionId, path, false))}
        onDoubleClick={() => (dir ? undefined : openFile(views, directionId, path, true))}
        style={{ paddingLeft: 6 + depth * 14 }}
        className="flex min-h-7 w-full items-center gap-[7px] rounded-[var(--r)] pr-2 text-left text-[length:var(--fs-meta)] whitespace-nowrap text-[var(--text-2)] hover:bg-[var(--hover)]"
      >
        {dir ? (
          <CaretRight
            size={12}
            aria-hidden
            className={`w-3.5 shrink-0 text-[var(--text-dim)] ${open ? "rotate-90" : ""}`}
          />
        ) : (
          <FileIcon path={entry.name} size={14} />
        )}
        <span className="min-w-0 flex-1 truncate">
          {entry.name}
          {dir ? "/" : ""}
        </span>
      </button>
      {dir && open ? (
        <Folder
          client={client}
          views={views}
          directionId={directionId}
          version={version}
          folder={`${path}/`}
          depth={depth + 1}
        />
      ) : null}
    </li>
  );
}

/**
 * An opened folder's rows in the archive, folders first, then by name.
 *
 * @remarks
 * As the right panel's tree: what the host lists (in `lab/`, without what git ignores).
 *
 * @sideEffects Lists the folder.
 * @param props - The client, the views, the direction and version, the folder and depth.
 * @returns The rows.
 */
function Folder({
  client,
  views,
  directionId,
  version,
  folder,
  depth,
}: {
  readonly client: AtriumClient;
  readonly views: StoreApi<WorkspaceViews>;
  readonly directionId: string;
  readonly version: string;
  readonly folder: string;
  readonly depth: number;
}) {
  const listing = useListing(client, directionId, folder.slice(0, -1), version);
  if (listing === null) return null;
  if (listing === "failed") return <Note depth={depth}>读不了这个目录</Note>;
  const entries = listing.entries.toSorted(
    (a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || (a.name < b.name ? -1 : 1),
  );
  return (
    <ul>
      {entries.map((entry) => (
        <FileRow
          key={entry.name}
          client={client}
          views={views}
          directionId={directionId}
          version={version}
          entry={entry}
          folder={folder}
          depth={depth}
        />
      ))}
      {listing.truncated ? <Note depth={depth}>还有更多，没有列出</Note> : null}
    </ul>
  );
}

/**
 * A line in the archive's list instead of rows: why it cannot list, or that it was cut.
 *
 * @remarks
 * As the right panel's tree says it.
 *
 * @sideEffects none
 * @param props - Its depth and words.
 * @returns The line.
 */
function Note({ depth, children }: { readonly depth: number; readonly children: string }) {
  return (
    <p style={{ paddingLeft: 6 + depth * 14 }} className="py-1 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
      {children}
    </p>
  );
}

/**
 * The direction home's "档案": its demos by level, then its files.
 *
 * @remarks
 * SPEC-0008, "ML4 定的细节 · 档案"; design-language "学习模式" (prototype study-home 4A): "演示" is a
 * card of `visuals/` by level, the newest first, each row its step and lesson over its file name,
 * those matched to no lesson last; "文件" is the direction's root in its order, folders opening in
 * place. A row opens in the direction's viewer tab. The direction's files are read where it is
 * now, archived too; no file's content is read here. `visuals/` that cannot be listed says so in
 * place of the demos, and one cut at the limit says there are more, as the files do.
 *
 * @sideEffects Lists the direction's folders, again as it changes; opens viewer tabs.
 * @param props - The client, the direction and the views.
 * @returns The section.
 */
export function DirectionArchive({
  client,
  direction,
  views,
}: {
  readonly client: AtriumClient;
  readonly direction: Direction;
  readonly views: StoreApi<WorkspaceViews>;
}) {
  const version = useArchiveVersion(client, direction);
  const root = useListing(client, direction.id, "", version);
  const hasVisuals =
    root !== null &&
    root !== "failed" &&
    root.entries.some((entry) => entry.name === "visuals" && entry.kind === "dir");
  const visuals = useListing(client, direction.id, hasVisuals ? "visuals" : null, version);
  const groups =
    hasVisuals && visuals !== null && visuals !== "failed"
      ? demoGroups(
          visuals.entries.filter((entry) => entry.kind === "file").map((entry) => entry.name),
          direction.progress,
        )
      : [];
  const count = groups.reduce((sum, group) => sum + group.demos.length, 0);
  // A listing that failed is not one with no demos, and one cut short says so (ML4 three-way review).
  const demosFailed = hasVisuals && visuals === "failed";
  const demosCut = hasVisuals && visuals !== null && visuals !== "failed" && visuals.truncated;
  return (
    <section aria-label="档案">
      <h2 className="mb-2 text-[length:var(--fs-xs)] font-normal text-[var(--text-dim)]">档案</h2>
      {root === "failed" ? <Note depth={0}>读不了这个方向的目录</Note> : null}
      {demosFailed ? (
        <>
          <h3 className={GROUP}>演示</h3>
          <Note depth={0}>读不了演示目录</Note>
        </>
      ) : null}
      {count === 0 ? null : (
        <>
          <h3 className={GROUP}>
            演示<span className="ml-auto">{count} 个</span>
          </h3>
          <div className="rounded-[16px] bg-[var(--surface-1)] py-1 shadow-[var(--card-shadow)]">
            {groups.map((group) => (
              <div key={group.level ?? "rest"}>
                <p className="px-3 pt-2 pb-0.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
                  {group.level === null ? "没对上课的" : `第 ${String(group.level)} 级`}
                </p>
                <ul>
                  {group.demos.map((demo) => (
                    <li key={demo.name}>
                      <button
                        type="button"
                        onClick={() => openFile(views, direction.id, `visuals/${demo.name}`, false)}
                        onDoubleClick={() => openFile(views, direction.id, `visuals/${demo.name}`, true)}
                        className="flex w-full items-start gap-2 px-3 py-[5px] text-left hover:bg-[var(--hover)]"
                      >
                        <span className="mt-0.5 shrink-0">
                          <FileIcon path={demo.name} size={14} />
                        </span>
                        {demo.label === null ? (
                          <span className="min-w-0 truncate font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] text-[var(--text-muted)]">
                            {demo.name}
                          </span>
                        ) : (
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-[length:var(--fs-meta)] text-[var(--text-2)]">
                              {demo.label}
                            </span>
                            <span className="truncate font-[family-name:var(--font-mono)] text-[length:var(--fs-xs)] text-[var(--text-dim)]">
                              {demo.name}
                            </span>
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {demosCut ? <Note depth={0}>还有更多，没有列出</Note> : null}
        </>
      )}
      {root === null || root === "failed" ? null : (
        <>
          <h3 className={GROUP}>文件</h3>
          <ul>
            {archiveFiles(root.entries).map((entry) => (
              <FileRow
                key={entry.name}
                client={client}
                views={views}
                directionId={direction.id}
                version={version}
                entry={entry}
                folder=""
                depth={0}
              />
            ))}
          </ul>
          {root.truncated ? <Note depth={0}>还有更多，没有列出</Note> : null}
        </>
      )}
    </section>
  );
}
