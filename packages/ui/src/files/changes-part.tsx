import type { ChangesView, DiffView } from "@atrium/client";
import type { DiffMode } from "@atrium/protocol";
import { type ReactNode, useState } from "react";
import { diffTotals } from "../chat/changes";
import { ArrowClockwise } from "../design/icons";
import type { PaneStorage } from "../state/panes";
import { keepPaths, keptPaths, keptPathsKey } from "../state/workspace-views";
import { DiffCounts, ModeMenu, StatusIcon, diffNote } from "./diff-parts";
import { FileIcon } from "./file-icon";
import { TreeArrow, TreeRow } from "./tree-row";
import { type ChangeNode, changeTree } from "./trees";

/** A small icon button on a panel's second row (design-language, "右栏（文件与更改）"). */
export const ROW_BUTTON =
  "inline-flex size-[26px] flex-none items-center justify-center rounded-[var(--r)] text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)]";

/**
 * The right panel's 更改 tab: the mode, the totals and refresh, then the changed files as a tree.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 更改"). The diff itself shows in the 改动 tab: a file's row goes
 * there, and is selected while the tab shows it. A directory's row folds; what is folded is kept
 * by workspace and mode, so the parent keys this part by mode.
 *
 * @sideEffects Reads and writes the storage; the handlers act.
 * @param props - The workspace, the mode, its changes and the diff shown, the file selected, the
 * storage, and what choosing a mode, refreshing and opening a file do.
 * @returns The tab's rows.
 */
export function ChangesPart({
  workspaceId,
  mode,
  changes,
  shown,
  selected,
  storage,
  onChoose,
  onRefresh,
  onOpen,
}: {
  readonly workspaceId: string;
  readonly mode: DiffMode;
  readonly changes: ChangesView;
  readonly shown: DiffView | null;
  readonly selected: string | null;
  readonly storage: PaneStorage;
  readonly onChoose: (mode: DiffMode) => void;
  readonly onRefresh: () => void;
  readonly onOpen: (path: string) => void;
}) {
  const key = keptPathsKey("foldedDirs", workspaceId, mode);
  const [folded, setFolded] = useState(() => keptPaths(storage, key));
  const note = diffNote(shown, mode, changes, onChoose);
  const files = note === null && shown !== null ? shown.files : [];

  /**
   * Folds or unfolds a directory, and keeps what is folded.
   *
   * @remarks
   * See `ChangesPart`.
   *
   * @sideEffects Updates state; writes the storage.
   * @param path - The directory.
   */
  const fold = (path: string): void => {
    const next = new Set(folded);
    if (!next.delete(path)) next.add(path);
    keepPaths(storage, key, next);
    setFolded(next);
  };

  /**
   * The rows of a level of the tree, and those of the directories expanded in it.
   *
   * @remarks
   * See `ChangesPart`.
   *
   * @sideEffects none
   * @param nodes - The level's nodes.
   * @param depth - How deep it is.
   * @returns The rows.
   */
  const rows = (nodes: readonly ChangeNode[], depth: number): ReactNode[] =>
    nodes.flatMap((node) => {
      if (node.kind === "dir") {
        const open = !folded.has(node.path);
        return [
          <TreeRow
            key={`d:${node.path}`}
            depth={depth}
            slot={<TreeArrow expanded={open} />}
            name={node.name}
            after={
              <span className="opacity-75">
                <DiffCounts added={node.added} removed={node.removed} />
              </span>
            }
            expanded={open}
            title={node.path}
            onClick={() => fold(node.path)}
          />,
          ...(open ? rows(node.children, depth + 1) : []),
        ];
      }
      const { file } = node;
      return [
        <TreeRow
          key={`f:${file.path}`}
          depth={depth}
          slot={<FileIcon path={file.path} size={14} />}
          name={
            <span className={file.status === "deleted" ? "line-through decoration-[var(--text-dim)]" : undefined}>
              {node.name}
            </span>
          }
          after={
            <>
              <DiffCounts added={file.added} removed={file.removed} />
              <StatusIcon status={file.status} />
            </>
          }
          selected={file.path === selected}
          title={file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`}
          onClick={() => onOpen(file.path)}
        />,
      ];
    });

  return (
    <>
      <div className="flex h-9 flex-none items-center gap-1.5 pr-1.5 pl-3 text-[length:var(--fs-meta)]">
        <ModeMenu mode={mode} changes={changes} onChoose={onChoose} />
        {files.length === 0 ? null : <DiffCounts {...diffTotals(files)} />}
        <span className="flex-1" />
        <button type="button" aria-label="刷新" title="刷新" onClick={onRefresh} className={ROW_BUTTON}>
          <ArrowClockwise size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="changes-tree">
        {note ?? (
          <div aria-label="改了的文件" className="flex flex-col gap-px px-1.5 pt-0.5 pb-6">
            {rows(changeTree(files), 0)}
          </div>
        )}
      </div>
    </>
  );
}
