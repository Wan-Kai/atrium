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
 * (SPEC-0001, "滚动与长会话"). The scroll the view made itself to stay at the bottom also fires an
 * event, a frame later; if the content grew again in between, that position is no longer the
 * bottom, but the user did not scroll, so the state stays.
 *
 * @sideEffects none
 * @param state - The current state.
 * @param metrics - The container's position after scrolling.
 * @param ownScrollTop - Where the view last scrolled itself, if that scroll's event is still due.
 * @returns The new state.
 */
export function afterScroll(
  state: FollowState,
  metrics: ScrollMetrics,
  ownScrollTop: number | null = null,
): FollowState {
  if (ownScrollTop !== null && Math.abs(metrics.scrollTop - ownScrollTop) <= 1) return state;
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
 * text, late-loading images, code highlighting and folds alike; the container is watched too, as
 * it shrinks when what is under it grows (SPEC-0001, "滚动与长会话"). The observer runs after each
 * frame's layout and before its paint, so the view never shows a frame off the bottom.
 * Programmatic scrolls also fire `scroll` events; they land at the bottom, so they keep following on.
 * The container must turn off the browser's scroll anchoring (`overflow-anchor: none`): its
 * scrolls are not the view's own, and one landing off the bottom would stop following.
 *
 * @sideEffects Observes the content's and the container's size and the container's scroll events;
 * scrolls the container while following.
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
    /** Where the view last scrolled itself, until that scroll's event arrives. */
    let ownScrollTop: number | null = null;
    /**
     * Scrolls to the end and remembers where that landed.
     *
     * @remarks
     * The browser clamps the value, so the position is read back.
     *
     * @sideEffects Scrolls the container.
     */
    const scrollToBottom = (): void => {
      scroller.scrollTop = scroller.scrollHeight;
      ownScrollTop = scroller.scrollTop;
    };
    scrollToEnd.current = () => {
      scrollToBottom();
      update({ following: true, unseen: false });
    };
    const listening = new AbortController();
    scroller.addEventListener(
      "scroll",
      () => {
        const next = afterScroll(latest.current, scroller, ownScrollTop);
        ownScrollTop = null;
        update(next);
      },
      { passive: true, signal: listening.signal },
    );
    const observer = new ResizeObserver((entries) => {
      // The container alone changing size brings nothing new to see.
      const grew = entries.some((entry) => entry.target === inner);
      const next = grew ? afterGrowth(latest.current) : latest.current;
      if (next.following) scrollToBottom();
      update(next);
    });
    observer.observe(inner);
    observer.observe(scroller);
    return () => {
      listening.abort();
      observer.disconnect();
      scrollToEnd.current = () => undefined;
    };
  }, [container, content]);

  return { ...state, jumpToBottom: () => scrollToEnd.current() };
}
