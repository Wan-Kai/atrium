import type { DiffMode } from "@atrium/protocol";
import { type StoreApi, createStore } from "zustand/vanilla";
import type { DiffChoice } from "../chat/changes";
import type { PaneStorage } from "./panes";

// What each container shows besides its sessions, in this window only: the viewer tabs, the diff
// mode chosen, and which file the 改动 tab goes to (SPEC-0001, "M1.12 的文件与更改"; domain-model,
// "已决定 19"). The right panel's tab, and what its trees and the 改动 tab fold, outlive a restart
// in the storage given.

/** The right panel's two tabs. */
export type PanelTab = "files" | "changes";

/** A viewer tab: a file, or a workspace's changes all together. */
export type ViewerTab =
  | {
      readonly kind: "file";
      /** Relative to the workspace. */
      readonly path: string;
      /** Opened with a single click: the next file opened so takes its place. */
      readonly preview: boolean;
    }
  | { readonly kind: "diff" };

/** Where a viewer tab was left: its scroll, and whether it wraps long lines. */
export interface ViewerPlace {
  readonly scrollTop: number;
  readonly wrap: boolean;
}

/** A viewer tab not left anywhere yet. */
const NO_PLACE: ViewerPlace = { scrollTop: 0, wrap: false };

/** A one-based, inclusive range in a text file. */
export interface FileLineRange {
  readonly start: number;
  readonly end: number;
}

/** A container's viewer tabs and what goes with them. */
export interface ContainerView {
  /** In the order opened; they come after the session tabs. */
  readonly tabs: readonly ViewerTab[];
  /** The viewer tab shown, by `viewerKey`; `null` while a session is. */
  readonly active: string | null;
  /** The diff mode chosen, shared by the panel's 更改 and the 改动 tab. */
  readonly choice: DiffChoice | null;
  /**
   * The file the 改动 tab was last asked to go to, counted so going to it again goes again, and
   * whether it went: once done, showing the tab again does not.
   */
  readonly reveal: { readonly path: string; readonly count: number; readonly done: boolean } | null;
  /** The latest explicit file-line navigation; a consumed request still identifies its highlight. */
  readonly fileReveal: {
    readonly path: string;
    readonly range: FileLineRange;
    readonly count: number;
    readonly done: boolean;
  } | null;
  /** Where each open viewer tab was left, by `viewerKey`; forgotten as it closes. */
  readonly places: Readonly<Record<string, ViewerPlace>>;
}

/** The workspace views of a window. */
export interface WorkspaceViews {
  /** By container id; a container not here has no viewer tabs yet. */
  readonly containers: Readonly<Record<string, ContainerView>>;
  /** The panel tab chosen in each workspace while this window is open. */
  readonly panelTabs: Readonly<Record<string, PanelTab>>;
  /** The tab each workspace's open panel shows, none having been chosen, while it stays open. */
  readonly panelDefaults: Readonly<Record<string, PanelTab>>;
  readonly storage: PaneStorage;
}

/** A tab in the tab bar's order: a session's, or a viewer's by `viewerKey`. */
export type TabRef =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "viewer"; readonly key: string };

/** A container with nothing open beside its sessions. */
export const NO_VIEW: ContainerView = {
  tabs: [],
  active: null,
  choice: null,
  reveal: null,
  fileReveal: null,
  places: {},
};

/**
 * The key a viewer tab goes by.
 *
 * @remarks
 * One tab per file, and one 改动 tab per workspace (SPEC-0001, "M1.12 的文件与更改 · 查看标签").
 *
 * @sideEffects none
 * @param tab - The tab.
 * @returns Its key.
 */
export function viewerKey(tab: ViewerTab): string {
  return tab.kind === "diff" ? "diff" : `file:${tab.path}`;
}

/**
 * The workspace views, nothing open, remembering in the storage given.
 *
 * @remarks
 * The workbench passes `localStorage`; a conversation area on its own, `memoryStorage()`.
 *
 * @sideEffects none
 * @param storage - Where the panel's tab and the folds are kept.
 * @returns The store.
 */
export function createWorkspaceViews(storage: PaneStorage): StoreApi<WorkspaceViews> {
  return createStore<WorkspaceViews>()(() => ({ containers: {}, panelTabs: {}, panelDefaults: {}, storage }));
}

/**
 * A container's view.
 *
 * @remarks
 * The same object until it changes, so it can be selected from the store.
 *
 * @sideEffects none
 * @param state - The views.
 * @param containerId - The container.
 * @returns Its view.
 */
export function viewOf(state: WorkspaceViews, containerId: string): ContainerView {
  return state.containers[containerId] ?? NO_VIEW;
}

