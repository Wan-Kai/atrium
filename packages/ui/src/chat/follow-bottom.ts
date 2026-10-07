import { type RefObject, useEffect, useRef, useState } from "react";

/** Where a scroll container is. */
export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Whether the view follows new content, and whether some arrived unseen. */
export interface FollowState {
  readonly following: boolean;
  /** New content arrived while not following; the "回到底部" button shows a dot. */
  readonly unseen: boolean;
}

/** Within this many pixels of the end counts as at the bottom. */
const NEAR_BOTTOM_PX = 24;

/**
 * Whether a container is scrolled to its end.
 *
 * @remarks
 * A small allowance absorbs fractional pixels and a line that is still growing.
 *
 * @sideEffects none
 * @param metrics - The container's position.
 * @returns Whether it is at the bottom.
 */
export function atBottom(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= NEAR_BOTTOM_PX;
}

/**
 * Updates the follow state after the container scrolled.
 *
 * @remarks
 * Scrolling up stops following; coming back to the bottom resumes it and clears the dot
 * (SPEC-0001, "滚动与长会话").
 *
 * @sideEffects none
 * @param state - The current state.
 * @param metrics - The container's position after scrolling.
 * @returns The new state.
 */
export function afterScroll(state: FollowState, metrics: ScrollMetrics): FollowState {
  const bottom = atBottom(metrics);
  return { following: bottom, unseen: bottom ? false : state.unseen };
}

/**
 * Updates the follow state after the content grew.
 *
 * @remarks
 * While following, the caller scrolls to the end; otherwise the growth is noted as unseen.
 *
 * @sideEffects none
 * @param state - The current state.
 * @returns The new state.
 */
export function afterGrowth(state: FollowState): FollowState {
  return state.following ? state : { following: false, unseen: true };
}

/**
 * Keeps a scroll container at its end while the user has not scrolled away.
 *
 * @remarks
 * Content changes are watched with a ResizeObserver on the content element, which sees streamed
 * text, late-loading images and code highlighting alike. Programmatic scrolls also fire `scroll`
 * events; they land at the bottom, so they keep following on.
 *
 * @sideEffects Observes the content's size and the container's scroll events; scrolls the
 * container while following.
 * @param container - The scrolling element.
 * @param content - The element whose size grows.
 * @returns The state, and a function that scrolls to the end and follows again.
 */
export function useFollowBottom(
  container: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
): FollowState & { readonly jumpToBottom: () => void } {
  const [state, setState] = useState<FollowState>({ following: true, unseen: false });
  // The observers read the latest state without waiting for React to re-render.
  const latest = useRef(state);
  // Set by the effect, which owns the elements; called from the button's click handler.
  const scrollToEnd = useRef<() => void>(() => undefined);

  useEffect(() => {
    const scroller = container.current;
    const inner = content.current;
    if (scroller === null || inner === null) return undefined;
    /**
     * Stores and publishes a new state.
     *
     * @remarks
     * Skips identical states, so scrolling at the bottom does not re-render.
     *
     * @sideEffects Sets component state.
     * @param next - The new state.
     */
    const update = (next: FollowState): void => {
      if (next.following === latest.current.following && next.unseen === latest.current.unseen) return;
      latest.current = next;
      setState(next);
    };
    scrollToEnd.current = () => {
      scroller.scrollTop = scroller.scrollHeight;
      update({ following: true, unseen: false });
    };
    const listening = new AbortController();
    scroller.addEventListener("scroll", () => update(afterScroll(latest.current, scroller)), {
      passive: true,
      signal: listening.signal,
    });
    const observer = new ResizeObserver(() => {
      const next = afterGrowth(latest.current);
      if (next.following) scroller.scrollTop = scroller.scrollHeight;
      update(next);
    });
    observer.observe(inner);
    return () => {
      listening.abort();
      observer.disconnect();
      scrollToEnd.current = () => undefined;
    };
  }, [container, content]);

  return { ...state, jumpToBottom: () => scrollToEnd.current() };
}
