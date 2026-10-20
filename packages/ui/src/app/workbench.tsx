import { type AtriumClient, type IndexView, isChatId } from "@atrium/client";
import type { Appearance, IndexFileName } from "@atrium/protocol";
import { SidebarLeft, X } from "../design/icons";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { pageDrafts } from "../state/use-draft";
import { useStore } from "zustand";
import { ConversationArea } from "../chat/conversation-area";
import { OpenLogin } from "../chat/turn-view";
import { applyAppearance } from "../design/appearance";
import { DotSeedContext } from "../design/dots";
import { type SettingsSection, SettingsPanel } from "../settings/settings-panel";
import { FirstLaunch, type FirstLaunchStart, firstLaunchStart } from "../setup/first-launch";
import { useInstallSeed } from "../state/install-seed";
import { type Panes, createPanes } from "../state/panes";
import { Sidebar } from "../sidebar/sidebar";
import { type NewWorkspaceState, closePage, createNewWorkspaceStore, openPage } from "../state/new-workspace";
import { TabBar } from "../tabs/tab-bar";
import { Breadcrumb } from "../children/breadcrumb";
import { NewChildDialog } from "../children/new-child-dialog";
import {
  type WorkspaceViews,
  closeViewer,
  createWorkspaceViews,
  currentTab,
  showViewer,
  tabOrder,
  viewOf,
} from "../state/workspace-views";
import { NewWorkspacePage } from "./new-workspace-page";
import type { StoreApi } from "zustand";

/** What the user calls each index file in the reset notice. */
const FILE_NAMES: Readonly<Record<IndexFileName, string>> = {
  projects: "项目列表",
  chats: "对话名称",
  sessions: "会话记录",
  layouts: "标签页",
  preferences: "偏好设置",
};

/**
 * The open session of the client's current container.
 *
 * @remarks
 * `null` when the client is nowhere or the container has no open tab.
 *
 * @sideEffects none
 * @param index - The list.
 * @returns The active session's id.
 */
function activeSession(index: IndexView): string | null {
  const container = index.layout.container;
  return container === null ? null : (index.layout.tabs[container]?.active ?? null);
}

/**
 * Creates a session where the client is, in a workspace or a chat, or a chat when it is nowhere.
 *
 * @remarks
 * The host opens it as the active tab. Reads where the client is at the moment it is called
 * (SPEC-0001, "对话").
 *
 * @sideEffects Sends `create_session` or `create_chat`.
 * @param client - The client.
 * @returns The new session's id.
 */
async function createHere(client: AtriumClient): Promise<string> {
  const where = client.index.getState().layout.container;
  const created = where === null ? await client.createChat() : await client.createSession(where);
  return created.sessionId;
}

/**
 * Starts a command without waiting for it.
 *
 * @remarks
 * Its failure shows where it matters: an empty area explains on the next send.
 *
 * @sideEffects Runs the command.
 * @param command - The command.
 */
function fireAndForget(command: Promise<unknown>): void {
  // Fire and forget: see above.
  void command.catch(() => undefined);
}

/**
 * Handles the app's keyboard shortcuts.
 *
 * @remarks
 * SPEC-0001 ("标签栏", roadmap M1.5): ⌘N new chat, ⌘T new session where the client is, ⌘W close
 * the tab, ⌘1–9 go to a tab, ⌘⇧[ and ⌘⇧] the previous and next tab. Brackets are matched by
 * key position, since Shift changes the character. The keys read the list at the moment they
 * are pressed. Viewer tabs count with the sessions', after them (SPEC-0001, "M1.12 的文件与更改 ·
 * 查看标签"). On the new-workspace page, ⌘N and ⌘T leave it, and the keys for tabs do nothing,
 * as it has none (SPEC-0001, "M1.11 的新建工作区").
 *
 * @sideEffects Listens for keys on the window while mounted; sends commands; writes the views;
 * may leave the page.
 * @param client - The client.
 * @param pages - The new-workspace page's store.
 * @param views - The workspace views.
 */