/**
 * Changes a container's view.
 *
 * @remarks
 * Every change below goes through here.
 *
 * @sideEffects Writes the store.
 * @param views - The views.
 * @param containerId - The container.
 * @param change - What its view becomes.
 */
function update(
  views: StoreApi<WorkspaceViews>,
  containerId: string,
  change: (view: ContainerView) => ContainerView,
): void {
  views.setState((state) => ({
    containers: { ...state.containers, [containerId]: change(viewOf(state, containerId)) },
  }));
}

/**
 * Shows a file in a viewer tab.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"): a file already open is shown, and pinned when
 * asked; else a preview tab is replaced in place by another preview, and anything else goes last.
 *
 * @sideEffects Writes the store.
 * @param views - The views.
 * @param containerId - The container.
 * @param path - The file, relative to the workspace.
 * @param pinned - Whether it opens pinned (a double click) rather than as a preview.
 * @param range - An explicit one-shot navigation, separate from remembered scrolling.
 */
export function openFile(
  views: StoreApi<WorkspaceViews>,
  containerId: string,
  path: string,
  pinned: boolean,
  range?: FileLineRange,
): void {
  const key = `file:${path}`;
  update(views, containerId, (view) => {
    const tab: ViewerTab = { kind: "file", path, preview: !pinned };
    const open = view.tabs.find((each) => viewerKey(each) === key);
    // Stryker disable next-line ConditionalExpression: the 改动 tab has no `preview`; the kind is for the type.
    const preview = view.tabs.findIndex((each) => each.kind === "file" && each.preview);
    let tabs: ViewerTab[];
    if (open !== undefined) tabs = view.tabs.map((each) => (each === open && pinned ? tab : each));
    else if (!pinned && preview !== -1) tabs = view.tabs.with(preview, tab);
    else tabs = [...view.tabs, tab];
    return {
      ...view,
      tabs,
      active: key,
      places: placesOf(tabs, view.places),
      fileReveal: range === undefined ? null : { path, range, count: (view.fileReveal?.count ?? 0) + 1, done: false },
    };
  });
}

/** Marks a matching file-line navigation consumed without changing the highlight.
 * @remarks A stale reading must not consume a newer navigation to the same file.
 * @sideEffects Updates the window-local views.
 * @param views - The views.
 * @param containerId - The workspace.
 * @param request - The exact request that was placed, including across close/reopen cycles.
 */
export function fileRevealed(
  views: StoreApi<WorkspaceViews>,
  containerId: string,
  request: NonNullable<ContainerView["fileReveal"]>,
): void {
  update(views, containerId, (view) => ({
    ...view,
    fileReveal: view.fileReveal === request ? { ...request, done: true } : view.fileReveal,
  }));
}

/**
 * Shows the 改动 tab, opening it last when it is not open, and goes to a file in it.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"): from the 更改 tree or a file tab's "查看改动".
 *
 * @sideEffects Writes the store.
 * @param views - The views.
 * @param containerId - The container.
 * @param path - The file to go to, or `null` to stay where it is.
 */
export function openDiff(views: StoreApi<WorkspaceViews>, containerId: string, path: string | null): void {
  update(views, containerId, (view) => ({
    ...view,
    tabs: view.tabs.some((tab) => tab.kind === "diff") ? view.tabs : [...view.tabs, { kind: "diff" }],
    active: "diff",
    reveal: path === null ? view.reveal : { path, count: (view.reveal?.count ?? 0) + 1, done: false },
  }));
}

/**
 * Marks going to a file in the 改动 tab done.
 *
 * @remarks
 * See `ContainerView.reveal`.
 *
 * @sideEffects Writes the store.
 * @param views - The views.
 * @param containerId - The container.
 */
export function revealed(views: StoreApi<WorkspaceViews>, containerId: string): void {
  update(views, containerId, (view) => ({
    ...view,
    reveal: view.reveal === null ? null : { ...view.reveal, done: true },
  }));
}

/**
 * Pins a preview tab, so the next file opened does not take its place.
 *
 * @remarks
 * A double click on the tab, as on its file in the tree.
 *
 * @sideEffects Writes the store.
 * @param views - The views.
 * @param containerId - The container.
 * @param key - The tab's key.
 */
export function pinViewer(views: StoreApi<WorkspaceViews>, containerId: string, key: string): void {
  update(views, containerId, (view) => ({
    ...view,
    tabs: view.tabs.map((tab) => (tab.kind === "file" && viewerKey(tab) === key ? { ...tab, preview: false } : tab)),
  }));
}

/**
 * Shows a viewer tab, or with `null` the container's session.
 *
 * @remarks
 * A key no tab has shows the session.
 *
 * @sideEffects Writes the store.
 * @param views - The views.
 * @param containerId - The container.
 * @param key - The tab's key, or `null`.
 */
