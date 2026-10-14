import type { DiffFile } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { type ChangeNode, changeTree, restoredDirs, sortEntries, treeOrder } from "./trees";

/**
 * A changed file.
 *
 * @sideEffects none
 * @param path - Its path.
 * @param added - Lines added.
 * @param removed - Lines removed.
 * @returns The file.
 */
function changed(path: string, added = 1, removed = 0): DiffFile {
  return { path, oldPath: null, status: "modified", added, removed, content: "text", hunks: [] };
}

/**
 * A tree's rows as text: a directory's name, totals and rows, a file's name and path.
 *
 * @sideEffects none
 * @param rows - The rows.
 * @returns Them, nested.
 */
function shape(rows: readonly ChangeNode[]): unknown[] {
  return rows.map((row) =>
    row.kind === "dir"
      ? [row.name, row.path, row.added, row.removed, shape(row.children)]
      : `${row.name} ${row.file.path}`,
  );
}

describe("changeTree", () => {
  it("puts directories first, each level by code point, and counts every file under a directory", () => {
    const tree = changeTree([
      changed("README.md", 3, 0),
      changed("src/z.ts", 2, 0),
      changed("b.ts", 1, 1),
      changed("src/a/x.ts", 4, 2),
      changed("src/B.ts", 5, 1),
      changed("Docs/y.md", 6, 0),
    ]);

    expect(shape(tree)).toStrictEqual([
      ["Docs", "Docs", 6, 0, ["y.md Docs/y.md"]],
      ["src", "src", 11, 3, [["a", "src/a", 4, 2, ["x.ts src/a/x.ts"]], "B.ts src/B.ts", "z.ts src/z.ts"]],
      "README.md README.md",
      "b.ts b.ts",
    ]);
  });

  it("joins a directory holding only one directory and no files to it, at any depth", () => {
    const tree = changeTree([
      changed("packages/ui/src/a.ts"),
      changed("packages/ui/src/chat/b.ts"),
      changed("packages/ui/src/chat/deep/er/c.ts"),
      changed("packages/host/d.ts"),
    ]);

    expect(shape(tree)).toStrictEqual([
      [
        "packages",
        "packages",
        4,
        0,
        [
          ["host", "packages/host", 1, 0, ["d.ts packages/host/d.ts"]],
          [
            "ui/src",
            "packages/ui/src",
            3,
            0,
            [
              [
                "chat",
                "packages/ui/src/chat",
                2,
                0,
                [
                  ["deep/er", "packages/ui/src/chat/deep/er", 1, 0, ["c.ts packages/ui/src/chat/deep/er/c.ts"]],
                  "b.ts packages/ui/src/chat/b.ts",
                ],
              ],
              "a.ts packages/ui/src/a.ts",
            ],
          ],
        ],
      ],
    ]);
  });

  it("joins a lone chain from the top, and has no rows for no files", () => {
    expect([shape(changeTree([changed("a/b/c.ts")])), changeTree([])]).toStrictEqual([
      [["a/b", "a/b", 1, 0, ["c.ts a/b/c.ts"]]],
      [],
    ]);
  });
});

describe("treeOrder", () => {
  it("lists the files as the tree's rows show them", () => {
    const files = [changed("z.ts"), changed("src/b.ts"), changed("a.ts"), changed("src/a/c.ts")];

    expect(treeOrder(changeTree(files)).map((file) => file.path)).toStrictEqual([
      "src/a/c.ts",
      "src/b.ts",
      "a.ts",
      "z.ts",
    ]);
  });
});

describe("sortEntries", () => {
  it("puts directories first, then names with numbers by value, a link among the files", () => {
    const sorted = sortEntries([
      { name: "file10.txt", kind: "file" },
      { name: "b", kind: "link" },
      { name: "zeta", kind: "dir" },
      { name: "file2.txt", kind: "file" },
      { name: ".env", kind: "file" },
      { name: "Alpha", kind: "dir" },
      { name: "a", kind: "file" },
    ]);

    expect(sorted.map((entry) => entry.name)).toStrictEqual([
      "Alpha",
      "zeta",
      ".env",
      "a",
      "b",
      "file2.txt",
      "file10.txt",
    ]);
  });
});

describe("restoredDirs", () => {
  it("keeps the expanded directories at most five levels down", () => {
    expect([...restoredDirs(["a", "a/b/c/d/e", "a/b/c/d/e/f", "x/y"])]).toStrictEqual(["a", "a/b/c/d/e", "x/y"]);
  });
});
