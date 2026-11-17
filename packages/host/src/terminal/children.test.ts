import { describe, expect, it } from "vitest";
import { childPidsOf, descendantsOf } from "./children";

/** A `ps -axo pid=,ppid=` table with the rows given. */
function table(rows: ReadonlyArray<readonly [number, number]>): () => Promise<string> {
  return async () => rows.map(([pid, ppid]) => `${pid} ${ppid}`).join("\n");
}

/** A table with one shell and no children, and blank lines. */
const idleTable = async (): Promise<string> => "  1 0\n\n 4242 1 \n";

/** A shell with children, a grandchild and a great-grandchild. */
const treeTable = table([
  [4242, 1],
  [4300, 4242],
  [4301, 4300],
  [4302, 4301],
  [4303, 4242],
]);

/** A table that claims two pids are each other's parent. */
const cycleTable = async (): Promise<string> => "4300 4301\n4301 4300\n";

/** A shell with 300 children. */
const wideTable = async (): Promise<string> =>
  Array.from({ length: 300 }, (_, index) => `${String(5000 + index)} 4242`).join("\n");

/** A table whose parent column is not a number. */
const badNumberTable = async (): Promise<string> => "4300 abc\n4301 4242\n";

/** A table whose columns are padded. */
const spacedTable = async (): Promise<string> => "   4300    4242\n";

/** A table where a pid starts with the parent's digits. */
const prefixedTable = async (): Promise<string> => "4300 42420\n4301 4242\n";

/** A table with rows that are not two numbers. */
const malformedTable = async (): Promise<string> => "4300\nnot numbers\n4301 4242extra\n";

/** A table `ps` would never print, because it failed. */
const failedTable = async (): Promise<string> => {
  throw new Error("ps: not found");
};

describe("childPidsOf", () => {
  it("returns the pids whose parent is the shell", async () => {
    const rows = table([
      [1, 0],
      [4242, 1],
      [4300, 4242],
      [4301, 4242],
    ]);
    await expect(childPidsOf(4242, { table: rows })).resolves.toStrictEqual([4300, 4301]);
  });

  it("returns none for an idle shell, and skips blank lines", async () => {
    await expect(childPidsOf(4242, { table: idleTable })).resolves.toStrictEqual([]);
  });

  it("counts a program the shell started as its child", async () => {
    const rows = table([
      [4300, 4242],
      [4242, 1],
      [4301, 4300],
    ]);
    // Only the shell's own children: a grandchild belongs to its parent, not to the shell.
    await expect(childPidsOf(4242, { table: rows })).resolves.toStrictEqual([4300]);
  });

  it("ignores a row that is not two numbers", async () => {
    await expect(childPidsOf(4242, { table: malformedTable })).resolves.toStrictEqual([]);
  });

  it("reports a failed table instead of guessing", async () => {
    await expect(childPidsOf(4242, { table: failedTable })).rejects.toThrow("ps: not found");
  });
});

describe("childPidsOf on odd tables", () => {
  it("reads pids with leading spaces and several spaces between columns", async () => {
    await expect(childPidsOf(4242, { table: spacedTable })).resolves.toStrictEqual([4300]);
  });

  it("does not confuse a pid that shares a prefix with the parent", async () => {
    await expect(childPidsOf(4242, { table: prefixedTable })).resolves.toStrictEqual([4301]);
  });
});

describe("a table with rows that are not pids", () => {
  it("skips a parent that is not a number", async () => {
    await expect(childPidsOf(4242, { table: badNumberTable })).resolves.toStrictEqual([4301]);
    await expect(descendantsOf(4242, { table: badNumberTable })).resolves.toStrictEqual([4301]);
  });
});

describe("descendantsOf", () => {
  it("walks children, grandchildren and deeper, each once", async () => {
    const found = await descendantsOf(4242, { table: treeTable });
    expect(found.toSorted((a, b) => a - b)).toStrictEqual([4300, 4301, 4302, 4303]);
  });

  it("comes back empty for a shell that started nothing", async () => {
    await expect(descendantsOf(4242, { table: idleTable })).resolves.toStrictEqual([]);
  });

  it("does not loop on a table that names a cycle", async () => {
    // A table that claims a cycle must end: each pid is added once, and the walk stops.
    const found = await descendantsOf(4300, { table: cycleTable });
    expect(found.toSorted((a, b) => a - b)).toStrictEqual([4300, 4301]);
  });

  it("stops at its cap instead of walking a huge tree", async () => {
    // 300 children of the shell: at most the cap comes back.
    const found = await descendantsOf(4242, { table: wideTable });
    expect(found.length).toBeLessThanOrEqual(200);
  });

  it("ignores rows that are not two numbers", async () => {
    await expect(descendantsOf(4242, { table: malformedTable })).resolves.toStrictEqual([]);
  });

  it("reports a failed table instead of guessing", async () => {
    await expect(descendantsOf(4242, { table: failedTable })).rejects.toThrow("ps: not found");
  });
});
