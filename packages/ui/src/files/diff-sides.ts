import type { DiffFile, DiffHunk } from "@atrium/protocol";
import type { Token, TokenLines } from "./highlight";

/** Past this many lines a file's diff shows without colours (SPEC-0001, "M1.12 的文件与更改 · 查看标签"). */
const DIFF_HIGHLIGHT_LINES = 5000;

/**
 * A hunk's two sides as texts: the old (context and removed lines) and the new (context and added).
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"): each side is coloured as a whole, so a line is read
 * among its neighbours; a removed line among the old ones, an added or context line among the new.
 *
 * @sideEffects none
 * @param hunk - The hunk.
 * @returns The two texts.
 */
export function hunkSides(hunk: DiffHunk): readonly [old: string, new: string] {
  const old = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
  const added = hunk.lines.filter((line) => line.kind !== "del").map((line) => line.text);
  return [old.join("\n"), added.join("\n")];
}

/**
 * Each line of a hunk's tokens, from its two sides coloured.
 *
 * @remarks
 * See `hunkSides`.
 *
 * @sideEffects none
 * @param hunk - The hunk.
 * @param old - The old side's lines of tokens.
 * @param added - The new side's.
 * @returns Each line's tokens, in the hunk's order; `undefined` where a side came back short.
 */
export function hunkTokens(hunk: DiffHunk, old: TokenLines, added: TokenLines): (readonly Token[] | undefined)[] {
  let inOld = 0;
  let inNew = 0;
  return hunk.lines.map((line) => {
    if (line.kind === "del") return old[inOld++];
    if (line.kind === "context") inOld++;
    return added[inNew++];
  });
}

/**
 * Whether a file's diff is coloured.
 *
 * @remarks
 * Text only, and at most `DIFF_HIGHLIGHT_LINES` lines in its hunks.
 *
 * @sideEffects none
 * @param file - The file.
 * @returns Whether to colour it.
 */
export function colourable(file: DiffFile): boolean {
  const lines = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  return file.content === "text" && lines > 0 && lines <= DIFF_HIGHLIGHT_LINES;
}
