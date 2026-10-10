import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "../../test/contract";
import { type LogEntry, type LogUsage, toLogEntry } from "../history/log-entry";
import { contextShares } from "../history/system-prompt";
import { piStatsOf } from "../stats/session-stats";

/**
 * An entry's tokens, if it is an assistant message.
 *
 * @sideEffects none
 * @param entry - The entry.
 * @returns Its tokens, or nothing.
 */
function usageOf(entry: LogEntry): LogUsage[] {
  return entry.kind === "assistant" ? [entry.usage] : [];
}

describe("pi contract: session statistics", () => {
  it("stats: counts the whole file's user messages, tool calls and tokens, as the entries add up", async () => {
    await runScenario(
      {
        scenario: "stats",
        session: true,
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf ok" } }] },
            { blocks: [{ type: "text", text: "done" }] },
            { blocks: [{ type: "text", text: "again" }] },
          ],
        },
      },
      async ({ pi, events }) => {
        /** Waits until pi has settled `count` runs; `until` would find the first one again. */
        const settled = (count: number) =>
          vi.waitFor(() => expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(count), {
            timeout: 20_000,
            interval: 10,
          });
        const before = piStatsOf(await pi.request({ type: "get_session_stats" }));
        await pi.request({ type: "prompt", message: "one" });
        await settled(1);
        await pi.request({ type: "prompt", message: "two" });
        await settled(2);
        const stats = piStatsOf(await pi.request({ type: "get_session_stats" }));
        const { entries } = (await pi.request({ type: "get_entries" })) as unknown as { entries: SessionEntry[] };
        const logged = entries.map(toLogEntry);
        const usages = logged.flatMap(usageOf);
        const added = (key: "input" | "output" | "cacheRead" | "cacheWrite") =>
          usages.reduce((sum, usage) => sum + usage[key], 0);

        expect(before).toMatchObject({
          turns: 0,
          steps: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
        expect(stats).toMatchObject({
          turns: 2,
          steps: 1,
          tokens: {
            input: added("input"),
            output: added("output"),
            cacheRead: added("cacheRead"),
            cacheWrite: added("cacheWrite"),
          },
          cost: 0,
        });
        expect(usages).toHaveLength(3);
        expect(stats.tokens.input + stats.tokens.output).toBeGreaterThan(0);
        expect(stats.context?.window).toBeGreaterThan(0);
        expect(stats.context?.tokens).toBeGreaterThan(0);
        expect(contextShares(logged)?.system).toBeGreaterThan(0);
        expect(contextShares(logged)?.tools).toBeGreaterThan(0);
      },
    );
  });
});
