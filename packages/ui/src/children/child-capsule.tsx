import type { AtriumClient } from "@atrium/client";
import type { SessionSummary } from "@atrium/protocol";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { CaretUp, DotsThree, GitBranch, TerminalWindow } from "../design/icons";
import { placeOf, sessionTitle, timeAgo } from "../sidebar/names";
import type { RowStatus } from "../sidebar/status";
import { StatusIcon } from "../sidebar/status-icon";
import { useClock } from "../state/clock";
import { showNotice } from "../state/session-notices";
import { type WorkspaceViews, showViewer } from "../state/workspace-views";
import { childrenOf, descendantsOf, rowStatus } from "./children";

/** The capsule's look, as the queue's above the input box (run-control's `CAPSULE`). */
const CAPSULE =
  "pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-[var(--r-pill)] bg-[var(--surface-1)] px-[11px] text-[length:var(--fs-sm)] whitespace-nowrap tabular-nums text-[var(--text-2)] shadow-[0_0_0_0.5px_var(--line),0_6px_16px_-8px_rgba(0,0,0,0.22)] dark:bg-[var(--surface-2)]";

/** The statuses the capsule counts, in the order it shows them (design-language, "会话状态"). */
const COUNTED: readonly Exclude<RowStatus, null>[] = ["asking", "auth", "error", "running"];

/**
 * The child conversations' capsule above the input box, and the list it opens.
 *
 * @remarks
 * SPEC-0002 ("显示 · 子对话条"; prototype A): absent without children; "子对话 N" with each status
 * its rows show and how many, the same icons as the sidebar's. Opened, a list floats above the input
 * box as the queue's does, as wide as its rows: each direct child with its status (its whole
 * subtree's), its name, where it is when not here ("已在终端中继续" once handed off), "+N" for the
 * sessions below it, and when it last changed; clicking a row opens it, its menu opens, detaches
 * or archives it. Failures show beside the tab bar. A child opened shows, though its workspace
 * showed a viewer tab, as one chosen in the sidebar does. Whether the list is open is the capsule
 * bar's to say, so that one list at a time floats there; left out, the capsule keeps it. The list
 * closes once no child is left, so the next child does not open it by itself.
 *
 * @sideEffects Opens, detaches or archives sessions as the user acts; writes the views.
 * @param props - The client, the session whose children these are, the workspace views, and
 * whether the list is open and how to open or close it.
 * @returns The capsule and its list, or nothing.
 */
export function ChildCapsule({
  client,
  sessionId,
  views,
  open: given,
  onToggle,
}: {
  readonly client: AtriumClient;
  readonly sessionId: string;
  readonly views?: StoreApi<WorkspaceViews> | undefined;
  readonly open?: boolean;
  readonly onToggle?: () => void;
}) {
  const index = useStore(client.index);
  const [kept, setKept] = useState(false);
  const open = given ?? kept;
  const toggle = onToggle ?? (() => setKept(!kept));
  const clock = useClock();
  const children = childrenOf(index.sessions, sessionId);
  const none = children.length === 0;
  const toggled = useRef(toggle);
  useEffect(() => {
    toggled.current = toggle;
  });
  useEffect(() => {
    // oxlint-disable-next-line react-hooks-js/set-state-in-effect -- follows the children the host lists.
    if (none && open) toggled.current();
  }, [none, open]);
  if (none) return null;
  const parent = index.sessions.find((session) => session.sessionId === sessionId);
  const statuses = children.map((child) => rowStatus(index.sessions, child));
  const counts = COUNTED.map((status) => [status, statuses.filter((one) => one === status).length] as const).filter(
    ([, count]) => count > 0,
  );

  /**
   * Runs a row's command, saying beside the tab bar when it failed.
   *
   * @remarks
   * See `ChildCapsule`.
   *
   * @sideEffects Sends the command; may show a notice.
   * @param command - The command.
   * @param failure - What to say when it fails.
   */
  const act = (command: () => Promise<unknown>, failure: string): void => {
    // Fire and forget: a failure is shown.
    void command().catch(() => showNotice(sessionId, failure, true));
  };

  return (
    <>
      {open ? (
        <div
          role="dialog"
          aria-label="子对话"
          className="pointer-events-auto absolute bottom-[calc(100%+8px)] left-0 z-10 w-max max-w-full min-w-[300px] rounded-[var(--r-card)] bg-[var(--surface-1)] p-1.5 shadow-[var(--float-shadow)] dark:bg-[var(--surface-2)]"
        >
          <div className="flex items-center justify-between gap-6 px-2 pt-1 pb-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
            <span>子对话</span>
            <span>最近更新的在前</span>
          </div>
          {children.map((child, at) => (
            <ChildRow
              key={child.sessionId}
              child={child}
              status={statuses[at] ?? null}
              below={descendantsOf(index.sessions, child.sessionId).length}
              place={child.containerId === parent?.containerId ? null : placeOf(index, child.containerId)}
              when={timeAgo(child.updatedAt, clock.now())}
              onOpen={() => {
                toggle();
                if (views !== undefined) showViewer(views, child.containerId, null);
                act(() => client.openSession(child.sessionId), "没能打开子对话");
              }}
              onDetach={() => act(() => client.detachSession(child.sessionId), "没能脱离子对话")}
              onArchive={() => act(() => client.archiveSession(child.sessionId), "没能归档子对话")}
            />
          ))}
        </div>
      ) : null}
      <button type="button" aria-expanded={open} className={CAPSULE} onClick={toggle}>
        子对话 {children.length}
        {counts.map(([status, count]) => (
          <span key={status} className="flex items-center gap-0.5">
            <span className="text-[var(--text-dim)]">·</span>
            <StatusIcon status={status} />
            {count}
          </span>
        ))}
        <CaretUp size={10} className={`text-[var(--text-dim)] ${open ? "rotate-180" : ""}`} />
      </button>
    </>
  );
}