function useTabShortcuts(
  client: AtriumClient,
  pages: StoreApi<NewWorkspaceState>,
  views: StoreApi<WorkspaceViews>,
): void {
  useEffect(() => {
    /**
     * Acts on a ⌘ shortcut.
     *
     * @remarks
     * See `useTabShortcuts`.
     *
     * @sideEffects May send commands; stops the browser's own handling of the key.
     * @param event - The key event.
     */
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const index = client.index.getState();
      const container = index.layout.container;
      const tabs = container === null ? undefined : index.layout.tabs[container];
      const open = tabs?.open ?? [];
      const view = container === null ? null : viewOf(views.getState(), container);
      const order = view === null ? [] : tabOrder(open, view);
      const at = view === null ? -1 : currentTab(order, view, tabs?.active ?? null);
      const key = event.key.toLowerCase();
      const onPage = pages.getState().page !== null;
      let target: (typeof order)[number] | undefined;
      let closing: string | null = null;
      if (!event.shiftKey && (key === "n" || key === "t")) closePage(pages);
      if (!event.shiftKey && key === "n") fireAndForget(client.createChat());
      else if (!event.shiftKey && key === "t") fireAndForget(createHere(client));
      else if (onPage) return;
      else if (!event.shiftKey && key === "w" && container !== null && view?.active != null)
        closing = closeViewer(views, container, view.active, open);
      else if (!event.shiftKey && key === "w" && tabs?.active != null) fireAndForget(client.closeTab(tabs.active));
      else if (!event.shiftKey && /^[1-9]$/.test(event.key)) target = order[Number(event.key) - 1];
      else if (event.shiftKey && event.code === "BracketLeft") target = order[at - 1];
      else if (event.shiftKey && event.code === "BracketRight") target = order[at + 1];
      else return;
      if (closing !== null) fireAndForget(client.openSession(closing));
      if (target !== undefined && container !== null) {
        showViewer(views, container, target.kind === "viewer" ? target.key : null);
        if (target.kind === "session") fireAndForget(client.openSession(target.id));
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client, pages, views]);
}

/**
 * Shows the session again whenever the container's active session changes under a viewer tab.
 *
 * @remarks
 * The host makes a session active when one is created (⌘T, "+") or opened; it should then show,
 * not stay behind the viewer tab. A session chosen in the sidebar or "历史" is shown by the choice
 * itself, even the one already active. Going to another container keeps each container's viewer
 * tab as it was (SPEC-0001, "M1.12 的文件与更改 · 查看标签"). Done before the page paints, so the
 * viewer tab does not flash first.
 *
 * @sideEffects Writes the views.
 * @param views - The workspace views.
 * @param container - The current container.
 * @param sessionId - Its active session.
 */
function useSessionShows(views: StoreApi<WorkspaceViews>, container: string | null, sessionId: string | null): void {
  const seen = useRef({ container, sessionId });
  useLayoutEffect(() => {
    const before = seen.current;
    seen.current = { container, sessionId };
    if (before.container === container && before.sessionId !== sessionId && container !== null && sessionId !== null)
      showViewer(views, container, null);
  }, [views, container, sessionId]);
}

/**
 * Handles the panes' keyboard shortcuts: ⌘B folds or unfolds the sidebar, ⌥⌘B opens or closes the
 * changes panel.
 *
 * @remarks
 * SPEC-0001 ("界面 · 左栏折叠与右栏"). Keys are matched by position, as ⌥ changes the character.
 * The panel's key does nothing where there is no panel: in a chat, nowhere, or on the
 * new-workspace page.
 *
 * @sideEffects Listens for keys on the window while mounted; writes the panes.
 * @param client - The client.
 * @param pages - The new-workspace page's store.
 * @param panes - The panes.
 */
function usePaneShortcuts(client: AtriumClient, pages: StoreApi<NewWorkspaceState>, panes: StoreApi<Panes>): void {
  useEffect(() => {
    /**
     * Acts on ⌘B or ⌥⌘B.
     *
     * @remarks
     * See `usePaneShortcuts`.
     *
     * @sideEffects May write the panes; stops the browser's own handling of the key.
     * @param event - The key event.
     */
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.shiftKey || event.code !== "KeyB") return;
      event.preventDefault();
      const state = panes.getState();
      if (!event.altKey) state.toggleSidebar();
      else if (hasPanel(client.index.getState().layout.container, pages)) state.setPanelOpen(!state.panelOpen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client, pages, panes]);
}

/**
 * Whether the changes panel can show: in a workspace, off the new-workspace page.
 *
 * @remarks
 * See `usePaneShortcuts`.
 *
 * @sideEffects none
 * @param container - Where the client is.
 * @param pages - The new-workspace page's store.
 * @returns Whether it can.
 */
function hasPanel(container: string | null, pages: StoreApi<NewWorkspaceState>): boolean {
  return container !== null && !isChatId(container) && pages.getState().page === null;
}

/**
 * The sidebar's toggle: at the sidebar's top right, beside the traffic lights once it is folded.
 *
 * @remarks
 * design-language ("侧栏 · 折叠开关", "动效 · 左栏折叠展开"): one button over both places, moving
 * between them as the sidebar folds, so it stays at hand; the window can still be dragged around it.
 * It must come after the sidebar's and the tab bar's drag areas in the page: Electron lays drag
 * areas over one another in page order, so a later `drag` would take its presses.
 *
 * @sideEffects Subscribes to the panes; folds or unfolds the sidebar when clicked.
 * @param props - The panes.
 * @returns The toggle.
 */
function SidebarToggle({ panes }: { readonly panes: StoreApi<Panes> }) {
  const folded = useStore(panes, (state) => state.sidebarCollapsed);
  const toggle = useStore(panes, (state) => state.toggleSidebar);
  const label = folded ? "展开侧栏" : "折叠侧栏";
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={!folded}
      title={`${label}（⌘B）`}
      onClick={toggle}
      className={`absolute top-2.5 z-10 inline-flex size-7 items-center justify-center rounded-[var(--r)] text-[var(--text-muted)] [transition:left_240ms_cubic-bezier(.2,.8,.2,1)] hover:bg-[var(--hover)] hover:text-[var(--text-2)] [-webkit-app-region:no-drag] ${folded ? "left-[84px]" : "left-[226px]"}`}
    >
      <SidebarLeft size={16} />
    </button>
  );
}

