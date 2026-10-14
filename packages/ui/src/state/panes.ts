import { type StoreApi, createStore } from "zustand/vanilla";

// The sidebar folded or not, and the right panel open or not and how wide, remembered in this
// browser profile for every workspace (SPEC-0001, "界面 · 左栏折叠与右栏", "M1.12 的文件与更改").

/** The right panel's widths in pixels, and a key's step (SPEC-0001, "M1.12 的文件与更改"). */
export const PANEL_WIDTH = { usual: 320, least: 240, step: 16 } as const;

/** The least the conversation keeps beside the changes panel, in pixels. */
const CHAT_LEAST = 440;

const SIDEBAR_KEY = "atrium.sidebarCollapsed";
const PANEL_OPEN_KEY = "atrium.changesOpen";
// A new key since M1.12: the width kept before, mostly the old usual 560px, is not carried over.
const PANEL_WIDTH_KEY = "atrium.rightPanelWidth";

/** The part of `localStorage` the panes use. */
export type PaneStorage = Pick<Storage, "getItem" | "setItem">;

/** The panes' state and what changes it. */
export interface Panes {
  readonly sidebarCollapsed: boolean;
  readonly panelOpen: boolean;
  /** The width chosen; shown narrower while the window has no room for it (`fitPanelWidth`). */
  readonly panelWidth: number;
  readonly toggleSidebar: () => void;
  readonly setPanelOpen: (open: boolean) => void;
  /** Chooses a width, writing it down unless `keep` is false, as while a drag passes through it. */
  readonly setPanelWidth: (width: number, keep?: boolean) => void;
}

/**
 * The width the right panel shows at, given the room it and the conversation share.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改"): at least 240px; at most what leaves the conversation 440px. With too
 * little room for both, the panel keeps its least and the conversation narrows.
 *
 * @sideEffects none
 * @param width - The width wanted.
 * @param room - The width of the panel and the conversation together.
 * @returns The width, whole pixels.
 */
export function fitPanelWidth(width: number, room: number): number {
  return Math.max(PANEL_WIDTH.least, Math.min(Math.round(width), room - CHAT_LEAST));
}

/**
 * The right panel's CSS width, as `fitPanelWidth` fits it, for an element whose containing
 * block is the room.
 *
 * @remarks
 * Written in CSS, the width follows the window as it is resized, and is right from the first
 * frame, before anything is measured.
 *
 * @sideEffects none
 * @param width - The width wanted.
 * @returns The CSS value.
 */
export function panelWidthCss(width: number): string {
  return `max(${PANEL_WIDTH.least}px, min(${Math.round(width)}px, 100% - ${CHAT_LEAST}px))`;
}

/**
 * A stored width, or the usual one.
 *
 * @remarks
 * A value missing, not a number, or narrower than the least, as an older version or a hand may
 * leave, counts as none.
 *
 * @sideEffects none
 * @param value - The stored value.
 * @returns The width.
 */
function storedWidth(value: string | null): number {
  const width = Number(value);
  return Number.isFinite(width) && width >= PANEL_WIDTH.least ? Math.round(width) : PANEL_WIDTH.usual;
}

/**
 * The panes, read from and written to the storage given.
 *
 * @remarks
 * The workbench passes `localStorage`, so the choices outlive a restart; a conversation area on
 * its own passes `memoryStorage()`.
 *
 * @sideEffects Reads the storage; its setters write it.
 * @param storage - Where the choices are kept.
 * @returns The store.
 */
export function createPanes(storage: PaneStorage): StoreApi<Panes> {
  return createStore<Panes>()((set, get) => ({
    sidebarCollapsed: storage.getItem(SIDEBAR_KEY) === "true",
    panelOpen: storage.getItem(PANEL_OPEN_KEY) === "true",
    panelWidth: storedWidth(storage.getItem(PANEL_WIDTH_KEY)),
    toggleSidebar: () => {
      const collapsed = !get().sidebarCollapsed;
      storage.setItem(SIDEBAR_KEY, String(collapsed));
      set({ sidebarCollapsed: collapsed });
    },
    setPanelOpen: (open) => {
      storage.setItem(PANEL_OPEN_KEY, String(open));
      set({ panelOpen: open });
    },
    setPanelWidth: (width, keep = true) => {
      if (keep) storage.setItem(PANEL_WIDTH_KEY, String(width));
      set({ panelWidth: width });
    },
  }));
}

/**
 * A storage that keeps its values in memory only.
 *
 * @remarks
 * For panes nothing should outlive: a conversation area shown on its own.
 *
 * @sideEffects none
 * @returns The storage.
 */
export function memoryStorage(): PaneStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
