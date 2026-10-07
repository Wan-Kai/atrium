/**
 * Paced reveal of streaming text (SPEC-0001, "平滑流式输出"; design-language, "动效").
 *
 * Deltas arrive in bursts. Painting each one as it lands makes the bursts visible, so arrival
 * only moves the target, and how much is shown grows each frame in proportion to what is still
 * hidden: the backlog shrinks with a time constant of 150 ms, so a burst speeds the text up
 * smoothly and the display trails steady output by about that much. The approach follows Paseo's
 * `packages/app/src/agent-stream/text-reveal.ts` (Apache-2.0). Everything here is pure; the hook
 * in `use-revealed-text.ts` adds the frame clock.
 */

/** The time constant the backlog shrinks with: one horizon reveals about two thirds of it. */
export const REVEAL_HORIZON_MS = 150;

/** Reveal at most once per 60 Hz frame, even on faster displays. */
export const REVEAL_FRAME_MS = 1000 / 60;

/** A stalled frame (hidden window, busy main thread) counts as at most this long. */
const MAX_FRAME_MS = 250;

/** How far a text has been revealed. */
export interface RevealState {
  /** All the text received so far. */
  readonly target: string;
  /** How many UTF-16 units of it are shown. Only grows while the target does. */
  readonly revealed: number;
}

/** Splits text into user-perceived characters, so a cut never breaks an emoji or a combined glyph. */
// Stryker disable next-line ObjectLiteral: grapheme is the default granularity; it is spelled out for the reader.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Starts revealing a text that is shown whole at once.
 *
 * @remarks
 * Only growth is paced: a finished message, a snapshot after reconnecting or a remounted
 * component paint everything immediately, with no special case each.
 *
 * @sideEffects none
 * @param text - The text so far.
 * @returns A state with everything revealed.
 */
export function beginReveal(text: string): RevealState {
  return { target: text, revealed: text.length };
}

/**
 * Points the reveal at newly arrived text, keeping how much is shown.
 *
 * @remarks
 * A target that is not a continuation means another message took this place; then at most its
 * whole length stays revealed.
 *
 * @sideEffects none
 * @param state - The current state.
 * @param text - All the text received now.
 * @returns The new state.
 */
export function retargetReveal(state: RevealState, text: string): RevealState {
  if (text === state.target) return state;
  return { target: text, revealed: Math.min(state.revealed, text.length) };
}

/**
 * Reveals one frame's worth of the backlog.
 *
 * @remarks
 * The step is proportional to the backlog, so a burst makes the text catch up faster instead of
 * jumping, with at least one unit so the tail always finishes.
 *
 * @sideEffects none
 * @param state - The current state.
 * @param elapsedMs - Time since the previous frame.
 * @returns The new state.
 */
export function advanceReveal(state: RevealState, elapsedMs: number): RevealState {
  const backlog = state.target.length - state.revealed;
  if (backlog <= 0 || elapsedMs <= 0) return state;
  const elapsed = Math.min(elapsedMs, MAX_FRAME_MS);
  // A frame of a whole horizon or more covers the backlog; the cap below stops the overshoot.
  const step = Math.max(1, Math.ceil((backlog * elapsed) / REVEAL_HORIZON_MS));
  return { target: state.target, revealed: Math.min(state.target.length, state.revealed + step) };
}

/**
 * Whether everything received is shown.
 *
 * @remarks
 * The frame loop stops once this holds and restarts when more text arrives.
 *
 * @sideEffects none
 * @param state - The state.
 * @returns Whether the backlog is empty.
 */
export function revealSettled(state: RevealState): boolean {
  return state.revealed >= state.target.length;
}

/**
 * The text to paint: what is revealed, cut where no character is split.
 *
 * @remarks
 * The cut moves back to the start of the grapheme it would split; the counter itself keeps
 * growing, so a long cluster cannot stall the reveal. While text is still streaming, a trailing
 * high surrogate, zero-width joiner or half of a flag waits for the rest of its character.
 *
 * @sideEffects none
 * @param state - The state.
 * @param streaming - Whether more text may still arrive.
 * @returns The visible text.
 */
export function visibleText(state: RevealState, streaming: boolean): string {
  if (state.revealed < state.target.length) {
    // Not past the end, so a segment always contains the cut.
    // Stryker disable next-line OptionalChaining: see above.
    return state.target.slice(0, graphemes.segment(state.target).containing(state.revealed)?.index ?? 0);
  }
  return streaming ? withoutUnfinishedCharacter(state.target) : state.target;
}

/**
 * Drops a trailing fragment that cannot stand on its own yet.
 *
 * @remarks
 * A delta may end anywhere, even inside a character; only fragments that certainly wait for
 * more are held back.
 *
 * @sideEffects none
 * @param text - Everything received.
 * @returns The text without such a fragment.
 */
function withoutUnfinishedCharacter(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return text.slice(0, -1);
  if (last === 0x200d) return text.slice(0, -1);
  let flags = 0;
  for (let end = text.length; end >= 2; end -= 2) {
    // `end >= 2` keeps the index inside the text, so there is always a code point.
    const point = text.codePointAt(end - 2) ?? 0;
    if (point < 0x1f1e6 || point > 0x1f1ff) break;
    flags += 1;
  }
  return flags % 2 === 1 ? text.slice(0, -2) : text;
}
