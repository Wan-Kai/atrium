import { z } from "zod";

/** Splits text into the characters a reader sees (grapheme clusters). */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A text's characters as a reader sees them.
 *
 * @remarks
 * Grapheme clusters, so a joined emoji, a flag or a letter with its accent is one; the rule
 * ML1's direction names are cut by, and every study text is bounded by (SPEC-0008, "ML2 定的细节").
 *
 * @sideEffects none
 * @param text - The text.
 * @returns Its characters, in order.
 */
export function splitSeen(text: string): string[] {
  return Array.from(GRAPHEMES.segment(text), ({ segment }) => segment);
}

/**
 * How many characters a reader sees in a text.
 *
 * @remarks
 * See `splitSeen`.
 *
 * @sideEffects none
 * @param text - The text.
 * @returns The count.
 */
export function seenLength(text: string): number {
  return splitSeen(text).length;
}

/**
 * A string of at most `max` characters as seen, and at least `min`.
 *
 * @remarks
 * The study texts' schema, in the protocol, the agent channel and the progress file alike, so
 * a text one accepts the others do (SPEC-0008, "ML2 定的细节").
 *
 * @sideEffects none
 * @param max - The most characters.
 * @param min - The fewest.
 * @returns The schema.
 */
export function seenText(max: number, min = 0) {
  return z.string().refine((text) => {
    const length = seenLength(text);
    return length >= min && length <= max;
  });
}
