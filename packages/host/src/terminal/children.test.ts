import { describe, expect, it } from "vitest";
import { childPidsOf } from "./children";

/** A `ps -axo pid=,ppid=` table with the rows given. */
function table(rows: ReadonlyArray<readonly [number, number]>): () => Promise<string> {
  return async () => rows.map(([pid, ppid]) => `${pid} ${ppid}`).join("\n");
}

/** A table with one shell and no children, and blank lines. */
const idleTable = async (): Promise<string> => "  1 0\n\n 4242 1 \n";

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