export function showViewer(views: StoreApi<WorkspaceViews>, containerId: string, key: string | null): void {
  update(views, containerId, (view) => ({
    ...view,
    active: view.tabs.some((tab) => viewerKey(tab) === key) ? key : null,
  }));
}

/**
 * The container's tabs in the tab bar's order: the sessions', then the viewers'.
 *
 * @remarks
 * ⌘1–9 and ⌘⇧[ ] count them together (SPEC-0001, "M1.12 的文件与更改 · 查看标签").
 *
 * @sideEffects none
 * @param sessions - The open sessions, in the host's order.
 * @param view - The container's view.
 * @returns The tabs.
 */
export function tabOrder(sessions: readonly string[], view: ContainerView): TabRef[] {
  return [
    ...sessions.map((id): TabRef => ({ kind: "session", id })),
    ...view.tabs.map((tab): TabRef => ({ kind: "viewer", key: viewerKey(tab) })),
  ];
}

/**
 * Where the tab shown is in `tabOrder`.
 *
 * @remarks
 * The viewer tab shown, else the active session's.
 *
 * @sideEffects none
 * @param order - The tabs.
 * @param view - The container's view.
 * @param session - The active session, if any.
 * @returns Its index, or -1 when none shows.
 */
export function currentTab(order: readonly TabRef[], view: ContainerView, session: string | null): number {
  return order.findIndex((tab) =>
    tab.kind === "viewer" ? tab.key === view.active : view.active === null && tab.id === session,
  );
}

/**
 * Closes a viewer tab; closing the one shown goes to the tab left of it.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"): to its right where nothing is left of it. Going to
 * a session is the caller's: it is the host's to open.
 *
 * @sideEffects Writes the store.
 * @param views - The views.
 * @param containerId - The container.
 * @param key - The tab's key.
 * @param sessions - The container's open sessions, in the host's order.
 * @returns The session to open, or `null` when a viewer tab, or nothing new, shows.
 */
export function closeViewer(
  views: StoreApi<WorkspaceViews>,
  containerId: string,
  key: string,
  sessions: readonly string[],
): string | null {
  const view = viewOf(views.getState(), containerId);
  const order = tabOrder(sessions, view);
  // Stryker disable next-line ConditionalExpression: a session's tab has no `key`; the kind is for the type.
  const at = order.findIndex((tab) => tab.kind === "viewer" && tab.key === key);
  const next = view.active === key ? (order[at - 1] ?? order[at + 1]) : undefined;
  update(views, containerId, (now) => {
    const tabs = now.tabs.filter((tab) => viewerKey(tab) !== key);
    return {
      ...now,
      tabs,
      active: next === undefined ? (now.active === key ? null : now.active) : next.kind === "viewer" ? next.key : null,
      places: placesOf(tabs, now.places),
      fileReveal: key === `file:${now.fileReveal?.path}` ? null : now.fileReveal,
    };
  });
  return next?.kind === "session" ? next.id : null;
}

/**
 * The places of the tabs still open.
 *
 * @remarks
 * A tab closed, or a preview replaced by another, forgets where it was left (SPEC-0001, "M1.12
 * 的文件与更改 · 查看标签").
 *
 * @sideEffects none
 * @param tabs - The tabs open.
 * @param places - The places kept.
 * @returns Those of the tabs open.
 */
function placesOf(
  tabs: readonly ViewerTab[],
  places: Readonly<Record<string, ViewerPlace>>,
): Readonly<Record<string, ViewerPlace>> {
  const open = new Set(tabs.map(viewerKey));
  return Object.fromEntries(Object.entries(places).filter(([key]) => open.has(key)));
}

/**
 * Where a viewer tab was left.
 *
 * @remarks
 * A tab never left has no scroll and does not wrap.
 *
 * @sideEffects none
 * @param view - The container's view.
 * @param key - The tab's key.
 * @returns Its place.
 */
export function placeOf(view: ContainerView, key: string): ViewerPlace {
  return Object.hasOwn(view.places, key) ? (view.places[key] ?? NO_PLACE) : NO_PLACE;
}

/**
 * Keeps where an open viewer tab is left.
 *
 * @remarks
 * A tab closed meanwhile keeps nothing, as its place was forgotten with it.
 *
 * @sideEffects Writes the store.
 * @param views - The views.
 * @param containerId - The container.
 * @param key - The tab's key.
 * @param change - What changes in its place.
 */
export function keepPlace(
  views: StoreApi<WorkspaceViews>,
  containerId: string,
  key: string,
  change: Partial<ViewerPlace>,
): void {
  if (!viewOf(views.getState(), containerId).tabs.some((tab) => viewerKey(tab) === key)) return;
  update(views, containerId, (view) => ({
    ...view,
    places: { ...view.places, [key]: { ...placeOf(view, key), ...change } },
  }));
}

