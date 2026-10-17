import { type AtriumClient, isChatId } from "@atrium/client";
import type { ContainerId, SessionSummary } from "@atrium/protocol";
import { ArrowBendDownRight, CaretDown, ClockCounterClockwise, FileDiff, Plus, SidebarRight, X } from "../design/icons";
import { useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { splitPath } from "../chat/changes";
import { FileIcon } from "../files/file-icon";
import { useDiffMode } from "../files/use-diff";
import {
  type ViewerTab,
  type WorkspaceViews,
  closeViewer,
  pinViewer,
  showViewer,
  viewOf,
  viewerKey,
} from "../state/workspace-views";
import { sessionTitle, timeAgo } from "../sidebar/names";
import { RenameField } from "../sidebar/rename-field";
import { type RowStatus, sessionStatus } from "../sidebar/status";
import { tabStatus } from "../children/children";
import { askForChild } from "../children/new-child";
import { StatusIcon } from "../sidebar/status-icon";
import { useClock } from "../state/clock";
import type { Panes } from "../state/panes";
import { SessionMenu } from "./session-menus";
import { SessionNoticeLine } from "./session-notice";

/**
 * What a child conversation belongs to, for its row's hover text.
 *
 * @remarks
 * "属于「主对话名」" (SPEC-0002, "显示 · 历史和搜索"); nothing for an ordinary session, or a parent
 * the list does not have.
 *
 * @sideEffects none
 * @param session - The session.
 * @param byId - The sessions by id.
 * @returns The text, or `undefined`.
 */
function childOf(session: SessionSummary, byId: ReadonlyMap<string, SessionSummary>): string | undefined {
  const parent = session.parent === null ? undefined : byId.get(session.parent.sessionId);
  return parent === undefined ? undefined : `属于「${sessionTitle(parent)}」`;
}

/**
 * Runs a tab command without waiting for it.
 *
 * @remarks
 * A failure shows in the session's area once it is open.
 *
 * @sideEffects Runs the command.
 * @param command - The command.
 */
function run(command: () => Promise<unknown>): void {
  // Fire and forget: see above.
  void command().catch(() => undefined);
}

/**
 * The tab bar at the top of the conversation area.
 *
 * @remarks
 * Follows SPEC-0001 ("标签栏"): the container's open sessions as tabs (title, status, close),
 * "+" for a new session there, "历史" listing all its sessions newest first, and at the right
 * end the active session's "···", with a line before it saying what a command just did. Tabs shrink to about 96px and then scroll
 * sideways. Switching and closing show at once; the host confirms them. Last is the changes
 * panel's toggle; while the sidebar is folded the bar starts 120px in, clear of the traffic
 * lights and the sidebar's toggle (SPEC-0001, "界面 · 左栏折叠与右栏"). The container's viewer
 * tabs follow its sessions'; while one shows, no session tab is selected, and a session tab
 * clicked shows its session again (SPEC-0001, "M1.12 的文件与更改 · 查看标签"). The "···" menu's
 * rename happens on the session's tab (design-language, "改名框"); a failure shows next to the
 * menu, until the next action there.
 *
 * @sideEffects Subscribes to the client's list, the panes and the views; sends commands and
 * writes the views when used.
 * @param props - The client, the container, how to start a new session in it, the panes, and
 * the workspace views.
 * @returns The tab bar.
 */
export function TabBar({
  client,
  containerId,
  onNew,
  panes,
  views,
}: {
  readonly client: AtriumClient;
  readonly containerId: ContainerId;
  readonly onNew: () => void;
  readonly panes: StoreApi<Panes>;
  readonly views: StoreApi<WorkspaceViews>;
}) {
  const folded = useStore(panes, (state) => state.sidebarCollapsed);
  const view = useStore(views, (state) => viewOf(state, containerId));
  const mode = useDiffMode(client, views, isChatId(containerId) ? null : containerId);
  const index = useStore(client.index);
  const now = useClock().now();
  const tabs = index.layout.tabs[containerId] ?? { open: [], active: null };
  const byId = new Map(index.sessions.map((session) => [session.sessionId, session]));
  const open = tabs.open.flatMap((id) => {
    const session = byId.get(id);
    return session === undefined ? [] : [session];
  });
  const history = index.sessions
    .filter((session) => session.containerId === containerId && !session.archived)
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  const active = tabs.active === null ? undefined : byId.get(tabs.active);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameFailed, setRenameFailed] = useState<string | null>(null);

  return (
    <div
      data-testid="tab-bar"
      className={`flex h-12 shrink-0 items-center gap-1 pr-3 shadow-[inset_0_-0.5px_0_var(--line)] [transition:padding-left_240ms_cubic-bezier(.2,.8,.2,1)] [-webkit-app-region:drag] ${folded ? "pl-[120px]" : "pl-3"}`}
    >
      <div
        role="tablist"
        aria-label="打开的会话"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [-webkit-app-region:no-drag]"
      >
        {open.map((session) => (
          <Tab
            key={session.sessionId}
            session={session}
            status={tabStatus(index.sessions, session)}
            selected={session.sessionId === tabs.active && view.active === null}
            renaming={session.sessionId === renaming}
            onRenamed={(name) => {
              setRenaming(null);
              if (typeof name !== "string") return;
              // Fire and forget: a failure is shown.
              void client.renameSession(session.sessionId, name).catch(() => setRenameFailed(session.sessionId));
            }}
            onSelect={() => {
              showViewer(views, containerId, null);
              run(() => client.openSession(session.sessionId));
            }}
            onClose={() => run(() => client.closeTab(session.sessionId))}
          />
        ))}
        {view.tabs.map((tab) => {
          const key = viewerKey(tab);
          return (
            <ViewerTabButton
              key={key}
              tab={tab}
              selected={key === view.active}
              described={tab.kind === "file" ? tab.path : mode === "base" ? "已提交的改动" : "未提交的改动"}
              onSelect={() => showViewer(views, containerId, key)}
              onPin={() => pinViewer(views, containerId, key)}
              onClose={() => {
                const session = closeViewer(views, containerId, key, tabs.open);
                if (session !== null) run(() => client.openSession(session));
              }}
            />
          );
        })}
      </div>
      <span className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <button
          type="button"
          aria-label="新建会话（⌘T）"
          title="新建会话（⌘T）"
          onClick={onNew}
          className="inline-flex size-7 items-center justify-center rounded-[var(--r)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
        >
          <Plus size={15} />
        </button>
        <MenuButton label="新建" align="start" compact content={<CaretDown size={10} />}>
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  onNew();
                }}
              >
                <Plus size={13} />
                <span className="flex-1">新会话</span>
                <span className="text-[length:var(--fs-xs)] text-[var(--text-dim)]">⌘T</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={active === undefined || active.state === "draft"}
                title={active?.state === "draft" ? "这个会话还没有消息，发一条再开子对话" : undefined}
                className={`${MENU_ITEM} disabled:cursor-not-allowed disabled:text-[var(--text-dim)] disabled:hover:bg-transparent`}
                onClick={() => {
                  close();
                  if (active !== undefined) askForChild({ parentSessionId: active.sessionId, turnId: null });
                }}
              >
                <ArrowBendDownRight size={13} />
                <span className="flex-1">子对话</span>
                {active === undefined ? null : (
                  <span className="max-w-32 truncate text-[length:var(--fs-xs)] text-[var(--text-dim)]">
                    挂在「{sessionTitle(active)}」下
                  </span>
                )}
              </button>
            </>
          )}
        </MenuButton>
        <MenuButton
          label="历史"
          align="start"
          content={
            <>
              <ClockCounterClockwise size={14} />
              历史
              <CaretDown size={10} />
            </>
          }
        >
          {(close) =>
            history.length === 0 ? (
              <p className="px-2.5 py-1.5 text-[length:var(--fs-meta)] text-[var(--text-dim)]">还没有会话</p>
            ) : (
              <div className="max-h-96 w-72 overflow-y-auto">
                {history.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => {
                      close();
                      // Shows the session over a viewer tab, even the one already active.
                      showViewer(views, containerId, null);
                      run(() => client.openSession(session.sessionId));
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate" title={childOf(session, byId)}>
                      {session.parent === null ? "" : "↳ "}
                      {sessionTitle(session)}
                    </span>
                    {tabs.open.includes(session.sessionId) ? (
                      <span className="shrink-0 text-[length:var(--fs-xs)] text-[var(--text-dim)]">已打开</span>
                    ) : null}
                    {session.state === "missing" ? (
                      <span className="shrink-0 text-[length:var(--fs-xs)] text-[var(--danger)]">文件不见了</span>
                    ) : null}
                    <span className="shrink-0 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                      {timeAgo(session.updatedAt, now)}
                    </span>
                    <StatusIcon status={sessionStatus(session)} />
                  </button>
                ))}
              </div>
            )
          }
        </MenuButton>
      </span>
      <span className="min-w-0 flex-1" />
      <span className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {active === undefined ? null : <SessionNoticeLine sessionId={active.sessionId} />}
        {active === undefined ? null : (
          <SessionMenu
            key={active.sessionId}
            client={client}
            session={active}
            renameFailed={renameFailed === active.sessionId}
            onRename={() => {
              setRenameFailed(null);
              setRenaming(active.sessionId);
            }}
            onAction={() => setRenameFailed(null)}
          />
        )}
        <PanelToggle panes={panes} usable={!isChatId(containerId)} />
      </span>
    </div>
  );
}

