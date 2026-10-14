import type { AtriumClient } from "@atrium/client";
import type { DiffFile, DirEntry } from "@atrium/protocol";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowsInLineVertical, CircleNotch } from "../design/icons";
import type { PaneStorage } from "../state/panes";
import { keepPaths, keptPaths, keptPathsKey } from "../state/workspace-views";
import { CenterNote } from "./diff-parts";
import { ROW_BUTTON } from "./changes-part";
import { FileIcon } from "./file-icon";
import { TreeArrow, TreeRow } from "./tree-row";
import { restoredDirs, sortEntries } from "./trees";

/** A directory as read: its entries sorted, or that it could not be read. */
type Listing = { readonly entries: readonly DirEntry[]; readonly truncated: boolean } | "failed";

/**
 * A path in the workspace, from a directory's path and an entry's name.
 *
 * @remarks
 * The top directory's path is `""`.
 *
 * @sideEffects none
 * @param dir - The directory.
 * @param name - The entry's name.
 * @returns The path.
 */
function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/**
 * Reads directories, keeping each one's last listing, and the same listing object while it does
 * not change.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 文件"): read again, a directory that reads the same is left as
 * it was, so nothing redraws. One that cannot be read lists nothing.
 *
 * @sideEffects Sends `list_dir`; updates component state as answers come, until unmounted.
 * @param client - The client.
 * @param workspaceId - The workspace.
 * @returns The listings by path, the paths being read, and how to read some.
 */
function useListings(client: AtriumClient, workspaceId: string) {
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(new Map());
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const read = useCallback(
    (paths: Iterable<string>) => {
      for (const path of paths) {
        setReading((now) => new Set([...now, path]));
        /**
         * Keeps a directory's listing, unless it reads as before.
         *
         * @remarks
         * See `useListings`.
         *
         * @sideEffects Updates component state while mounted.
         * @param listing - The listing.
         */
        const arrived = (listing: Listing): void => {
          if (!mounted.current) return;
          setReading((now) => new Set([...now].filter((each) => each !== path)));
          setListings((now) =>
            JSON.stringify(now.get(path)) === JSON.stringify(listing) ? now : new Map([...now, [path, listing]]),
          );
        };
        client.listDir(workspaceId, path).then(
          ({ entries, truncated }) => arrived({ entries: sortEntries(entries), truncated }),
          () => arrived("failed"),
        );
      }
    },
    [client, workspaceId],
  );
  return { listings, reading, read };
}

/**
 * The right panel's 文件 tab: the workspace's name, "全部收起" and refresh, then its files as a tree.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 文件"). Each directory is read the first time it expands, its
 * arrow a spinner meanwhile; what is expanded is kept by workspace and expands again, five levels
 * down at most. Every directory expanded reads again on refresh, at a run's end and when the diff
 * comes again (`refreshes` counts these). A changed file has a dot: green when new, orange
 * otherwise. A click opens a file in the preview tab, a double click pins it; a link opens too, to
 * say it is one.
 *
 * @sideEffects Sends `list_dir`; reads and writes the storage; the handlers act.
 * @param props - The client, the workspace and its directory's name, the storage, the changed
 * files, the file selected, how many times to have read again, and what opening a file does.
 * @returns The tab's rows.
 */
