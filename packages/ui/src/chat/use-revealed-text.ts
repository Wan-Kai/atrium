import { useEffect, useRef, useState } from "react";
import {
  REVEAL_FRAME_MS,
  type RevealState,
  advanceReveal,
  beginReveal,
  retargetReveal,
  revealSettled,
  visibleText,
} from "./text-reveal";

/**
 * The part of a streaming text to show this frame.
 *
 * @remarks
 * Wraps the pure reveal policy in `text-reveal.ts` with a frame clock: while text streams, each
 * animation frame (at most 60 per second) reveals more; the loop stops once it has caught up and
 * starts again when more arrives. When streaming ends everything is shown at once. Text seen for
 * the first time, such as a finished message, shows whole.
 *
 * Arriving text is taken in while rendering, not in an effect. An effect's update after each
 * delta would leave React one render behind every commit, and React counts 50 such commits in a
 * row as an endless loop: a burst of deltas that the browser dispatches back to back, as it does
 * with WebSocket frames queued while the page was busy, then threw React error #185 from the
 * session store's update.
 *
 * @sideEffects Schedules animation frames while catching up; re-renders the component on each.
 * @param text - All the text received.
 * @param streaming - Whether more may still arrive.
 * @returns The text to render.
 */
export function useRevealedText(text: string, streaming: boolean): string {
  const [state, setState] = useState<RevealState>(() => beginReveal(text));
  const shown = streaming ? retargetReveal(state, text) : shownWhole(state, text);
  // Settles in one extra pass of this render, since both helpers return the state they are given
  // once it fits.
  if (shown !== state) setState(shown);
  // Read and written only in the effect, so a new run continues where the last one stopped. It
  // takes in new text as the render did, and every frame at once, before React draws it.
  const latest = useRef(shown);

  useEffect(() => {
    let current = streaming ? retargetReveal(latest.current, text) : beginReveal(text);
    /**
     * Records a new reveal state and renders it.
     *
     * @remarks
     * Keeps the effect's copy, the ref and React's state in step.
     *
     * @sideEffects Sets component state.
     * @param next - The new state.
     */
    const publish = (next: RevealState): void => {
      current = next;
      latest.current = next;
      setState(next);
    };
    // The render already shows this, so only the copies take it; no update for React.
    latest.current = current;
    if (!streaming || revealSettled(current)) return undefined;
    let frame = 0;
    let last: number | null = null;
    /**
     * Reveals one frame's worth and schedules the next until caught up.
     *
     * @remarks
     * Frames closer than 1/60 s are skipped, so a 120 Hz display does not reveal twice as often.
     *
     * @sideEffects Updates the reveal; schedules a frame.
     * @param now - The frame's timestamp.
     */
    const tick = (now: number): void => {
      const elapsed = last === null ? REVEAL_FRAME_MS : now - last;
      if (elapsed >= REVEAL_FRAME_MS) {
        last = now;
        publish(advanceReveal(current, elapsed));
      }
      if (!revealSettled(current)) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, streaming]);

  return visibleText(shown, streaming);
}

/**
 * The reveal of a text that no longer streams: all of it.
 *
 * @remarks
 * Keeps the state it is given when that already shows all of this text, so rendering with it
 * schedules nothing.
 *
 * @sideEffects none
 * @param state - The current state.
 * @param text - The whole text.
 * @returns `state`, or a new state with everything revealed.
 */
function shownWhole(state: RevealState, text: string): RevealState {
  return state.target === text && revealSettled(state) ? state : beginReveal(text);
}
