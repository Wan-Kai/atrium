import { describe, expect, it } from "vitest";
import {
  STATUS_GROUPS,
  cacheHit,
  contextLevel,
  contextPercent,
  contextRows,
  formatCost,
  formatSeconds,
  formatSpeed,
  formatTokens,
  formatWhole,
  shownGroups,
  totalTokens,
  windowShare,
  withChoice,
} from "./status-figures";

const tokens = { input: 1000, output: 250, cacheRead: 3000, cacheWrite: 1000 };

/** A context with nothing in any part. */
const EMPTY_PARTS = {
  system: 0,
  memory: { tokens: 0, files: [] },
  skills: { tokens: 0, items: [] },
  builtin: { tokens: 0, items: [] },
  mcp: { tokens: 0, servers: [] },
  extensions: { tokens: 0, items: [] },
};

/** A context with something in every part. */
const PARTS = {
  system: 3000,
  memory: {
    tokens: 4200,
    files: [
      { path: "~/work/atrium/AGENTS.md", tokens: 3100 },
      { path: "~/.pi/agent/AGENTS.md", tokens: 1080 },
    ],
  },
  skills: { tokens: 1600, items: [{ name: "tdd", tokens: 1590 }] },
  builtin: {
    tokens: 2000,
    items: [
      { name: "bash", tokens: 1200 },
      { name: "read", tokens: 790 },
    ],
  },
  mcp: {
    tokens: 3400,
    servers: [
      { name: "chrome-devtools", tools: 12, tokens: 2300 },
      { name: "paseo", tools: 6, tokens: 1000 },
    ],
  },
  extensions: { tokens: 1700, items: [{ name: "todo", tokens: 1700 }] },
};

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
    expect(contextPercent({ tokens: 84_000, window: 200_000, parts: null, reserve: null })).toBe(42);
    expect(contextPercent({ tokens: 1, window: 300, parts: null, reserve: null })).toBe(0);
    expect(contextPercent({ tokens: null, window: 200_000, parts: null, reserve: null })).toBeNull();
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

  it("splits the context into rows: the conversation first, then each part that has tokens", () => {
    const split = contextRows({ tokens: 20_000, window: 200_000, parts: PARTS, reserve: 16_384 });

    expect(split).toStrictEqual({
      rows: [
        {
          key: "messages",
          name: "对话消息",
          tokens: 20_000 - 3000 - 4200 - 1600 - 2000 - 3400 - 1700,
          count: null,
          items: [],
        },
        { key: "system", name: "系统提示词", tokens: 3000, count: null, items: [] },
        {
          key: "memory",
          name: "记忆文件",
          tokens: 4200,
          count: 2,
          items: [
            { name: "~/work/atrium/AGENTS.md", tokens: 3100 },
            { name: "~/.pi/agent/AGENTS.md", tokens: 1080 },
          ],
        },
        { key: "skills", name: "Skills", tokens: 1600, count: 1, items: [{ name: "tdd", tokens: 1590 }] },
        {
          key: "builtin",
          name: "内置工具",
          tokens: 2000,
          count: 2,
          items: [
            { name: "bash", tokens: 1200 },
            { name: "read", tokens: 790 },
          ],
        },
        {
          key: "mcp",
          name: "MCP 工具",
          tokens: 3400,
          count: 18,
          items: [
            { name: "chrome-devtools · 12 个", tokens: 2300 },
            { name: "paseo · 6 个", tokens: 1000 },
          ],
        },
        { key: "extensions", name: "扩展", tokens: 1700, count: 1, items: [{ name: "todo", tokens: 1700 }] },
      ],
      reserve: 16_384,
      free: 200_000 - 20_000 - 16_384,
    });
  });

  it("leaves out the parts with no tokens, but never the conversation, which is never below none", () => {
    const parts = { ...EMPTY_PARTS, system: 5000 };

    expect(contextRows({ tokens: 4000, window: 10_000, parts, reserve: null })).toStrictEqual({
      rows: [
        { key: "messages", name: "对话消息", tokens: 0, count: null, items: [] },
        { key: "system", name: "系统提示词", tokens: 5000, count: null, items: [] },
      ],
      reserve: null,
      free: 6000,
    });
    expect(contextRows({ tokens: 9000, window: 10_000, parts, reserve: 2000 })?.free).toBe(0);
  });

  it("knows no rows without the context's tokens or parts", () => {
    expect(contextRows({ tokens: null, window: 200_000, parts: PARTS, reserve: 16_384 })).toBeNull();
    expect(contextRows({ tokens: 4000, window: 200_000, parts: null, reserve: 16_384 })).toBeNull();
  });

  it("writes a part of the window as a percentage with one decimal", () => {
    expect([windowShare(41_200, 500_000), windowShare(16_384, 500_000), windowShare(0, 10)]).toStrictEqual([
      "8.2%",
      "3.3%",
      "0.0%",
    ]);
  });
});

describe("the status bar's groups", () => {
  it("are, in order, the session's statistics, tokens and context, shown at first, and the cost, hidden", () => {
    expect(STATUS_GROUPS).toStrictEqual([
      { id: "session", name: "会话统计", description: "轮数、步数、输出速度", defaultVisible: true },
      { id: "tokens", name: "Token 用量", description: "总用量与缓存命中率", defaultVisible: true },
      { id: "context", name: "上下文", description: "已用比例，悬停看分段", defaultVisible: true },
      { id: "cost", name: "费用", description: "按 API 价格折算，订阅不实际付费", defaultVisible: false },
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
    expect(withChoice({}, "later", true)).toStrictEqual({ later: true });
  });
});
