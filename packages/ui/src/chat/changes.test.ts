import type { DiffFile } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { diffModeOf, diffTotals, formatDiffCount, splitPath } from "./changes";

describe("formatDiffCount", () => {
  it("writes counts past 999 compactly, as Paseo does", () => {
    expect([0, 7, 999, 1000, 1234, 12_345, 999_999, 1_250_000].map(formatDiffCount)).toStrictEqual([
      "0",
      "7",
      "999",
      "1k",
      "1.2k",
      "12.3k",
      "1m",
      "1.3m",
    ]);
  });
});

describe("diffModeOf", () => {
  it("shows uncommitted changes when there are some, else the branch's commits", () => {
    expect(diffModeOf(null, true)).toBe("uncommitted");
    expect(diffModeOf(null, false)).toBe("base");
  });

  it("keeps a choice only while the tree is as dirty as when it was made", () => {
    expect(diffModeOf({ mode: "base", dirty: true }, true)).toBe("base");
    expect(diffModeOf({ mode: "base", dirty: true }, false)).toBe("base");
    expect(diffModeOf({ mode: "uncommitted", dirty: false }, false)).toBe("uncommitted");
    expect(diffModeOf({ mode: "uncommitted", dirty: false }, true)).toBe("uncommitted");
    expect(diffModeOf({ mode: "base", dirty: false }, true)).toBe("uncommitted");
    expect(diffModeOf({ mode: "uncommitted", dirty: true }, false)).toBe("base");
  });
});

describe("splitPath", () => {
  it("parts a path into its name and the directory it is in", () => {
    expect(splitPath("src/chat/a.ts")).toStrictEqual({ name: "a.ts", dir: "src/chat/" });
    expect(splitPath("README.md")).toStrictEqual({ name: "README.md", dir: "" });
  });
});

/** A file adding and removing lines. */
function file(added: number, removed: number): DiffFile {
  return { path: "a", oldPath: null, status: "modified", added, removed, content: "binary", hunks: [] };
}

describe("diffTotals", () => {
  it("adds up the files' lines", () => {
    expect(diffTotals([file(1, 2), file(3, 0)])).toStrictEqual({ added: 4, removed: 2 });
    expect(diffTotals([])).toStrictEqual({ added: 0, removed: 0 });
  });
});
