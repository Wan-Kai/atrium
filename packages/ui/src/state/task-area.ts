import { type StoreApi, createStore } from "zustand/vanilla";

// The task area: whether the main area shows it, which of its tabs is on top, which task tabs are open, and what the
// list shows (SPEC-0006, "界面"). Kept for the window's life; the tabs are not remembered across launches, since a
// task closed here goes on in the host.

/** The task area's state and what changes it. */
export interface TaskArea {
  /** Whether the main area shows the task area instead of the conversations. */
  readonly open: boolean;
  /** The tab on top: `list`, `schedules`, or the id of an open task. */
  readonly active: string;
  /** The open task tabs, in the order they were opened. */
  readonly tabs: readonly string[];
  /** The list's project filter: `null` for all, `NO_PROJECT`, or a project's id. */
  readonly filter: string | null;
  /** Whether the finished tasks beyond the recent ones show. */
  readonly showAll: boolean;
  readonly show: () => void;
  readonly hide: () => void;
  /** Brings a tab to the top. */
  readonly activate: (tab: string) => void;
  /** Opens a task's tab, or brings it up if it is open, and shows the area. */
  readonly openTask: (taskId: string) => void;
  /** Opens a node's conversation as a tab right of its task's tab (and the task's tab, if it is not open). */
  readonly openNode: (taskId: string, node: string) => void;
  /** Closes a task's tab (and its nodes' tabs); the one before it comes up if it was on top. */
  readonly closeTask: (taskId: string) => void;
  readonly setFilter: (filter: string | null) => void;
  readonly setShowAll: (showAll: boolean) => void;
}

/**
 * The id of a node conversation's tab: the task's id, a `#`, the node's id.
 *
 * @remarks
 * A node's tab belongs to the task tab on its left (SPEC-0006, "节点对话"; 设计稿第 8 屏 A), so the ids carry the
 * task, and closing the task closes them.
 *
 * @sideEffects none
 * @param taskId - The task.
 * @param node - The node.
 * @returns The tab's id.
 */
export function nodeTabId(taskId: string, node: string): string {
  return `${taskId}#${node}`;
}

/**
 * The task and node a node tab's id names, or `null` for any other tab.
 *
 * @remarks
 * Task ids are `tsk_` and a hex run and node ids are short names, neither holds a `#`.
 *
 * @sideEffects none
 * @param tab - The tab's id.
 * @returns The task and the node.
 */
export function parseNodeTab(tab: string): { readonly taskId: string; readonly node: string } | null {
  const at = tab.indexOf("#");
  return at === -1 ? null : { taskId: tab.slice(0, at), node: tab.slice(at + 1) };
}

/**
 * Makes the task area's state.
 *
 * @remarks
 * Closed, on the list, with no task tab open.
 *
 * @sideEffects none
 * @returns The store.
 */
export function createTaskArea(): StoreApi<TaskArea> {
  return createStore<TaskArea>((set) => ({
    open: false,
    active: "list",
    tabs: [],
    filter: null,
    showAll: false,
    show: () => set({ open: true }),
    hide: () => set({ open: false }),
    activate: (tab) => set({ active: tab }),
    openTask: (taskId) =>
      set((state) => ({
        open: true,
        active: taskId,
        tabs: state.tabs.includes(taskId) ? state.tabs : [...state.tabs, taskId],
      })),
    openNode: (taskId, node) =>
      set((state) => {
        const id = nodeTabId(taskId, node);
        if (state.tabs.includes(id)) return { open: true, active: id };
        const base = state.tabs.includes(taskId) ? state.tabs : [...state.tabs, taskId];
        // Right after the task's tab and the node tabs it already has.
        let at = base.indexOf(taskId) + 1;
        while (parseNodeTab(base[at] ?? "")?.taskId === taskId) at += 1;
        return { open: true, active: id, tabs: [...base.slice(0, at), id, ...base.slice(at)] };
      }),
    closeTask: (taskId) =>
      set((state) => {
        const at = state.tabs.indexOf(taskId);
        if (at === -1) return state;
        // A node's tab belongs to its task's: they go together. Closing a node's tab goes back to its task's.
        const node = parseNodeTab(taskId);
        const gone = new Set([taskId, ...state.tabs.filter((tab) => parseNodeTab(tab)?.taskId === taskId)]);
        const tabs = state.tabs.filter((tab) => !gone.has(tab));
        if (state.active !== taskId && !gone.has(state.active)) return { tabs };
        return { tabs, active: node === null ? (tabs[at - 1] ?? "list") : node.taskId };
      }),
    setFilter: (filter) => set({ filter }),
    setShowAll: (showAll) => set({ showAll }),
  }));
}
