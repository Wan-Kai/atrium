import type { AtriumClient, ChangesView, DiffView } from "@atrium/client";
import type { DiffMode } from "@atrium/protocol";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { splitPath } from "../chat/changes";
import { FileDiff, Files, X } from "../design/icons";
import {
  type PanelTab,
  type WorkspaceViews,
  chooseDiff,
  choosePanelTab,
  openDiff,
  openFile,
  panelTabOf,
  viewOf,
} from "../state/workspace-views";
import { ChangesPart } from "./changes-part";
import { FilesPart } from "./files-part";
import { useDiffMode, useRunEnds, useShownDiff } from "./use-diff";

/**
 * A count that goes up each time a value comes that is another than the last one that came.
 *
 * @remarks
 * For the diff coming again: the files tree reads again then (SPEC-0001, "M1.12 的文件与更改 ·
 * 文件"). The first to come is not counted, as the tree has just read; nor is `undefined`, while
 * none is there.
 *
 * @sideEffects none
 * @param value - The value, or `undefined` for none.
 * @returns The count, 0 at first.
 */
function useComings(value: unknown): number {
  const [seen, setSeen] = useState({ value, count: 0 });
  // Adjusting state while rendering, as React advises for state that follows other values.
  if (value !== undefined && value !== seen.value)
    setSeen({ value, count: seen.count + Number(seen.value !== undefined) });
  return seen.count;
}

/**
 * Whether the workspace had changes when the panel opened, once that is known.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 右栏"): a workspace that never chose a tab opens at 更改 when
 * it has changes, at 文件 when not; the tab then stays while changes come and go.
 *
 * @sideEffects none
 * @param changes - The workspace's changes, `null` until known.
 * @returns Whether it had changes; `false` until known.
 */
function useOpenedChanged(changes: ChangesView): boolean {
  const known = changes === null ? null : changes.stat !== null;
  const [opened, setOpened] = useState(known);
  // Adjusting state while rendering, as React advises for state that follows other values.
  if (opened === null && known !== null) setOpened(known);
  return opened ?? false;
}

/**
 * One of the panel's two tabs.
 *
 * @remarks
 * design-language ("右栏（文件与更改）"): 28px high, a 14px icon, `--selected` when chosen.
 *
 * @sideEffects none; clicking calls `onChoose`.
 * @param props - What it shows, whether it is chosen, and what choosing does.
 * @returns The tab.
 */
function PanelTabButton({
  icon,
  label,
  count,
  chosen,
  onChoose,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly count: number | null;
  readonly chosen: boolean;
  readonly onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={chosen}
      onClick={onChoose}
      className="flex h-7 items-center gap-1.5 rounded-[var(--r)] pr-2 pl-2.5 text-[length:var(--fs-meta)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)] aria-selected:bg-[var(--selected)] aria-selected:text-[var(--text)]"
    >
      {icon}
      {label}
      {count === null ? null : (
        <span className="text-[length:var(--fs-xs)] text-[var(--text-dim)] tabular-nums">{count}</span>
      )}
    </button>
  );
}

/**
 * The right panel: the workspace's files and its changes, as trees.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 右栏"), as Paseo's: two tabs, the one chosen kept by workspace,
 * and a close button. What a tree opens shows in a viewer tab. The conversation area watches the
 * diff (`useDiffWatch`); while the panel closes, it is no longer watched and the panel keeps
 * showing the last one it had. Esc inside the panel closes it.
 *
 * @sideEffects Subscribes to the client and the views; through its tabs, reads directories and
 * reads and writes the views' storage; may ask for the diff again.
 * @param props - The client, the workspace, the workspace views, and how to close.
 * @returns The panel.
 */