/**
 * One child in the capsule's list.
 *
 * @remarks
 * See `ChildCapsule`; a child with nothing to show has a faint dot where a status would be, so the
 * names line up.
 *
 * @sideEffects Calls the actions as the user acts.
 * @param props - The child, its status, how many sessions are below it, where it is, when it last
 * changed, and what opening, detaching and archiving it do.
 * @returns The row.
 */
function ChildRow({
  child,
  status,
  below,
  place,
  when,
  onOpen,
  onDetach,
  onArchive,
}: {
  readonly child: SessionSummary;
  readonly status: RowStatus;
  readonly below: number;
  readonly place: string | null;
  readonly when: string;
  readonly onOpen: () => void;
  readonly onDetach: () => void;
  readonly onArchive: () => void;
}) {
  return (
    <div
      data-testid="child-row"
      className="flex h-[34px] items-center gap-2 rounded-[var(--r-md)] pr-1 pl-2.5 text-[length:var(--fs-meta)] hover:bg-[var(--hover)]"
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {status === null ? (
          <span className="flex size-4 shrink-0 items-center justify-center">
            <span className="size-[5px] rounded-full bg-[var(--text-dim)] opacity-60" />
          </span>
        ) : (
          <StatusIcon status={status} />
        )}
        <span className="min-w-0 truncate text-[var(--text-2)]">{sessionTitle(child)}</span>
        {child.handedOff ? (
          <span className="flex shrink-0 items-center gap-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
            <TerminalWindow size={12} />
            已在终端中继续
          </span>
        ) : place === null ? null : (
          <span className="flex shrink-0 items-center gap-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
            <GitBranch size={12} />
            {place}
          </span>
        )}
        {below === 0 ? null : (
          <span className="shrink-0 text-[length:var(--fs-xs)] text-[var(--text-muted)]">+{below}</span>
        )}
        <span className="ml-auto shrink-0 pl-4 text-[length:var(--fs-xs)] text-[var(--text-dim)]">{when}</span>
      </button>
      <MenuButton label={`「${sessionTitle(child)}」的操作`} compact content={<DotsThree size={14} />}>
        {(close) => (
          <>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                close();
                onOpen();
              }}
            >
              打开
            </button>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                close();
                onDetach();
              }}
            >
              脱离
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${MENU_ITEM} text-[var(--danger)]`}
              onClick={() => {
                close();
                onArchive();
              }}
            >
              归档
            </button>
          </>
        )}
      </MenuButton>
    </div>
  );
}