/** Where the settings' last part shown is remembered in this browser profile (SPEC-0001, "设置"). */
const SECTION_KEY = "atrium.settings.section";

/** The settings' parts a stored value may name. */
const SECTIONS: readonly SettingsSection[] = ["appearance", "accounts", "projects", "pi", "about"];

/**
 * The settings' part shown last time, or the first.
 *
 * @remarks
 * The settings open on the part looked at last (SPEC-0001, "设置"). A value from an older or
 * newer version that names no part counts as none.
 *
 * @sideEffects Reads `localStorage`.
 * @returns The part.
 */
function lastSection(): SettingsSection {
  const stored = localStorage.getItem(SECTION_KEY);
  return SECTIONS.find((section) => section === stored) ?? "appearance";
}

/**
 * Whether the settings are open, which part they show, and ⌘, to open and close them.
 *
 * @remarks
 * SPEC-0001 ("设置"). The part is remembered across openings and reloads; closing goes back to
 * where the user was, since nothing else changed.
 *
 * @sideEffects Listens for keys on the window while mounted; writes `localStorage` when the part
 * changes.
 * @returns Whether open, the part, and what opening, closing and choosing a part do.
 */
function useSettings(): {
  readonly open: boolean;
  readonly section: SettingsSection;
  readonly show: () => void;
  readonly close: () => void;
  readonly choose: (section: SettingsSection) => void;
} {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState(lastSection);
  useEffect(() => {
    /**
     * Opens or closes the settings on ⌘,.
     *
     * @remarks
     * See `useSettings`.
     *
     * @sideEffects Sets component state; stops the browser's own handling of the key.
     * @param event - The key event.
     */
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key !== ",") return;
      setOpen((was) => !was);
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const choose = useCallback((next: SettingsSection) => {
    setSection(next);
    localStorage.setItem(SECTION_KEY, next);
  }, []);
  return { open, section, show, close, choose };
}

/**
 * Drops the drafts of sessions that went away.
 *
 * @remarks
 * An archived session's draft goes at once; a session gone from the list goes once it leaves
 * a list it was in, within one host run. A new host's first list may not hold every session yet,
 * so nothing is dropped for being missing from it (SPEC-0001, "模型与输入框").
 *
 * @sideEffects Removes drafts from the page's storage.
 * @param index - The list.
 */
function useDraftCleanup(index: IndexView): void {
  const seen = useRef<{ readonly generation: string; readonly sessions: ReadonlySet<string> } | null>(null);
  useEffect(() => {
    if (!index.ready) return;
    const live = new Set(index.sessions.filter((one) => !one.archived).map((one) => one.sessionId));
    const before = seen.current?.generation === index.generation ? seen.current.sessions : new Set<string>();
    const gone = [...before].filter((id) => !live.has(id));
    const archived = index.sessions.filter((one) => one.archived).map((one) => one.sessionId);
    pageDrafts().drop([...gone, ...archived]);
    seen.current = { generation: index.generation, sessions: live };
  }, [index.ready, index.generation, index.sessions]);
}

/**
 * Marks the error of the session shown as seen while the window has the focus.
 *
 * @remarks
 * SPEC-0001 ("会话状态"): the session is the current container's active tab with no viewer tab
 * over it, the window has the focus, and its error was not seen yet; looked at again when the
 * window gains the focus. A sign-in problem is not marked: it goes once a run starts.
 *
 * @sideEffects Sends `clear_attention`; listens for focus on the window while there is an error
 * to mark.
 * @param client - The client.
 * @param index - The list.
 * @param sessionId - The session shown, if any.
 */
function useSeenErrors(client: AtriumClient, index: IndexView, sessionId: string | null): void {
  const attention = index.sessions.find((one) => one.sessionId === sessionId)?.attention ?? null;
  const unseen = attention?.reason === "error" && !attention.cleared;
  useEffect(() => {
    if (sessionId === null || !unseen) return undefined;
    /**
     * Marks the error seen.
     *
     * @remarks
     * See `useSeenErrors`.
     *
     * @sideEffects Sends `clear_attention`.
     */
    const seen = (): void => fireAndForget(client.clearAttention(sessionId));
    if (document.hasFocus()) seen();
    window.addEventListener("focus", seen);
    return () => window.removeEventListener("focus", seen);
  }, [client, sessionId, unseen]);
}

/**
 * The window once connected: first launch when it shows, the main window otherwise.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 什么时候显示"): first launch shows while `setupDone` is false, and later
 * while pi cannot be used; once it shows it stays until finished, even if pi turns ready on its
 * way. Nothing shows until the host's first list says which. What first launch checks is asked
 * for here, also for the sidebar's and the settings' blue dot, each time the connection is up:
 * the workbench shows before the host's welcome, when asking would fail, and things may have
 * changed while it was down. The client asks again when it may have changed otherwise. The appearance follows the user's choice in both, also in the window's own
 * parts through `setNativeAppearance`.
 *
 * @sideEffects Subscribes to the client's connection, list and setup; sets the page's appearance; asks for
 * what first launch checks; through what it shows, listens for keys and sends commands.
 * @param props - The client, the connection status line, how to choose a folder, how to set the
 * window's own appearance, how to open an address, how to show a path in the Finder, how to read a
 * dropped file's path, and how to open an HTML file in the browser.
 * @returns The window.
 */
export function Workbench({
  client,
  status,
  pickDirectory,
  setNativeAppearance,
  openUrl,
  reveal,
  pathForFile,
  openInBrowser,
}: {
  readonly client: AtriumClient;
  readonly status: ReactNode;
  readonly pickDirectory: (() => Promise<string | null>) | undefined;
  readonly setNativeAppearance: ((appearance: Appearance) => void) | undefined;
  readonly openUrl: (url: string) => void;
  readonly reveal: ((path: string) => void) | undefined;
  readonly pathForFile: ((file: File) => string | null) | undefined;
  /** Opens an absolute path to an HTML file in the default browser; left out where nothing can. */
  readonly openInBrowser?: ((path: string) => void) | undefined;
}) {
  const index = useStore(client.index);
  const setup = useStore(client.setup);
  const appearance = index.preferences.appearance;
  const seed = useInstallSeed(client.connection);
  const [finished, setFinished] = useState(false);
  const [shown, setShown] = useState<FirstLaunchStart | null>(null);
  const wanted = firstLaunchStart(index, setup, finished);
  const start = shown ?? wanted;
  // Once shown, first launch stays until finished (adjusting state while rendering, as React
  // advises for state that follows other values).
  if (shown === null && (wanted === "welcome" || wanted === "install")) setShown(wanted);

  const connected = useStore(client.connection, (connection) => connection.status === "connected");
  useEffect(() => {
    // Fire and forget: the answer lands in `client.setup`, a failure there too.
    if (connected) void client.loadSetup();
  }, [client, connected]);

  useEffect(() => {
    setNativeAppearance?.(appearance);
    return applyAppearance(document.documentElement, window.matchMedia("(prefers-color-scheme: dark)"), appearance);
  }, [appearance, setNativeAppearance]);

  const done = useCallback(() => {
    setFinished(true);
    setShown(null);
  }, []);

  return (
    <DotSeedContext value={seed}>
      {start === "wait" ? (
        <div className="h-full bg-[var(--main)] [-webkit-app-region:drag]" />
      ) : start === null ? (
        <MainWindow
          client={client}
          status={status}
          pickDirectory={pickDirectory}
          openUrl={openUrl}
          reveal={reveal}
          openInBrowser={openInBrowser}
        />
      ) : (
        <FirstLaunch
          client={client}
          start={start}
          onDone={done}
          openUrl={openUrl}
          pickDirectory={pickDirectory}
          pathForFile={pathForFile}
        />
      )}
    </DotSeedContext>
  );
}

/**
 * The main window: sidebar, tab bar and conversation area.
 *
 * @remarks
 * SPEC-0001 ("界面"). Focusing the window asks the host to look at workspaces and sessions again
 * (domain-model, "已决定 12"). Index files reset at the host's start are mentioned once per host
 * run, until dismissed. Starting a session when the client is nowhere starts a chat. A project's
 * new-workspace page shows in place of the tab bar and the conversation area, this window's own;
 * what it sets going shows over its session once there (SPEC-0001, "M1.11 的新建工作区"). An error
 * card's "去登录" opens the settings at "模型与账户" (SPEC-0001, "运行出错与停止"). The sidebar
 * folds, and the changes panel opens and widens, as remembered in `localStorage` (SPEC-0001,
 * "界面 · 左栏折叠与右栏").
 *
 * @sideEffects Subscribes to the client's list and the panes; listens for focus and keys; sends
 * commands; reads and writes `localStorage`.
 * @param props - The client, the connection status line, how to choose a folder, how to open an
 * address, how to show a path in the Finder, and how to open an HTML file in the browser.
 * @returns The main window.
 */
function MainWindow({
  client,
  status,
  pickDirectory,
  openUrl,
  reveal,
  openInBrowser,
}: {
  readonly client: AtriumClient;
  readonly status: ReactNode;
  readonly pickDirectory: (() => Promise<string | null>) | undefined;
  readonly openUrl: (url: string) => void;
  readonly reveal: ((path: string) => void) | undefined;
  readonly openInBrowser: ((path: string) => void) | undefined;
}) {
  const index = useStore(client.index);
  const container = index.layout.container;
  const sessionId = activeSession(index);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const settings = useSettings();
  const { choose: chooseSection, show: showSettings } = settings;
  const openLogin = useCallback(() => {
    // Background requests must not replace an editor inside the already-open modal.
    if (settings.open) return;
    chooseSection("accounts");
    showSettings();
  }, [chooseSection, showSettings, settings.open]);
  const [pages] = useState(createNewWorkspaceStore);
  const [panes] = useState(() => createPanes(localStorage));
  const [views] = useState(() => createWorkspaceViews(localStorage));
  const folded = useStore(panes, (state) => state.sidebarCollapsed);
  const pageProject = useStore(pages, (state) => state.page?.projectId ?? null);
  const viewer = useStore(views, (state) => (container === null ? null : viewOf(state, container).active));
  useDraftCleanup(index);

  useEffect(() => {
    /**
     * Tells the host the window has focus again.
     *
     * @remarks
     * See `MainWindow`.
     *
     * @sideEffects Sends `window_focused`.
     */
    const onFocus = (): void => {
      // Fire and forget: nothing waits for the rescan; its results arrive with the list.
      void client.windowFocused().catch(() => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [client]);

  useTabShortcuts(client, pages, views);
  useSessionShows(views, container, sessionId);
  usePaneShortcuts(client, pages, panes);
  // On the new-workspace page, or under a viewer tab, no session shows.
  useSeenErrors(client, index, pageProject === null && viewer === null ? sessionId : null);

  const resets = index.resets.length > 0 && dismissed !== index.generation ? index.resets : [];
  return (
    <>
      <div className="relative flex h-full" inert={settings.open}>
        <Sidebar
          client={client}
          onNewChat={() => {
            closePage(pages);
            fireAndForget(client.createChat());
          }}
          showSession={(session) => showViewer(views, session.containerId, null)}
          pickDirectory={pickDirectory}
          onSettings={settings.show}
          page={{
            projectId: pageProject,
            open: (projectId) => openPage(pages, projectId),
            leave: () => closePage(pages),
          }}
          folded={folded}
        />
        <main className="flex min-w-0 flex-1 flex-col bg-[var(--main)]">
          {container === null || pageProject !== null ? (
            <div className="h-12 shrink-0 [-webkit-app-region:drag]" />
          ) : (
            <TabBar
              client={client}
              containerId={container}
              onNew={() => fireAndForget(createHere(client))}
              panes={panes}
              views={views}
            />
          )}
          {pageProject === null && sessionId !== null ? (
            <Breadcrumb client={client} sessionId={sessionId} views={views} />
          ) : null}
          {resets.length > 0 ? (
            <div
              role="status"
              className="mx-auto mt-3 flex w-full max-w-[var(--column)] items-center gap-2 px-6 text-[length:var(--fs-meta)] text-[var(--attn-text)]"
            >
              <span className="flex-1">
                {resets.map((name) => FILE_NAMES[name]).join("、")}的文件损坏了，已经重置；原文件留在 ~/.atrium 里
              </span>
              <button type="button" aria-label="知道了" onClick={() => setDismissed(index.generation)}>
                <X size={12} />
              </button>
            </div>
          ) : null}
          {pageProject === null ? (
            <OpenLogin value={openLogin}>
              <ConversationArea
                client={client}
                containerId={container}
                sessionId={sessionId}
                create={() => createHere(client)}
                launches={pages}
                panes={panes}
                views={views}
                openInBrowser={openInBrowser}
              />
            </OpenLogin>
          ) : (
            <NewWorkspacePage client={client} store={pages} />
          )}
          <footer className="flex shrink-0 items-center justify-center text-[length:var(--fs-xs)]">{status}</footer>
        </main>
        <NewChildDialog client={client} />
        {/* After the drag areas it lies over, or Electron lets them take its presses (SidebarToggle). */}
        <SidebarToggle panes={panes} />
      </div>
      {settings.open ? (
        <SettingsPanel
          client={client}
          section={settings.section}
          onSection={settings.choose}
          onClose={settings.close}
          openUrl={openUrl}
          reveal={reveal}
        />
      ) : null}
    </>
  );
}
