import { type RefObject, useLayoutEffect, useRef } from "react";
import { type StoreApi, useStore } from "zustand";
import { type WorkspaceViews, keepPlace, placeOf, viewOf } from "../state/workspace-views";

/**
 * Where a viewer tab was left, kept as it goes and given back as it shows again.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"): switching away and back keeps the scroll and the
 * wrapping, by tab, in this window. The scroll goes back once the content is there (`ready`), in
 * a layout effect, so the 改动 tab's going to a file asked for, in an effect, comes after it. It is
 * kept as the tab goes, read before its content leaves the page.
 *
 * @sideEffects Subscribes to the views; sets the scroll area's scroll once; writes the views as
 * the tab goes and as wrapping switches.
 * @param views - The views.
 * @param containerId - The workspace.
 * @param key - The tab's key.
 * @param ready - Whether the content is there to scroll.
 * @returns Whether it wraps, how to switch that, and the ref for the scroll area.
 */
export function useViewerPlace(
  views: StoreApi<WorkspaceViews>,
  containerId: string,
  key: string,
  ready: boolean,
): { readonly wrap: boolean; readonly switchWrap: () => void; readonly body: RefObject<HTMLDivElement | null> } {
  const wrap = useStore(views, (state) => placeOf(viewOf(state, containerId), key).wrap);
  const body = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (placed.current || !ready || body.current === null) return;
    placed.current = true;
    body.current.scrollTop = placeOf(viewOf(views.getState(), containerId), key).scrollTop;
  }, [ready, views, containerId, key]);
  useLayoutEffect(() => {
    const element = body.current;
    return () => {
      // Before the content is placed, its scroll says nothing of where the tab was left.
      if (element !== null && placed.current) keepPlace(views, containerId, key, { scrollTop: element.scrollTop });
    };
  }, [views, containerId, key]);
  return { wrap, switchWrap: () => keepPlace(views, containerId, key, { wrap: !wrap }), body };
}
