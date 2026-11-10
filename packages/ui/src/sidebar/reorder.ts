import { type RefObject, useLayoutEffect, useRef } from "react";

/** A row the sidebar can move: what it is, and which band of the order it belongs to. */
export interface ReorderRow {
  /** Stable across renders, matched against the row's `data-row-key`. */
  readonly key: string;
  /** 0 pinned, 1 busy, 2 the rest (SPEC-0001, "对话的置顶与顺序"); a row that climbs flashes. */
  readonly band: number;
}

/** How long a row takes to slide to its new place (design-language, "动效 · 对话顺序变化"). */
const MOVE_MS = 280;

/** How long the row that climbed a band stays lit. */
const HIGHLIGHT_MS = 700;

/** The rows' curve: smooth, landing softly. */
const MOVE_EASING = "cubic-bezier(.2,.8,.2,1)";

/**
 * Whether the user asked for less motion.
 *
 * @remarks
 * Then rows jump to their new places, as every other motion does (design-language, "减弱动态效果").
 *
 * @sideEffects none
 * @returns Whether to skip the motion.
 */
function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Measures its rows again after every render, sliding the ones whose place changed.
 *
 * @remarks
 * Pinning a chat, or a run starting in one, moves rows: each keeps its place by animating from
 * where it was to where it is now (FLIP, design-language, "动效 · 对话顺序变化"). The row that
 * climbed a band — the one just pinned, or the one that started running — flashes once as it
 * lands, in the tint the sidebar lights runs with. Rows that are new or gone are left alone: the
 * list fades those in and out itself. Nothing plays on the first render, nor when the user asked
 * for less motion.
 *
 * @sideEffects Starts Web Animations on the rows it moves, and cancels the ones it started before.
 * @param rows - The rows now, in the order they are shown.
 * @returns The ref to put on the rows' parent.
 */
export function useReorderRows(rows: readonly ReorderRow[]): RefObject<HTMLDivElement | null> {
  const parent = useRef<HTMLDivElement>(null);
  const before = useRef(new Map<string, { readonly top: number; readonly band: number }>());
  const moving = useRef(new Map<string, Animation[]>());
  useLayoutEffect(() => {
    const element = parent.current;
    if (element === null) return;
    const still = reducedMotion();
    const previous = before.current;
    const now = new Map<string, { readonly top: number; readonly band: number }>();
    for (const row of rows) {
      const node = element.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(row.key)}"]`);
      if (node === null) continue;
      const top = node.getBoundingClientRect().top;
      const was = previous.get(row.key);
      now.set(row.key, { top, band: row.band });
      if (was === undefined) continue;
      for (const animation of moving.current.get(row.key) ?? []) animation.cancel();
      moving.current.delete(row.key);
      if (still) continue;
      const started: Animation[] = [];
      const dy = was.top - top;
      if (Math.abs(dy) > 0.5) {
        started.push(
          node.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
            duration: MOVE_MS,
            easing: MOVE_EASING,
          }),
        );
      }
      if (row.band < was.band) {
        const lit = getComputedStyle(node).getPropertyValue("--linked").trim();
        started.push(
          node.animate([{ backgroundColor: lit }, { backgroundColor: "transparent" }], {
            duration: HIGHLIGHT_MS,
            easing: "ease-out",
          }),
        );
      }
      if (started.length > 0) moving.current.set(row.key, started);
    }
    before.current = now;
  });
  return parent;
}
