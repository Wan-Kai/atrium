import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { piStatsOf } from "./session-stats";

/** pi's statistics with the fields a test gives. */
function stats(fields: Partial<SessionStats>): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "s1",
    userMessages: 4,
    assistantMessages: 9,
    toolCalls: 7,
    toolResults: 7,
    totalMessages: 20,
    tokens: { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 500, total: 11_040 },
    cost: 0.45,
    contextUsage: { tokens: 84_000, contextWindow: 200_000, percent: 42 },
    ...fields,
  };
}

describe("piStatsOf", () => {
  it("takes pi's turns, tool calls, tokens, cost and context", () => {
    expect(piStatsOf(stats({}))).toStrictEqual({
      turns: 4,
      steps: 7,
      tokens: { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 500 },
      cost: 0.45,
      context: { tokens: 84_000, window: 200_000 },
    });
  });

  it("knows no context without a model, and no context tokens after a compaction", () => {
    const { contextUsage: _gone, ...without } = stats({});

    expect(piStatsOf(without).context).toBeNull();
    expect(
      piStatsOf(stats({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } })).context,
    ).toStrictEqual({ tokens: null, window: 200_000 });
  });

  it("knows no context for a window of no tokens, and reads a figure pi got wrong as none", () => {
    expect(piStatsOf(stats({ contextUsage: { tokens: 5, contextWindow: 0, percent: null } })).context).toBeNull();
    expect(
      piStatsOf(
        stats({
          cost: Number.NaN,
          tokens: { input: -3, output: 1.5, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 2, total: 0 },
          contextUsage: { tokens: -1, contextWindow: 1000.5, percent: null },
        }),
      ),
    ).toMatchObject({
      cost: 0,
      tokens: { input: 0, output: 2, cacheRead: 0, cacheWrite: 2 },
      context: { tokens: 0, window: 1001 },
    });
    expect(piStatsOf(stats({ cost: Number.POSITIVE_INFINITY })).cost).toBe(0);
    expect(piStatsOf(stats({ cost: -0.5 })).cost).toBe(0);
  });
});
