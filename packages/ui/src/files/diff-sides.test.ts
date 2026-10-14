import type { DiffFile, DiffHunk, DiffLine } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { colourable, hunkSides, hunkTokens } from "./diff-sides";
import type { Token } from "./highlight";

/**
 * A hunk of the lines given, as `kind:text`.
 *
 * @sideEffects none
 * @param lines - The lines.
 * @returns The hunk.
 */
function hunk(...lines: string[]): DiffHunk {
  return {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    lines: lines.map((line): DiffLine => {
      const [kind, text] = line.split(":") as [DiffLine["kind"], string];
      return { kind, text, oldNumber: null, newNumber: null };
    }),
  };
}

/**
 * A side's lines as tokens naming where each came from.
 *
 * @sideEffects none
 * @param side - The side's name.
 * @param count - How many lines.
 * @returns The lines.
 */
function side(name: string, count: number): Token[][] {
  return Array.from({ length: count }, (_, index) => [[`${name}${index}`, null, null]]);
}

describe("hunkSides", () => {
  it("puts context and removed lines on the old side, context and added on the new", () => {
    expect(hunkSides(hunk("context:a", "del:b", "add:c", "context:d", "add:e"))).toStrictEqual([
      "a\nb\nd",
      "a\nc\nd\ne",
    ]);
  });
});

describe("hunkTokens", () => {
  it("takes a removed line's tokens from the old side, others from the new, keeping count on both", () => {
    const lines = hunkTokens(
      hunk("context:a", "add:b", "del:c", "del:d", "add:e", "context:f"),
      side("o", 4),
      side("n", 4),
    );

    expect(lines.map((line) => line?.[0]?.[0])).toStrictEqual(["n0", "n1", "o1", "o2", "n2", "n3"]);
  });

  it("leaves a line without tokens where its side came back short", () => {
    expect(hunkTokens(hunk("add:a", "add:b"), [], side("n", 1)).map((line) => line?.[0]?.[0])).toStrictEqual([
      "n0",
      undefined,
    ]);
  });
});

/**
 * A changed text file with hunks of the lines given.
 *
 * @sideEffects none
 * @param counts - Each hunk's line count.
 * @returns The file.
 */
function file(...counts: number[]): DiffFile {
  return {
    path: "a.ts",
    oldPath: null,
    status: "modified",
    added: 0,
    removed: 0,
    content: "text",
    hunks: counts.map((count) => hunk(...Array.from({ length: count }, () => "add:x"))),
  };
}

describe("colourable", () => {
  it("colours a text file's diff of up to 5000 lines, not an empty, binary or too large one", () => {
    expect([
      colourable(file(4000, 1000)),
      colourable(file(4000, 1001)),
      colourable(file()),
      colourable({ ...file(1), content: "binary" }),
      colourable({ ...file(1), content: "too_large" }),
    ]).toStrictEqual([true, false, false, false, false]);
  });
});