export function RightPanel({
  client,
  workspaceId,
  views,
  onClose,
}: {
  readonly client: AtriumClient;
  readonly workspaceId: string;
  readonly views: StoreApi<WorkspaceViews>;
  readonly onClose: () => void;
}) {
  const changes = useStore(client.changes(workspaceId));
  const mode = useDiffMode(client, views, workspaceId);
  const changed = useOpenedChanged(changes);
  const tab = useStore(views, (state) => panelTabOf(state, workspaceId, changed));
  const view = useStore(views, (state) => viewOf(state, workspaceId));
  const storage = useStore(views, (state) => state.storage);
  const dir = useStore(client.index, (index) => index.workspaces.find((one) => one.id === workspaceId)?.dir ?? "");
  const live = useShownDiff(client, workspaceId, mode);
  const watching = useStore(client.diff, (diff) => diff.target !== null);
  const [kept, setKept] = useState<DiffView | null>(live);
  // Adjusting state while rendering, as React advises for state that follows other values.
  if (live !== null && live !== kept) setKept(live);
  const shown = live ?? (watching ? null : kept);
  const files = shown?.status === "ready" && shown.error === null && !shown.tooLarge ? shown.files : [];
  const refreshes = useRunEnds(client, workspaceId) + useComings(live?.status === "ready" ? live.files : undefined);

  /**
   * Chooses a mode for the panel and the 改动 tab.
   *
   * @remarks
   * See `diffModeOf`.
   *
   * @sideEffects Writes the views.
   * @param next - The mode.
   */
  const chooseMode = (next: DiffMode): void =>
    chooseDiff(views, workspaceId, { mode: next, dirty: changes?.dirty ?? false });

  /**
   * Chooses a tab, kept for the workspace.
   *
   * @remarks
   * See `panelTabOf`.
   *
   * @sideEffects Writes the views and their storage.
   * @param next - The tab.
   */
  const chooseTab = (next: PanelTab): void => choosePanelTab(views, workspaceId, next);

  /**
   * Closes the panel on Esc while the focus is in it.
   *
   * @remarks
   * Esc in the input box still stops a run.
   *
   * @sideEffects May close the panel.
   * @param event - The key.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  };

  return (
    <aside
      aria-label="文件与更改"
      onKeyDown={onKeyDown}
      className="flex min-w-0 flex-1 flex-col border-l-[0.5px] border-[var(--line)] bg-[var(--surface-1)]"
    >
      <header className="flex h-11 flex-none items-center gap-0.5 border-b-[0.5px] border-[var(--line)] px-2">
        <div role="tablist" aria-label="右栏" className="flex items-center gap-0.5">
          <PanelTabButton
            icon={<Files size={14} />}
            label="文件"
            count={null}
            chosen={tab === "files"}
            onChoose={() => chooseTab("files")}
          />
          <PanelTabButton
            icon={<FileDiff size={14} />}
            label="更改"
            count={files.length === 0 ? null : files.length}
            chosen={tab === "changes"}
            onChoose={() => chooseTab("changes")}
          />
        </div>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="关闭右栏"
          title="关闭"
          onClick={onClose}
          className="inline-flex size-7 items-center justify-center rounded-[var(--r)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
        >
          <X size={14} />
        </button>
      </header>
      {tab === "changes" ? (
        <ChangesPart
          key={mode}
          workspaceId={workspaceId}
          mode={mode}
          changes={changes}
          shown={shown}
          selected={view.active === "diff" ? (view.reveal?.path ?? null) : null}
          storage={storage}
          onChoose={chooseMode}
          onRefresh={() => {
            // Fire and forget: the answer lands in the client's diff.
            client.watchDiff({ workspaceId, mode }).catch(() => undefined);
          }}
          onOpen={(path) => openDiff(views, workspaceId, path)}
        />
      ) : (
        <FilesPart
          client={client}
          workspaceId={workspaceId}
          dirName={splitPath(dir).name}
          storage={storage}
          changed={files}
          selected={view.active?.startsWith("file:") ? view.active.slice("file:".length) : null}
          refreshes={refreshes}
          onOpen={(path, pinned) => openFile(views, workspaceId, path, pinned)}
        />
      )}
    </aside>
  );
}