/**
 * Remembers the diff mode chosen for a container.
 *
 * @remarks
 * See `diffModeOf`.
 *
 * @sideEffects Writes the store.
 * @param views - The views.
 * @param containerId - The container.
 * @param choice - The choice, or `null` to forget it.
 */
export function chooseDiff(views: StoreApi<WorkspaceViews>, containerId: string, choice: DiffChoice | null): void {
  update(views, containerId, (view) => ({ ...view, choice }));
}

/**
 * Where a workspace's panel tab is kept.
 *
 * @remarks
 * See `panelTabOf`.
 *
 * @sideEffects none
 * @param workspaceId - The workspace.
 * @returns The key.
 */
function panelTabKey(workspaceId: string): string {
  return `atrium.panelTab:${workspaceId}`;
}

/**
 * The panel tab a workspace shows.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 右栏"): the one chosen last, kept in the storage; never chosen,
 * 更改 when the workspace had changes as its panel opened and 文件 when not, as Paseo. The open
 * panel holds the one it fell back to (`holdPanelDefault`), so the capsule knows what it shows.
 *
 * @sideEffects Reads the storage.
 * @param state - The views.
 * @param workspaceId - The workspace.
 * @param changed - Whether it has changes, for a panel not holding its tab yet.
 * @returns The tab.
 */
export function panelTabOf(state: WorkspaceViews, workspaceId: string, changed: boolean): PanelTab {
  const chosen = state.panelTabs[workspaceId] ?? state.storage.getItem(panelTabKey(workspaceId));
  if (chosen === "files" || chosen === "changes") return chosen;
  return state.panelDefaults[workspaceId] ?? (changed ? "changes" : "files");
}

/**
 * Holds the tab a workspace's open panel fell back to, or with `null` lets it go.
 *
 * @remarks
 * See `panelTabOf`. The panel lets it go as it closes: opened again, it looks at the changes anew.
 *
 * @sideEffects Writes the store.
 * @param views - The views.
 * @param workspaceId - The workspace.
 * @param tab - The tab, or `null`.
 */
export function holdPanelDefault(views: StoreApi<WorkspaceViews>, workspaceId: string, tab: PanelTab | null): void {
  views.setState((state) => {
    const { [workspaceId]: _held, ...others } = state.panelDefaults;
    return { panelDefaults: tab === null ? others : { ...others, [workspaceId]: tab } };
  });
}

/**
 * Chooses a workspace's panel tab, and keeps the choice.
 *
 * @remarks
 * See `panelTabOf`.
 *
 * @sideEffects Writes the store and the storage.
 * @param views - The views.
 * @param workspaceId - The workspace.
 * @param tab - The tab.
 */
export function choosePanelTab(views: StoreApi<WorkspaceViews>, workspaceId: string, tab: PanelTab): void {
  views.getState().storage.setItem(panelTabKey(workspaceId), tab);
  views.setState((state) => ({ panelTabs: { ...state.panelTabs, [workspaceId]: tab } }));
}

/**
 * Where a set of paths is kept: the files tree's expanded directories, or what the 更改 tree or
 * the 改动 tab folded.
 *
 * @remarks
 * Expanded directories by workspace; folds by workspace and mode (SPEC-0001, "M1.12 的文件与更改").
 *
 * @sideEffects none
 * @param set - Which set.
 * @param workspaceId - The workspace.
 * @param mode - The diff mode, for the folds.
 * @returns The key.
 */
export function keptPathsKey(
  set: "openDirs" | "foldedDirs" | "foldedFiles",
  workspaceId: string,
  mode: DiffMode | null,
): string {
  return mode === null ? `atrium.${set}:${workspaceId}` : `atrium.${set}:${workspaceId}:${mode}`;
}

/**
 * A set of paths kept in the storage.
 *
 * @remarks
 * Anything but an array of strings, as a hand or another version may leave, is none.
 *
 * @sideEffects Reads the storage.
 * @param storage - The storage.
 * @param key - The set's key, from `keptPathsKey`.
 * @returns The paths.
 */
export function keptPaths(storage: PaneStorage, key: string): ReadonlySet<string> {
  try {
    // Stryker disable next-line StringLiteral: an empty text fails to parse, which reads as none too.
    const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((path) => typeof path === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Keeps a set of paths in the storage.
 *
 * @remarks
 * See `keptPaths`.
 *
 * @sideEffects Writes the storage.
 * @param storage - The storage.
 * @param key - The set's key, from `keptPathsKey`.
 * @param paths - The paths.
 */
export function keepPaths(storage: PaneStorage, key: string, paths: ReadonlySet<string>): void {
  storage.setItem(key, JSON.stringify([...paths]));
}
