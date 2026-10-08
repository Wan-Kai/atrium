import type { LogEntry } from "@atrium/pi";
import { describe, expect, it } from "vitest";
import { createSessionLog } from "./session-log";

/** An entry the transcript does not show, under `parentId`. */
function entry(id: string, parentId: string | null): LogEntry {
  return { id, parentId, timestamp: 0, kind: "other" };
}

/** The ids of the log's current branch. */
function branchIds(log: ReturnType<typeof createSessionLog>): string[] {
  return log.branch().map((item) => item.id);
}

describe("createSessionLog", () => {
  it("starts empty, with no cursor and no branch", () => {
    const log = createSessionLog();

    expect(log.cursor).toBeUndefined();
    expect(log.branch()).toStrictEqual([]);
  });

  it("walks the branch from the leaf pi reports, root first, leaving other branches out", () => {
    const log = createSessionLog();

    log.append([entry("a", null), entry("b", "a"), entry("c", "b"), entry("d", "b"), entry("e", "d")], "c");

    expect(branchIds(log)).toStrictEqual(["a", "b", "c"]);
    expect(log.cursor).toBe("e");
  });

  it("says which entries are new, and lets the leaf move without new entries", () => {
    const log = createSessionLog();
    log.append([entry("a", null), entry("b", "a")], "b");

    expect([...log.append([entry("b", "a"), entry("c", "a")], "c")]).toStrictEqual(["c"]);
    expect(branchIds(log)).toStrictEqual(["a", "c"]);
    expect([...log.append([], "b")]).toStrictEqual([]);
    expect(branchIds(log)).toStrictEqual(["a", "b"]);
    expect(log.cursor).toBe("c");
  });

  it("keeps the cursor when pi returns nothing new", () => {
    const log = createSessionLog();
    log.append([entry("a", null)], "a");

    log.append([], "a");

    expect(log.cursor).toBe("a");
  });

  it("ends the branch at a parent it does not hold, and at a cycle", () => {
    const log = createSessionLog();

    log.append([entry("b", "missing"), entry("c", "b")], "c");
    expect(branchIds(log)).toStrictEqual(["b", "c"]);

    log.append([entry("x", "y"), entry("y", "x")], "x");
    expect(branchIds(log)).toStrictEqual(["y", "x"]);
  });

  it("has no branch when pi reports no leaf or one it does not hold", () => {
    const log = createSessionLog();
    log.append([entry("a", null)], null);

    expect(log.branch()).toStrictEqual([]);
    log.append([], "zzz");
    expect(log.branch()).toStrictEqual([]);
  });

  it("forgets everything when cleared", () => {
    const log = createSessionLog();
    log.append([entry("a", null)], "a");

    log.clear();

    expect(log.cursor).toBeUndefined();
    expect(log.branch()).toStrictEqual([]);
    expect([...log.append([entry("a", null)], "a")]).toStrictEqual(["a"]);
  });
});