/**
 * The right panel's toggle, at the tab bar's right end.
 *
 * @remarks
 * design-language ("右栏（文件与更改）"): `--tint` while the panel is open. A chat has no workspace
 * and so nothing to show: the toggle is `aria-disabled` rather than `disabled`, so its reason still
 * shows on hover, as the archive icon does.
 *
 * @sideEffects Subscribes to the panes; opens or closes the panel when clicked.
 * @param props - The panes, and whether there are changes to show here.
 * @returns The toggle.
 */
function PanelToggle({ panes, usable }: { readonly panes: StoreApi<Panes>; readonly usable: boolean }) {
  const open = useStore(panes, (state) => state.panelOpen);
  const setOpen = useStore(panes, (state) => state.setPanelOpen);
  return (
    <button
      type="button"
      aria-label="右栏"
      aria-pressed={usable && open}
      aria-disabled={!usable}
      title={usable ? "文件与更改（⌥⌘B）" : "对话没有工作区"}
      onClick={() => {
        if (usable) setOpen(!open);
      }}
      className="inline-flex size-7 items-center justify-center rounded-[var(--r)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)] aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-[var(--text-muted)] aria-pressed:text-[var(--tint)] aria-pressed:hover:text-[var(--tint)]"
    >
      <SidebarRight size={16} />
    </button>
  );
}

