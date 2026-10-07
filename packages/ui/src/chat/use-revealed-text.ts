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
 * @sideEffects Schedules animation frames while catching up; re-renders the component on each.
 * @param text - All the text received.
 * @param streaming - Whether more may still arrive.
 * @returns The text to render.
 */
export function useRevealedText(text: string, streaming: boolean): string {
  const [state, setState] = useState<RevealState>(() => beginReveal(text));
  // Read and written only in the effect, so a new run continues where the last one stopped.
  const latest = useRef(state);

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
    publish(current);
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

  return visibleText(state, streaming);
}
