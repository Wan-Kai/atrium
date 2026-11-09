import { type FocusEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { useClock } from "../state/clock";

/** Hover/focus ownership and the handlers attached to a card's shared DOM ancestor. */
interface HoverPresence {
  readonly present: boolean;
  /**
   * Set on the shared ancestor while the pointer is on the anchor or the card, for CSS to show the
   * card by (`group-data-[hovered]`), since `:hover` does not reach it from the top layer.
   */
  readonly "data-hovered": "" | undefined;
  readonly onMouseEnter: () => void;
  readonly onMouseLeave: (event: MouseEvent<HTMLElement>) => void;
  readonly onFocusCapture: (event: FocusEvent<HTMLElement>) => void;
  readonly onBlurCapture: (event: FocusEvent<HTMLElement>) => void;
}

/**
 * Keeps floating geometry alive only while a hover card is used or finishing its CSS exit.
 *
 * @remarks
 * CSS retains authority over visibility, delays and opacity. The floating helper must not undo
 * its fixed geometry before that exit finishes, nor observe hidden cards throughout streaming.
 * Reentry cancels retirement; hover and keyboard-visible focus independently keep a card alive.
 *
 * CSS shows the card by `data-hovered`, not `:hover`: Chromium does not count an element in the top
 * layer as hovering its DOM ancestors, so with `group-hover` a card faded out 250 ms after the
 * pointer moved onto it. The ancestor's mouse events do follow the DOM, so they tell it instead.
 *
 * @sideEffects Schedules one injected-clock retirement timer after leaving; cancels it on
 * reentry or unmount; changes local presence and pointer state.
 * @param exitMs - The existing CSS exit delay plus duration, in milliseconds.
 * @returns Presence and handlers for the ancestor shared by the anchor and card.
 */
export function useHoverPresence(exitMs: number): HoverPresence {
  const clock = useClock();
  const [present, setPresent] = useState(false);
  const [pointed, setPointed] = useState(false);
  const live = useRef(false);
  const hovered = useRef(false);
  const focused = useRef(false);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);

  /**
   * Retains the floating card while either of its owners is active.
   * @remarks Reentry must cancel a pending CSS-exit retirement rather than reinstall geometry.
   * @sideEffects Cancels the retirement timer and marks the card present.
   */
  const retain = (): void => {
    cancel.current?.();
    cancel.current = null;
    live.current = true;
    setPresent(true);
  };

  /**
   * Releases geometry after the existing CSS exit when neither hover nor visible focus owns it.
   * @remarks Moving within the shared ancestor is not a departure from the card.
   * @sideEffects Schedules or replaces one retirement timer; changes presence when it fires.
   */
  const retire = (): void => {
    cancel.current?.();
    cancel.current = null;
    if (!live.current || hovered.current || focused.current) return;
    cancel.current = clock.after(exitMs, () => {
      cancel.current = null;
      live.current = false;
      setPresent(false);
    });
  };

  return {
    present,
    "data-hovered": pointed ? "" : undefined,
    /**
     * Retains geometry while the pointer owns the card.
     * @remarks CSS still decides when the card becomes visible, keyed on `data-hovered`.
     * @sideEffects Marks hover ownership, sets `data-hovered` and cancels pending retirement.
     */
    onMouseEnter: () => {
      hovered.current = true;
      setPointed(true);
      retain();
    },
    /**
     * Retires pointer ownership after leaving the shared ancestor.
     * @remarks Movement into a top-layer descendant is still inside this card.
     * @sideEffects May clear `data-hovered` and schedule retirement through the injected clock.
     * @param event - The pointer's destination.
     */
    onMouseLeave: (event) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      hovered.current = false;
      setPointed(false);
      retire();
    },
    /**
     * Retains geometry for keyboard-visible focus.
     * @remarks Mouse focus must not keep a departed hover card alive.
     * @sideEffects Updates focus ownership and may retain or retire geometry.
     * @param event - The newly focused control.
     */
    onFocusCapture: (event) => {
      focused.current = event.target.matches(":focus-visible");
      if (focused.current) retain();
      else retire();
    },
    /**
     * Retires focus ownership once focus leaves the shared ancestor.
     * @remarks Moving between controls within the card is not a departure.
     * @sideEffects May schedule retirement through the injected clock.
     * @param event - The focus destination.
     */
    onBlurCapture: (event) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      focused.current = false;
      retire();
    },
  };
}
