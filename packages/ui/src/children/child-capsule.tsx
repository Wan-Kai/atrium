import type { AtriumClient } from "@atrium/client";
import type { SessionSummary } from "@atrium/protocol";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { RoleTag } from "../chat/lanes";
import { CapsuleUnit } from "../chat/run-control";
import { Clock, DotsThree, GitBranch, TerminalWindow } from "../design/icons";
import { placeOf, sessionTitle, timeAgo } from "../sidebar/names";
import type { RowStatus } from "../sidebar/status";
import { StatusIcon } from "../sidebar/status-icon";
import { useClock } from "../state/clock";
import { showNotice } from "../state/session-notices";
import { type WorkspaceViews, showViewer } from "../state/workspace-views";
import { childrenOf, descendantsOf, heldIn, modelLine, rowStatus } from "./children";

/** The statuses the capsule counts, in the order it shows them (design-language, "会话状态"). */
const COUNTED: readonly Exclude<RowStatus, null>[] = ["asking", "auth", "error", "running"];

/**
 * The child conversations' capsule above the input box, and the list it opens.
 *
 * @remarks
 * SPEC-0002 ("显示 · 子对话条"; prototype A): absent without children; "子对话 N" with each status
 * its rows show and how many, the same icons as the sidebar's. Opened, its list floats 8 px above
 * the capsule, its left edge at the capsule's, as the queue's does (`CapsuleUnit`), as wide as its
 * rows from 300 px but never past the bar, and a press outside or Escape closes it: each direct child with its status (its whole
 * subtree's), its name, where it is when not here ("已在终端中继续" once handed off), "+N" for the
 * sessions below it, and, on the right in one column that every row lines up with, the model and
 * thinking level its file records (SPEC-0002) and when it last changed; clicking a row opens it, its
 * menu opens, detaches or archives it. Failures show beside the tab bar. A child opened shows, though its workspace
 * showed a viewer tab, as one chosen in the sidebar does. Whether the list is open is the capsule
 * bar's to say, so that one list at a time floats there; left out, the capsule keeps it. The list
 * closes once no child is left, so the next child does not open it by itself. A child the agent
 * opened has its role beside its name, and a second line: its question to the parent's agent, or
 * its latest progress. Deliveries held in the subtree since the host restarted show on top, with
 * "全部继续".
 *
 * @sideEffects Opens, detaches or archives sessions as the user acts; writes the views; animates
 * the list and listens for presses and Escape while it is open (`CapsuleUnit`).
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
  const parent = index.sessions.find((session) => session.sessionId === sessionId);
  // The models the input box has asked for; a model it does not list goes by its id.
  const catalog = useStore(client.models(parent?.containerId ?? null)).models;
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
  const statuses = children.map((child) => rowStatus(index.sessions, child));
  const held = heldIn(index.sessions, sessionId);
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
    <CapsuleUnit
      open={open}
      onToggle={toggle}
      onClose={toggle}
      label="子对话"
      span="content"
      capsule={
        <>
          子对话 {children.length}
          {counts.map(([status, count]) => (
            <span key={status} className="flex items-center gap-0.5">
              <span className="text-[var(--text-dim)]">·</span>
              <StatusIcon status={status} />
              {count}
            </span>
          ))}
        </>
      }
    >
      {held === 0 ? null : (
        <div
          className="mb-1 flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--attn-soft)] px-2.5 py-1.5 text-[length:var(--fs-sm)] text-[var(--attn-text)]"
          data-testid="deliveries-held"
        >
          <Clock size={14} />
          <span className="min-w-0 flex-1">宿主重启后暂停了 {held} 条送达</span>
          <button
            type="button"
            className="font-medium"
            onClick={() => act(() => client.resumeDeliveries(sessionId, true), "没能继续送达")}
          >
            全部继续
          </button>
        </div>
      )}
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
          model={modelLine(child.model, catalog)}
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
    </CapsuleUnit>
  );
}

/**
 * What a child's row says under its name, if anything.
 *
 * @remarks
 * SPEC-0002 ("显示 · 子对话条"): a child asking the parent's agent, "在问主 agent：" and the
 * question's first line, in the question's colour; otherwise its latest progress.
 *
 * @sideEffects none
 * @param child - The child.
 * @returns The line, or `null`.
 */
function secondLine(child: SessionSummary): { readonly text: string; readonly asking: boolean } | null {
  const agent = child.agent;
  if (agent === null) return null;
  if (agent.status === "waiting_for_parent" && agent.question !== null) {
    return { text: `在问主 agent：${agent.question.split("\n")[0] ?? ""}`, asking: true };
  }
  return agent.progress === null ? null : { text: agent.progress, asking: false };
}

/**
 * One child in the capsule's list.
 *
 * @remarks
 * See `ChildCapsule`; a child with nothing to show has a faint dot where a status would be, so the
 * names line up.
 *
 * @sideEffects Calls the actions as the user acts.
 * @param props - The child, its status, how many sessions are below it, its model and level, where
 * it is, when it last changed, and what opening, detaching and archiving it do.
 * @returns The row.
 */
function ChildRow({
  child,
  status,
  below,
  model,
  place,
  when,
  onOpen,
  onDetach,
  onArchive,
}: {
  readonly child: SessionSummary;
  readonly status: RowStatus;
  readonly below: number;
  readonly model: string | null;
  readonly place: string | null;
  readonly when: string;
  readonly onOpen: () => void;
  readonly onDetach: () => void;
  readonly onArchive: () => void;
}) {
  const second = secondLine(child);
  return (
    <div
      data-testid="child-row"
      data-panel-row
      className="mt-0.5 flex min-h-[40px] items-center gap-2 rounded-[var(--r-md)] py-1.5 pr-1 pl-2.5 text-[length:var(--fs-meta)] first:mt-0 hover:bg-[var(--hover)]"
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {status === null ? (
          <span className="flex size-4 shrink-0 items-center justify-center">
            <span className="size-[5px] rounded-full bg-[var(--text-dim)] opacity-60" />
          </span>
        ) : (
          <StatusIcon status={status} />
        )}
        {second === null ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[var(--text-2)]">{sessionTitle(child)}</span>
            {child.agent === null ? null : <RoleTag role={child.agent.role} />}
          </span>
        ) : (
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[var(--text-2)]">{sessionTitle(child)}</span>
              {child.agent === null ? null : <RoleTag role={child.agent.role} />}
            </span>
            <span
              className={`max-w-[320px] truncate text-[length:var(--fs-xs)] ${
                second.asking ? "text-[var(--attn-text)]" : "text-[var(--text-dim)]"
              }`}
              data-testid="child-second"
            >
              {second.text}
            </span>
          </span>
        )}
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
        <span className="ml-auto flex shrink-0 items-center">
          {model === null ? null : (
            <span className="shrink-0 text-[length:var(--fs-xs)] text-[var(--text-dim)]" data-testid="child-model">
              {model}
            </span>
          )}
          <span className="ml-2 min-w-[50px] shrink-0 text-right text-[length:var(--fs-xs)] tabular-nums text-[var(--text-dim)]">
            {when}
          </span>
        </span>
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