/**
 * A viewer tab: the file's type icon and name, or the diff icon and "改动", and a close button.
 *
 * @remarks
 * design-language ("查看标签"): as a session's tab, its title after a 14px icon; a preview's title
 * is in italics, and a double click pins it.
 *
 * @sideEffects none; the callbacks write the views.
 * @param props - The tab, whether it shows, what its tooltip says, and what selecting, pinning
 * and closing do.
 * @returns The tab.
 */
function ViewerTabButton({
  tab,
  selected,
  described,
  onSelect,
  onPin,
  onClose,
}: {
  readonly tab: ViewerTab;
  readonly selected: boolean;
  readonly described: string;
  readonly onSelect: () => void;
  readonly onPin: () => void;
  readonly onClose: () => void;
}) {
  const title = tab.kind === "file" ? splitPath(tab.path).name : "改动";
  return (
    <div
      role="tab"
      tabIndex={selected ? 0 : -1}
      aria-selected={selected}
      title={described}
      onClick={onSelect}
      onDoubleClick={onPin}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect();
      }}
      className="group flex h-[30px] max-w-[200px] min-w-24 shrink items-center gap-1.5 rounded-[var(--r)] pr-1 pl-2.5 text-[length:var(--fs-meta)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)] aria-selected:bg-[var(--selected)] aria-selected:text-[var(--text)]"
    >
      {tab.kind === "file" ? (
        <FileIcon path={tab.path} size={14} />
      ) : (
        <FileDiff size={14} className="flex-none text-[var(--text-muted)]" />
      )}
      <span className={`min-w-0 flex-1 truncate ${tab.kind === "file" && tab.preview ? "italic" : ""}`}>{title}</span>
      <button
        type="button"
        aria-label={`关闭 ${title}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-[var(--r-sm)] opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100 hover:bg-[var(--hover)]"
      >
        <X size={11} />
      </button>
    </div>
  );
}

/**
 * One tab: the session's title, its status, and a close button.
 *
 * @remarks
 * The close button shows on hover and on the active tab (prototype `app-prototype.html`). While
 * the session is renamed, the title is the rename field and the close button is gone
 * (design-language, "改名框").
 *
 * @sideEffects none; the callbacks send commands.
 * @param props - The session, whether its tab is active, whether it is being renamed, and what
 * renaming, selecting and closing do.
 * @returns The tab.
 */
function Tab({
  session,
  status,
  selected,
  renaming,
  onRenamed,
  onSelect,
  onClose,
}: {
  readonly session: SessionSummary;
  /** Its status, raised by its child conversations' (SPEC-0002, "主对话标签的状态图标"). */
  readonly status: RowStatus;
  readonly selected: boolean;
  readonly renaming: boolean;
  /** Called once renaming ends, with the name, `null` for an empty one, or `undefined` when cancelled. */
  readonly onRenamed: (name: string | null | undefined) => void;
  readonly onSelect: () => void;
  readonly onClose: () => void;
}) {
  const title = sessionTitle(session);
  return (
    <div
      role="tab"
      tabIndex={selected ? 0 : -1}
      aria-selected={selected}
      title={title}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect();
      }}
      className="group flex h-[30px] max-w-[200px] min-w-24 shrink items-center gap-1.5 rounded-[var(--r)] pr-1 pl-2.5 text-[length:var(--fs-meta)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)] aria-selected:bg-[var(--selected)] aria-selected:text-[var(--text)]"
    >
      <StatusIcon status={status} />
      {session.parent === null ? null : (
        <ArrowBendDownRight size={12} aria-label="子对话" className="shrink-0 text-[var(--text-dim)]" />
      )}
      {renaming ? (
        <RenameField initial={title} label="会话名称" onDone={onRenamed} />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <button
            type="button"
            aria-label={`关闭 ${title}`}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-[var(--r-sm)] opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100 hover:bg-[var(--hover)]"
          >
            <X size={11} />
          </button>
        </>
      )}
    </div>
  );
}
