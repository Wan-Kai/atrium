import type { LogEntry } from "@atrium/pi";
import { compareWithBaseline } from "@atrium/testkit";
import { expect, test } from "vitest";
import { createSessionTranscript } from "./session-transcript";

/** An entry without its place in the tree. */
type Body = LogEntry extends infer E ? (E extends LogEntry ? Omit<E, "id" | "parentId"> : never) : never;

/** A session of 2000 turns, each with thinking, a command and its output, and a reply (testing.md, "热路径基准"). */
const ENTRIES: LogEntry[] = (() => {
  const entries: LogEntry[] = [];
  let parentId: string | null = null;
  /** Appends an entry under the previous one. */
  const add = (entry: Body): void => {
    const id = entries.length.toString(16).padStart(8, "0");
    entries.push({ ...entry, id, parentId });
    parentId = id;
  };
  const usage = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, reasoning: null };
  for (let turn = 0; turn < 2000; turn += 1) {
    add({ kind: "user", text: `问题 ${turn}`, images: 0, timestamp: turn * 10 });
    add({
      kind: "assistant",
      parts: [
        { type: "thinking", text: "先看看文件。" },
        { type: "toolCall", callId: `c${turn}`, tool: "bash", args: { command: "ls -la src" } },
      ],
      stopReason: "toolUse",
      errorMessage: null,
      usage,
      timestamp: turn * 10 + 1,
    });
    add({
      kind: "toolResult",
      callId: `c${turn}`,
      tool: "bash",
      text: "a.ts\nb.ts",
      isError: false,
      details: undefined,
      timestamp: turn * 10 + 2,
    });
    add({
      kind: "assistant",
      parts: [{ type: "text", text: `回答 ${turn}：改好了。` }],
      stopReason: "stop",
      errorMessage: null,
      usage,
      timestamp: turn * 10 + 3,
    });
  }
  return entries;
})();

/** Reads the whole session into a fresh transcript, as opening it does. */
function rebuild(): void {
  createSessionTranscript({ sessionId: "s", newId: () => "t", now: () => 0 }).rebuild(
    { entries: ENTRIES, leafId: ENTRIES.at(-1)?.id ?? null },
    true,
  );
}

test("rebuilding a 2000-turn transcript stays near its baseline speed", async ({ bench }) => {
  const ratio = await compareWithBaseline(bench, "rebuild 2000 turns", ".bench/host/rebuild-2000.json", rebuild);

  expect(ratio).toBeLessThan(3);
});
