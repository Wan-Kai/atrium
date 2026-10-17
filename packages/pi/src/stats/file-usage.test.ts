import { createTempDir, type TempDir } from "@atrium/testkit";
import { appendFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUsageReader, lastEntryId } from "./file-usage";

const dirs: TempDir[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await dir.cleanup();
});

/**
 * A session file path in a fresh temporary directory.
 *
 * @sideEffects Creates the directory, removed after the test.
 * @returns The path, not written yet.
 */
async function sessionPath(): Promise<string> {
  const dir = await createTempDir("usage");
  dirs.push(dir);
  return join(dir.path, "session.jsonl");
}

/**
 * pi-ai's usage of a request.
 *
 * @sideEffects none
 * @param input - Input tokens; the other kinds are 1, 2 and 3.
 * @param cost - The cost in US dollars.
 * @returns The usage.
 */
function usage(input: number, cost: number): Record<string, unknown> {
  return { input, output: 1, cacheRead: 2, cacheWrite: 3, totalTokens: input + 6, cost: { total: cost } };
}

/**
 * Session file lines, as pi writes them.
 *
 * @sideEffects none
 * @param entries - The entries.
 * @returns The text, one line each.
 */
function lines(...entries: readonly Record<string, unknown>[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

const header = { type: "session", id: "s1", cwd: "/repo" };

describe("createUsageReader", () => {
  it("adds up what pi counts: replies, tool results, compactions, branch summaries and usage entries", async () => {
    const path = await sessionPath();
    await writeFile(
      path,
      lines(
        header,
        { type: "message", id: "u1", message: { role: "user", content: "hi", usage: usage(1000, 9) } },
        { type: "message", id: "a1", message: { role: "assistant", usage: usage(10, 0.5) } },
        { type: "message", id: "t1", message: { role: "toolResult", usage: usage(20, 0.25) } },
        { type: "compaction", id: "c1", usage: usage(30, 0.125) },
        { type: "branch_summary", id: "b1", usage: usage(40, 0.0625) },
        { type: "usage", id: "x1", usage: usage(50, 0.03125) },
        { type: "custom_message", id: "m1", usage: usage(1000, 9) },
        { type: "compaction", id: "c2" },
      ),
    );

    expect(await createUsageReader().read(path, null)).toStrictEqual({
      tokens: 10 + 20 + 30 + 40 + 50 + 5 * 6,
      cost: 0.5 + 0.25 + 0.125 + 0.0625 + 0.03125,
    });
  });

  it("leaves out the history up to and including the baseline, and counts nothing for a baseline the file lacks", async () => {
    const path = await sessionPath();
    await writeFile(
      path,
      lines(
        header,
        { type: "message", id: "a1", message: { role: "assistant", usage: usage(10, 1) } },
        { type: "label", id: "l1" },
        { type: "message", id: "a2", message: { role: "assistant", usage: usage(20, 2) } },
      ),
    );
    const reader = createUsageReader();

    expect(await reader.read(path, "l1")).toStrictEqual({ tokens: 26, cost: 2 });
    expect(await reader.read(path, "a2")).toStrictEqual({ tokens: 0, cost: 0 });
    expect(await reader.read(path, "gone")).toStrictEqual({ tokens: 0, cost: 0 });
    expect(await reader.read(path, null)).toStrictEqual({ tokens: 42, cost: 3 });
  });

  it("reads what pi appended since, counts a line only once it ends, and starts again on a file that shrank", async () => {
    const path = await sessionPath();
    const first = { type: "message", id: "a1", message: { role: "assistant", usage: usage(10, 1) } };
    const second = JSON.stringify({ type: "message", id: "a2", message: { role: "assistant", usage: usage(20, 2) } });
    await writeFile(path, lines(header, first));
    const reader = createUsageReader();

    expect(await reader.read(path, null)).toStrictEqual({ tokens: 16, cost: 1 });
    await appendFile(path, second.slice(0, 20));
    expect(await reader.read(path, null)).toStrictEqual({ tokens: 16, cost: 1 });
    await appendFile(path, `${second.slice(20)}\nnot json\n[1]\n`);
    expect(await reader.read(path, null)).toStrictEqual({ tokens: 42, cost: 3 });
    await writeFile(path, lines(header, { type: "usage", id: "x1", usage: usage(1, 0.5) }));
    expect(await reader.read(path, null)).toStrictEqual({ tokens: 7, cost: 0.5 });
  });

  it("reads a missing file as nothing known, and a forgotten one from the start", async () => {
    const path = await sessionPath();
    const reader = createUsageReader();

    expect(await reader.read(path, null)).toBeNull();
    await writeFile(path, lines(header, { type: "usage", id: "x1", usage: usage(4, 1) }));
    expect(await reader.read(path, null)).toStrictEqual({ tokens: 10, cost: 1 });
    reader.forget(path);
    // Rewritten longer, as a reader that kept its place would misread from the middle.
    await writeFile(
      path,
      lines(header, { type: "usage", id: "y1", usage: usage(5, 2) }, { type: "usage", id: "y2", usage: usage(6, 4) }),
    );
    expect(await reader.read(path, null)).toStrictEqual({ tokens: 23, cost: 6 });
  });

  it("reads a file that went and came back from the start", async () => {
    const path = await sessionPath();
    const reader = createUsageReader();
    await writeFile(path, lines(header, { type: "usage", id: "x1", usage: usage(4, 1) }));
    expect(await reader.read(path, null)).toStrictEqual({ tokens: 10, cost: 1 });

    await rm(path);
    expect(await reader.read(path, null)).toBeNull();
    await writeFile(
      path,
      lines(header, { type: "usage", id: "y1", usage: usage(5, 2) }, { type: "usage", id: "y2", usage: usage(6, 4) }),
    );
    expect(await reader.read(path, null)).toStrictEqual({ tokens: 23, cost: 6 });
  });

  it("counts token kinds and costs that are not numbers, or below zero, as nothing", async () => {
    const path = await sessionPath();
    await writeFile(
      path,
      lines(
        header,
        {
          type: "usage",
          id: "x1",
          usage: { input: "7", output: -3, cacheRead: Number.NaN, cacheWrite: 5, cost: { total: "1" } },
        },
        { type: "usage", id: "x2", usage: null },
        { type: "usage", id: "x3", usage: { input: 1, cost: 3 } },
        { type: "usage", id: "x4", usage: { input: 1, cost: null } },
        { type: "message", id: "a1" },
        { type: "message", id: "a2", message: "hi" },
        { type: "message", id: "a3", message: null },
      ) + '{"type":"usage","id":"x5","usage":{"input":1e999,"cost":{"total":-2}}}\n5\nnull\n"text"\n',
    );

    expect(await createUsageReader().read(path, null)).toStrictEqual({ tokens: 7, cost: 0 });
  });
});

describe("lastEntryId", () => {
  it("names the last entry written whole, passing over the header, broken lines and one still being written", async () => {
    const path = await sessionPath();
    await writeFile(
      path,
      `${lines(header, { type: "message", id: "a1" }, { type: "label", id: "l1" })}not json\n[2]\n5\nnull\n{"type":"message","id":"half"}`,
    );

    expect(await lastEntryId(path)).toBe("l1");
  });

  it("is null for a file with only its header", async () => {
    const path = await sessionPath();
    await writeFile(path, lines(header));

    expect(await lastEntryId(path)).toBeNull();
  });
});
