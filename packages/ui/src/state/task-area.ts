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
  /** Closes a task's tab; the one before it comes up if it was on top. */
  readonly closeTask: (taskId: string) => void;
  readonly setFilter: (filter: string | null) => void;
  readonly setShowAll: (showAll: boolean) => void;
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
    closeTask: (taskId) =>
      set((state) => {
        const at = state.tabs.indexOf(taskId);
        if (at === -1) return state;
        const tabs = state.tabs.filter((tab) => tab !== taskId);
        return { tabs, active: state.active === taskId ? (tabs[at - 1] ?? "list") : state.active };
      }),
    setFilter: (filter) => set({ filter }),
    setShowAll: (showAll) => set({ showAll }),
  }));
}
