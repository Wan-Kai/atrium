import type { AtriumClient } from "@atrium/client";
import { type ContainerId, type SessionSummary, isChatId } from "@atrium/protocol";
import { CaretDown, ClockCounterClockwise, Plus, SidebarRight, X } from "../design/icons";
import { type StoreApi, useStore } from "zustand";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { sessionTitle, timeAgo } from "../sidebar/names";
import { sessionStatus } from "../sidebar/status";
import { StatusIcon } from "../sidebar/status-icon";
import { useClock } from "../state/clock";
import type { Panes } from "../state/panes";
import { SessionMenu } from "./session-menus";
import { SessionNoticeLine } from "./session-notice";

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
 * lights and the sidebar's toggle (SPEC-0001, "界面 · 左栏折叠与右栏").
 *
 * @sideEffects Subscribes to the client's list and the panes; sends commands when used.
 * @param props - The client, the container, how to start a new session in it, and the panes.
 * @returns The tab bar.
 */
export function TabBar({
  client,
  containerId,
  onNew,
  panes,
}: {
  readonly client: AtriumClient;
  readonly containerId: ContainerId;
  readonly onNew: () => void;
  readonly panes: StoreApi<Panes>;
}) {
  const folded = useStore(panes, (state) => state.sidebarCollapsed);
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
            selected={session.sessionId === tabs.active}
            onSelect={() => run(() => client.openSession(session.sessionId))}
            onClose={() => run(() => client.closeTab(session.sessionId))}
          />
        ))}
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
                      run(() => client.openSession(session.sessionId));
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{sessionTitle(session)}</span>
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
        {active === undefined ? null : <SessionMenu key={active.sessionId} client={client} session={active} />}
        <PanelToggle panes={panes} usable={!isChatId(containerId)} />
      </span>
    </div>
  );
}

/**
 * The changes panel's toggle, at the tab bar's right end.
 *
 * @remarks
 * design-language ("右栏（改动面板）"): `--tint` while the panel is open. A chat has no workspace
 * and so no changes: the toggle is `aria-disabled` rather than `disabled`, so its reason still
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
      aria-label="改动面板"
      aria-pressed={usable && open}
      aria-disabled={!usable}
      title={usable ? "改动面板（⌥⌘B）" : "对话没有工作区，没有改动"}
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
 * One tab: the session's title, its status, and a close button.
 *
 * @remarks
 * The close button shows on hover and on the active tab (prototype `app-prototype.html`).
 *
 * @sideEffects none; the callbacks send commands.
 * @param props - The session, whether its tab is active, and what selecting and closing do.
 * @returns The tab.
 */
function Tab({
  session,
  selected,
  onSelect,
  onClose,
}: {
  readonly session: SessionSummary;
  readonly selected: boolean;
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
      <StatusIcon status={sessionStatus(session)} />
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
    </div>
  );
}
