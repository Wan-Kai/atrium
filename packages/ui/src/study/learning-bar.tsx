import { type StoreApi, useStore } from "zustand";
import { Mortarboard } from "../design/icons";
import type { Panes } from "../state/panes";

/**
 * The bar over a learning page, in place of the tab bar: only a breadcrumb.
 *
 * @remarks
 * design-language ("学习模式"): the mortarboard and a semibold "学习", then `--text-dim`
 * " › 新方向" on the new-direction page. The window can be dragged by it; while the sidebar is
 * folded it starts 120px in, as the tab bar does, clear of the traffic lights.
 *
 * @sideEffects Subscribes to the panes.
 * @param props - The panes, and the crumb after "学习", if any.
 * @returns The bar.
 */
export function LearningBar({ panes, crumb }: { readonly panes: StoreApi<Panes>; readonly crumb?: string }) {
  const folded = useStore(panes, (state) => state.sidebarCollapsed);
  return (
    <div
      data-testid="learning-bar"
      className={`flex h-12 shrink-0 items-center shadow-[inset_0_-0.5px_0_var(--line)] [transition:padding-left_240ms_cubic-bezier(.2,.8,.2,1)] [-webkit-app-region:drag] ${folded ? "pl-[120px]" : "pl-4"}`}
    >
      <span className="inline-flex items-center gap-1 text-[length:var(--fs-meta)] text-[var(--text-muted)]">
        <Mortarboard size={14} className="text-[var(--tint)]" />
        <b className="font-semibold text-[var(--text)]">学习</b>
        {crumb === undefined ? null : <span className="text-[var(--text-dim)]"> › {crumb}</span>}
      </span>
    </div>
  );
}
