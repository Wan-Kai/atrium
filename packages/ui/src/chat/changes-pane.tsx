import type { AtriumClient } from "@atrium/client";
import { useEffect, useRef, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { PANEL_WIDTH, type Panes, fitPanelWidth, panelWidthCss } from "../state/panes";
import { ChangesPanel } from "./changes-panel";

/**
 * The changes panel as the right pane: it opens and closes by its width, and its left edge drags.
 *
 * @remarks
 * SPEC-0001 ("工作区改动", "界面 · 左栏折叠与右栏"); design-language ("右栏（改动面板）", "动效 ·
 * 右栏打开收起"). The width goes between 0 and the panel's in 0.24s while the panel keeps its
 * own, showing from the right; it stays mounted until it has closed, then goes, ending its watch.
 * The panel's width is the one chosen, fitted to the room (`panelWidthCss`): the area it shares
 * with the conversation, which must be its parent and the panel's containing block. Dragging the
 * edge, or ← → on it, chooses another, and a double click the usual one. Only a workspace has
 * one: in a chat it is hidden at once, and shows again, opening, back in a workspace. Each
 * workspace's panel starts afresh: a mode chosen or a file folded in one does not carry over.
 *
 * @sideEffects Subscribes to the panes; listens for pointer moves on the window while dragged;
 * through the panel, watches the diff.
 * @param props - The client, the workspace shown (`null` in a chat), and the panes.
 * @returns The pane.
 */
export function ChangesPane({
  client,
  workspaceId,
  panes,
}: {
  readonly client: AtriumClient;
  readonly workspaceId: string | null;
  readonly panes: StoreApi<Panes>;
}) {
  const open = useStore(panes, (state) => state.panelOpen) && workspaceId !== null;
  const chosen = useStore(panes, (state) => state.panelWidth);
  const { setPanelOpen, setPanelWidth } = panes.getState();
  const [present, setPresent] = useState(open);
  const [dragging, setDragging] = useState(false);
  // How to end a drag going on, so going away mid-drag stops listening.
  const ending = useRef<(() => void) | null>(null);
  useEffect(() => () => ending.current?.(), []);
  // Shown as soon as it opens (adjusting state while rendering, as React advises).
  if (open && !present) setPresent(true);
  const width = panelWidthCss(chosen);

  /**
   * Chooses a width, fitted to the room the separator's panel is in.
   *
   * @remarks
   * See `ChangesPane`.
   *
   * @sideEffects Writes the panes.
   * @param separator - The separator.
   * @param next - The width wanted.
   */
  const choose = (separator: Element, next: number): void =>
    setPanelWidth(fitPanelWidth(next, separator.parentElement?.offsetParent?.clientWidth ?? 0));

  return (
    <div
      data-testid="changes-pane"
      style={{ width: open ? width : 0 }}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) setPresent(false);
      }}
      className={`flex-none ${dragging || workspaceId === null ? "" : "[transition:width_240ms_cubic-bezier(.2,.8,.2,1)]"}`}
    >
      {present && workspaceId !== null ? (
        <div className="absolute inset-y-0 right-0 flex" style={{ width }}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="改动面板的宽度"
            aria-valuenow={chosen}
            aria-valuemin={PANEL_WIDTH.least}
            tabIndex={0}
            data-dragging={dragging || undefined}
            onPointerDown={(event) => {
              event.preventDefault();
              setDragging(true);
              const separator = event.currentTarget;
              const from = { x: event.clientX, width: separator.parentElement?.clientWidth ?? chosen };
              /**
               * Follows the pointer.
               *
               * @remarks
               * Dragging left widens the panel.
               *
               * @sideEffects Writes the panes.
               * @param move - The pointer's move.
               */
              const follow = (move: PointerEvent): void => choose(separator, from.width + from.x - move.clientX);
              /**
               * Ends the drag.
               *
               * @remarks
               * The width stays as dragged to.
               *
               * @sideEffects Stops listening on the window; updates component state.
               */
              const end = (): void => {
                window.removeEventListener("pointermove", follow);
                window.removeEventListener("pointerup", end);
                window.removeEventListener("pointercancel", end);
                ending.current = null;
                setDragging(false);
              };
              ending.current = end;
              window.addEventListener("pointermove", follow);
              window.addEventListener("pointerup", end);
              window.addEventListener("pointercancel", end);
            }}
            onDoubleClick={(event) => choose(event.currentTarget, PANEL_WIDTH.usual)}
            onKeyDown={(event) => {
              const step = { ArrowLeft: PANEL_WIDTH.step, ArrowRight: -PANEL_WIDTH.step }[event.key];
              if (step === undefined) return;
              const shown = event.currentTarget.parentElement?.clientWidth ?? chosen;
              choose(event.currentTarget, shown + step);
              event.preventDefault();
            }}
            className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-[var(--tint)] after:opacity-0 after:transition-opacity hover:after:opacity-100 hover:after:delay-150 focus-visible:after:opacity-100 data-[dragging]:after:opacity-100 data-[dragging]:after:delay-0"
          />
          <ChangesPanel
            key={workspaceId}
            client={client}
            workspaceId={workspaceId}
            onClose={() => setPanelOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
