import { describe, expect, it } from "vitest";
import {
  STATUS_GROUPS,
  cacheHit,
  contextLevel,
  contextPercent,
  contextSegments,
  formatCost,
  formatSeconds,
  formatSpeed,
  formatTokens,
  formatWhole,
  shownGroups,
  totalTokens,
  withChoice,
} from "./status-figures";

const tokens = { input: 1000, output: 250, cacheRead: 3000, cacheWrite: 1000 };

describe("the status bar's figures", () => {
  it("writes tokens as the prototype does: whole below a thousand, then K, then M with one decimal", () => {
    expect(
      [0, 999, 1000, 1499, 1500, 84_321, 999_499, 1_000_000, 1_349_999, 12_000_000].map(formatTokens),
    ).toStrictEqual(["0", "999", "1K", "1K", "2K", "84K", "999K", "1.0M", "1.3M", "12.0M"]);
  });

  it("writes whole counts with thousands separated, and times, speeds and costs", () => {
    expect(formatWhole(1_234_567)).toBe("1,234,567");
    expect(formatSeconds(4249)).toBe("4.2 秒");
    expect(formatSeconds(0)).toBe("0.0 秒");
    expect(formatSpeed(48.5)).toBe("49");
    expect(formatSpeed(0.4)).toBe("0");
    expect(formatCost(0.454)).toBe("≈ $0.45");
    expect(formatCost(0)).toBe("≈ $0.00");
  });

  it("adds up the four kinds of tokens, and the cache's share of the input", () => {
    expect(totalTokens(tokens)).toBe(5250);
    expect(cacheHit(tokens)).toBe(60);
    expect(cacheHit({ ...tokens, cacheRead: 1, input: 2, cacheWrite: 0 })).toBe(33);
    expect(cacheHit({ input: 0, output: 9, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  it("measures the context used, with no figure after a compaction", () => {
    expect(contextPercent({ tokens: 84_000, window: 200_000, system: null, tools: null })).toBe(42);
    expect(contextPercent({ tokens: 1, window: 300, system: null, tools: null })).toBe(0);
    expect(contextPercent({ tokens: null, window: 200_000, system: null, tools: null })).toBeNull();
  });

  it("turns yellow past 70% and red past 85%", () => {
    expect([null, 0, 70, 71, 85, 86].map(contextLevel)).toStrictEqual([
      "normal",
      "normal",
      "normal",
      "warn",
      "warn",
      "danger",
    ]);
  });

  it("splits the context into the system prompt, the tools and the conversation, never below none", () => {
    expect(contextSegments({ tokens: 10_000, window: 200_000, system: 3000, tools: 2500 })).toStrictEqual({
      system: 3000,
      tools: 2500,
      messages: 4500,
    });
    expect(contextSegments({ tokens: 4000, window: 200_000, system: 3000, tools: 2500 })).toStrictEqual({
      system: 3000,
      tools: 2500,
      messages: 0,
    });
    expect(contextSegments({ tokens: 4000, window: 200_000, system: null, tools: 2500 })).toBeNull();
    expect(contextSegments({ tokens: 4000, window: 200_000, system: 3000, tools: null })).toBeNull();
    expect(contextSegments({ tokens: null, window: 200_000, system: 3000, tools: 2500 })).toBeNull();
  });
});

describe("the status bar's groups", () => {
  it("are, in order, the session's statistics, tokens and context, shown at first, and the cost, hidden", () => {
    expect(STATUS_GROUPS.map((group) => [group.id, group.name, group.defaultVisible])).toStrictEqual([
      ["session", "会话统计", true],
      ["tokens", "Token 用量", true],
      ["context", "上下文", true],
      ["cost", "费用", false],
    ]);
  });

  it("shows each group as chosen, else as its default says, in the registry's order", () => {
    expect(shownGroups({})).toStrictEqual(["session", "tokens", "context"]);
    expect(shownGroups({ cost: true, session: false, later: true })).toStrictEqual(["tokens", "context", "cost"]);
  });

  it("keeps only the choices that differ from the default, and those of groups it does not know", () => {
    expect(withChoice({ later: false }, "cost", true)).toStrictEqual({ later: false, cost: true });
    expect(withChoice({ cost: true }, "cost", false)).toStrictEqual({});
    expect(withChoice({}, "session", false)).toStrictEqual({ session: false });
    expect(withChoice({ session: false }, "session", true)).toStrictEqual({});
  });
});