export function FilesPart({
  client,
  workspaceId,
  dirName,
  storage,
  changed,
  selected,
  refreshes,
  onOpen,
}: {
  readonly client: AtriumClient;
  readonly workspaceId: string;
  readonly dirName: string;
  readonly storage: PaneStorage;
  readonly changed: readonly DiffFile[];
  readonly selected: string | null;
  readonly refreshes: number;
  readonly onOpen: (path: string, pinned: boolean) => void;
}) {
  const key = keptPathsKey("openDirs", workspaceId, null);
  const [open, setOpen] = useState(() => restoredDirs(keptPaths(storage, key)));
  const { listings, reading, read } = useListings(client, workspaceId);
  const [asked, setAsked] = useState(0);
  // Every directory expanded, read on first showing and again on each refresh asked for.
  const expanded = useRef(open);
  useEffect(() => {
    expanded.current = open;
  });
  useEffect(() => {
    read(["", ...expanded.current]);
    // Read again on each refresh (SPEC-0001, "M1.12 的文件与更改 · 文件").
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above.
  }, [read, refreshes, asked]);
  const dots = new Map(changed.map((file) => [file.path, file.status === "added" ? "var(--ok)" : "var(--attn)"]));

  /**
   * Expands or folds a directory, reading it the first time, and keeps what is expanded.
   *
   * @remarks
   * See `FilesPart`.
   *
   * @sideEffects Updates state; writes the storage; may send `list_dir`.
   * @param path - The directory.
   */
  const toggle = (path: string): void => {
    const next = new Set(open);
    if (!next.delete(path)) next.add(path);
    if (next.has(path) && !listings.has(path)) read([path]);
    keepPaths(storage, key, next);
    setOpen(next);
  };

  /**
   * Folds every directory.
   *
   * @remarks
   * "全部收起".
   *
   * @sideEffects Updates state; writes the storage.
   */
  const foldAll = (): void => {
    keepPaths(storage, key, new Set());
    setOpen(new Set());
  };

  /**
   * The rows of a directory's entries, and those of the directories expanded in it.
   *
   * @remarks
   * See `FilesPart`.
   *
   * @sideEffects none
   * @param dir - The directory.
   * @param depth - How deep its entries are.
   * @returns The rows.
   */
  const rows = (dir: string, depth: number): ReactNode[] => {
    const listing = listings.get(dir);
    if (listing === undefined || listing === "failed") return [];
    const shown = listing.entries.flatMap((entry) => {
      const path = joinPath(dir, entry.name);
      if (entry.kind === "dir") {
        const isOpen = open.has(path);
        return [
          <TreeRow
            key={path}
            depth={depth}
            slot={<TreeArrow expanded={isOpen} loading={isOpen && reading.has(path) && !listings.has(path)} />}
            name={entry.name}
            expanded={isOpen}
            title={path}
            onClick={() => toggle(path)}
          />,
          ...(isOpen ? rows(path, depth + 1) : []),
        ];
      }
      const dot = dots.get(path);
      return [
        <TreeRow
          key={path}
          depth={depth}
          slot={<FileIcon path={entry.name} size={14} />}
          name={entry.name}
          after={
            dot === undefined ? null : (
              <span
                data-testid="changed-dot"
                className="mr-1 size-1.5 flex-none rounded-full"
                style={{ backgroundColor: dot }}
              />
            )
          }
          selected={path === selected}
          title={path}
          onClick={() => onOpen(path, false)}
          onDoubleClick={() => onOpen(path, true)}
        />,
      ];
    });
    return listing.truncated
      ? [
          ...shown,
          <p
            key={`${dir}/…`}
            style={{ paddingLeft: 28 + depth * 12 }}
            className="flex h-7 items-center text-[length:var(--fs-meta)] text-[var(--text-dim)]"
          >
            还有更多，没有列出
          </p>,
        ]
      : shown;
  };

  const top = listings.get("");
  let body: ReactNode;
  if (top === undefined) {
    body = (
      <CenterNote>
        <CircleNotch size={20} className="animate-spin text-[var(--text-dim)]" />
      </CenterNote>
    );
  } else if (top === "failed") {
    body = <CenterNote>读不了这个工作区的文件</CenterNote>;
  } else {
    body = (
      <div aria-label="工作区的文件" className="flex flex-col gap-px px-1.5 pt-0.5 pb-6">
        {rows("", 0)}
      </div>
    );
  }

  return (
    <>
      <div className="flex h-9 flex-none items-center gap-1.5 pr-1.5 pl-3 text-[length:var(--fs-meta)]">
        <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">{dirName}</span>
        <button type="button" aria-label="全部收起" title="全部收起" onClick={foldAll} className={ROW_BUTTON}>
          <ArrowsInLineVertical size={14} />
        </button>
        <button
          type="button"
          aria-label="刷新"
          title="刷新"
          onClick={() => setAsked((count) => count + 1)}
          className={ROW_BUTTON}
        >
          <ArrowClockwise size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="files-tree">
        {body}
      </div>
    </>
  );
}
