import type { AtriumClient } from "@atrium/client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { RightPanel } from "../files/right-panel";
import { PANEL_WIDTH, type Panes, fitPanelWidth, panelWidthCss } from "../state/panes";
import type { WorkspaceViews } from "../state/workspace-views";

/**
 * The right panel, drawn again only when its own props or state change.
 *
 * @remarks
 * The pane is drawn again whenever the panel opens or closes and whenever the conversation area
 * is; going over a large tree each time would cost at the start of every move of the panes
 * (design-language, "右栏（文件与更改）").
 *
 * @sideEffects As `RightPanel`.
 */
const StillPanel = memo(RightPanel);

/**
 * The right panel as the right pane: it opens and closes by its width, and its left edge drags.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 右栏", "界面 · 左栏折叠与右栏"); design-language ("右栏（文件与更改）", "动效 ·
 * 右栏打开收起"). The width goes between 0 and the panel's in 0.24s while the panel keeps its
 * own, sliding in and out with the pane's left edge: it moves by its width on the same curve, so
 * the room, which must cut off what goes past it, hides it as it goes. It stays mounted until it
 * has closed (or its move is cancelled, as when closed while still 0 wide), then goes, ending its
 * watch. Not clipped by the pane itself: the panel's width is the one chosen, fitted to the room
 * (`panelWidthCss`), the area it shares with the conversation, which must be its parent and the
 * panel's containing block; measured against a container instead, the panel would be laid out
 * again on every frame the room changes width (design-language, "右栏（文件与更改）"). Dragging the
 * edge, or ← → on it, chooses another, and a double click the usual one. Only a workspace has
 * one: in a chat it is hidden at once, and shows again, opening, back in a workspace. Each
 * workspace's panel is its own: its tab, the mode chosen and what is folded are the workspace's.
 *
 * @sideEffects Subscribes to the panes; listens for pointer moves on the window while dragged;
 * through the panel, reads directories.
 * @param props - The client, the workspace shown (`null` in a chat), the panes, and the
 * workspace views.
 * @returns The pane.
 */
export function ChangesPane({
  client,
  workspaceId,
  panes,
  views,
}: {
  readonly client: AtriumClient;
  readonly workspaceId: string | null;
  readonly panes: StoreApi<Panes>;
  readonly views: StoreApi<WorkspaceViews>;
}) {
  const open = useStore(panes, (state) => state.panelOpen) && workspaceId !== null;
  const chosen = useStore(panes, (state) => state.panelWidth);
  const { setPanelOpen, setPanelWidth } = panes.getState();
  const close = useCallback(() => setPanelOpen(false), [setPanelOpen]);
  const [present, setPresent] = useState(open);
  const [dragging, setDragging] = useState(false);
  // How to end a drag going on, so going away mid-drag stops listening.
  const ending = useRef<(() => void) | null>(null);
  // The panel at its own width, which the pane only reaches once it has opened.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => () => ending.current?.(), []);
  // Open from the first frame, the pane does not move, so neither does the panel at first.
  const [still, setStill] = useState(open);
  // Shown as soon as it opens (adjusting state while rendering, as React advises).
  if (open && !present) setPresent(true);
  if (!open && still) setStill(false);
  const width = panelWidthCss(chosen);
  // Moving smoothly, except while dragged or hidden in a chat.
  const moving = !dragging && workspaceId !== null;

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
      onTransitionCancel={(event) => {
        if (event.target === event.currentTarget && !open) setPresent(false);
      }}
      className={`flex-none ${moving ? "[transition:width_240ms_cubic-bezier(.2,.8,.2,1)]" : ""}`}
    >
      {present && workspaceId !== null ? (
        <div
          ref={box}
          // In classes, not the style, which would win over the starting one. Ready to move from
          // the start, so the first frame of a move does not walk every line of the diff.
          className={`absolute inset-y-0 right-0 flex [will-change:translate] ${still ? "" : "starting:[translate:100%]"} ${open ? "[translate:0]" : "[translate:100%]"} ${moving ? "[transition:translate_240ms_cubic-bezier(.2,.8,.2,1)]" : ""}`}
          style={{ width }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="右栏的宽度"
            aria-valuenow={chosen}
            aria-valuemin={PANEL_WIDTH.least}
            tabIndex={0}
            data-dragging={dragging || undefined}
            onPointerDown={(event) => {
              event.preventDefault();
              setDragging(true);
              const separator = event.currentTarget;
              const from = { x: event.clientX, width: box.current?.clientWidth ?? chosen };
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
              const shown = box.current?.clientWidth ?? chosen;
              choose(event.currentTarget, shown + step);
              event.preventDefault();
            }}
            className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-[var(--tint)] after:opacity-0 after:transition-opacity hover:after:opacity-100 hover:after:delay-150 focus-visible:after:opacity-100 data-[dragging]:after:opacity-100 data-[dragging]:after:delay-0"
          />
          <StillPanel key={workspaceId} client={client} workspaceId={workspaceId} views={views} onClose={close} />
        </div>
      ) : null}
    </div>
  );
}
