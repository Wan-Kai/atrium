import type { FileUsage, UsageReader } from "@atrium/pi";
import type { SessionMetrics } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { type UsageEntry, createChildrenUsage } from "./children-usage";

/**
 * A session with a file named after it, and its parent if it has one.
 *
 * @sideEffects none
 * @param sessionId - Its id; its file is `/<id>.jsonl`.
 * @param parent - Its parent's id; `null` for none.
 * @param fields - What else it has: no file, archived, a baseline.
 * @returns The entry.
 */
function at(sessionId: string, parent: string | null, fields: Partial<UsageEntry> = {}): UsageEntry {
  return {
    sessionId,
    containerId: "w1",
    parent: parent === null ? null : { sessionId: parent, by: "user" },
    archived: false,
    file: `/${sessionId}.jsonl`,
    usageAfter: null,
    ...fields,
  };
}

/**
 * A reader answering from a table of files, and keeping what it was asked.
 *
 * @remarks
 * A file not in the table is missing; one mapped to `"fails"` throws.
 *
 * @sideEffects none
 * @param usage - Each file's usage.
 * @returns The reader and its reads.
 */
function reader(usage: Record<string, FileUsage | "fails">): { reader: UsageReader; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    reader: {
      read: (path, after) => {
        reads.push(`${path} after ${String(after)}`);
        const found = usage[path];
        if (found === "fails") return Promise.reject(new Error("unreadable"));
        return Promise.resolve(found ?? null);
      },
      forget: () => undefined,
    },
  };
}

describe("createChildrenUsage", () => {
  it("adds up what every descendant not archived produced since its baseline, and gives null without any", async () => {
    const entries = [
      at("main", null),
      at("a", "main", { usageAfter: "e9" }),
      at("a1", "a"),
      at("b", "main", { archived: true }),
      at("c", "main", { file: null }),
      at("d", "main"),
      at("lone", null),
    ];
    const { reader: files, reads } = reader({
      "/a.jsonl": { tokens: 100, cost: 0.5 },
      "/a1.jsonl": { tokens: 20, cost: 0.25 },
      "/b.jsonl": { tokens: 999, cost: 9 },
    });
    const totals: (readonly [string, SessionMetrics["children"]])[] = [];
    const usage = createChildrenUsage({
      entries: () => entries,
      reader: files,
      onTotals: (sessionId, figures) => totals.push([sessionId, figures]),
    });

    usage.refresh("main");
    usage.refresh("lone");
    await usage.settled();

    expect(totals).toStrictEqual([
      ["lone", null],
      ["main", { tokens: 120, cost: 0.75 }],
    ]);
    expect(reads).toStrictEqual(["/a.jsonl after e9", "/d.jsonl after null", "/a1.jsonl after null"]);
  });

  it("refreshes every session above one, and once more after a refresh asked for while one ran", async () => {
    const entries = [at("main", null), at("a", "main"), at("a1", "a")];
    const { reader: files, reads } = reader({
      "/a.jsonl": { tokens: 1, cost: 0 },
      "/a1.jsonl": { tokens: 2, cost: 0 },
    });
    const totals: (readonly [string, SessionMetrics["children"]])[] = [];
    const children = createChildrenUsage({
      entries: () => entries,
      reader: files,
      onTotals: (sessionId, figures) => totals.push([sessionId, figures]),
    });

    children.refreshAbove("a1");
    children.refresh("main");
    await children.settled();

    expect(totals).toStrictEqual([
      ["a", { tokens: 2, cost: 0 }],
      ["main", { tokens: 3, cost: 0 }],
      ["main", { tokens: 3, cost: 0 }],
    ]);
    expect(reads.filter((read) => read.startsWith("/a.jsonl"))).toHaveLength(2);
  });

  it("starts no second read of a session's children while one is under way", async () => {
    const gate = Promise.withResolvers<void>();
    const reads: string[] = [];
    const children = createChildrenUsage({
      entries: () => [at("main", null), at("a", "main")],
      reader: {
        read: async (path) => {
          reads.push(path);
          await gate.promise;
          return { tokens: 1, cost: 0 };
        },
        forget: () => undefined,
      },
      onTotals: () => undefined,
    });

    children.refresh("main");
    children.refresh("main");
    expect(reads).toStrictEqual(["/a.jsonl"]);
    gate.resolve();
    await children.settled();

    expect(reads).toStrictEqual(["/a.jsonl", "/a.jsonl"]);
  });

  it("keeps the totals as they were when a file cannot be read", async () => {
    const { reader: files } = reader({ "/a.jsonl": "fails" });
    const totals: unknown[] = [];
    const usage = createChildrenUsage({
      entries: () => [at("main", null), at("a", "main")],
      reader: files,
      onTotals: (sessionId, figures) => totals.push([sessionId, figures]),
    });

    usage.refresh("main");
    await usage.settled();

    expect(totals).toStrictEqual([]);
  });
});
