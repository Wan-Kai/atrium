import { describe, expect, it } from "vitest";
import {
  STATUS_GROUPS,
  cacheHit,
  contextLevel,
  contextPercent,
  contextRows,
  currentPlan,
  foundAgo,
  formatCost,
  formatSeconds,
  formatSpeed,
  formatTokens,
  formatWhole,
  partName,
  planName,
  planNearLimit,
  planPercent,
  plansInOrder,
  resetText,
  shownGroups,
  totalTokens,
  windowName,
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
      compaction: "on",
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
      compaction: "unknown",
      free: 6000,
    });
    expect(contextRows({ tokens: 9000, window: 10_000, parts, reserve: 2000 })?.free).toBe(0);
    const off = contextRows({ tokens: 4000, window: 10_000, parts, reserve: "off" });
    expect([off?.reserve, off?.compaction, off?.free]).toStrictEqual([null, "off", 6000]);
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
  it("are, in order, the session's statistics, tokens, context and plan, shown at first, and the cost, hidden", () => {
    expect(STATUS_GROUPS).toStrictEqual([
      { id: "session", name: "会话统计", description: "轮数、步数、输出速度", defaultVisible: true },
      { id: "tokens", name: "Token 用量", description: "总用量与缓存命中率", defaultVisible: true },
      { id: "context", name: "上下文", description: "已用比例，悬停看分段", defaultVisible: true },
      { id: "plan", name: "套餐", description: "当前订阅的用量，悬停看所有订阅和重置时间", defaultVisible: true },
      { id: "cost", name: "费用", description: "按 API 价格折算，订阅不实际付费", defaultVisible: false },
    ]);
  });

  it("shows each group as chosen, else as its default says, in the registry's order", () => {
    expect(shownGroups({})).toStrictEqual(["session", "tokens", "context", "plan"]);
    expect(shownGroups({ cost: true, session: false, plan: false, later: true })).toStrictEqual([
      "tokens",
      "context",
      "cost",
    ]);
  });

  it("keeps only the choices that differ from the default, and those of groups it does not know", () => {
    expect(withChoice({ later: false }, "cost", true)).toStrictEqual({ later: false, cost: true });
    expect(withChoice({ cost: true }, "cost", false)).toStrictEqual({});
    expect(withChoice({}, "session", false)).toStrictEqual({ session: false });
    expect(withChoice({ session: false }, "session", true)).toStrictEqual({});
    expect(withChoice({}, "later", true)).toStrictEqual({ later: true });
  });
});

/** A plan's window `used`% used, `seconds` long, counting `model` alone. */
function window(used: number, seconds: number | null = 18_000, model: string | null = null) {
  return { seconds, model, usedPercent: used, resetsAt: null, parts: [] };
}

/** A provider's usage, found at `at`. */
function usage(provider: "openai-codex" | "anthropic" | "xai", at = 0) {
  return { provider, plan: null, windows: [window(1)], at };
}

describe("the plan's figures", () => {
  it("counts the window nearest its limit, whole, and is near it from 80%", () => {
    const plan = { provider: "openai-codex" as const, plan: "plus", windows: [window(39.4), window(52.5)], at: 0 };

    expect([planPercent(plan), planPercent({ ...plan, windows: [] })]).toStrictEqual([53, null]);
    expect([79, 80, 100].map(planNearLimit)).toStrictEqual([false, true, true]);
  });

  it("names a subscription by the provider and its plan", () => {
    expect([
      planName({ provider: "openai-codex", plan: "plus" }),
      planName({ provider: "openai-codex", plan: "pro" }),
      planName({ provider: "anthropic", plan: null }),
      planName({ provider: "xai", plan: null }),
    ]).toStrictEqual(["ChatGPT Plus", "ChatGPT Pro", "Claude", "Grok"]);
  });

  it("finds the session's subscription, and lists it first, the rest as the host listed them", () => {
    const plans = [usage("openai-codex", 1), usage("anthropic", 2), usage("xai", 3)];

    expect([currentPlan(plans, "anthropic")?.at, currentPlan(plans, "faux"), currentPlan(plans, null)]).toStrictEqual([
      2,
      null,
      null,
    ]);
    expect(
      ["xai", "anthropic", "faux", null].map((provider) => plansInOrder(plans, provider).map(({ at }) => at)),
    ).toStrictEqual([
      [3, 1, 2],
      [2, 1, 3],
      [1, 2, 3],
      [1, 2, 3],
    ]);
  });

  it("splits a product's run-together name into words, and leaves other names as they are", () => {
    expect(["GrokBuild", "GrokImagine", "Grok", "API", "GPT-5 Codex", "grok chat"].map(partName)).toStrictEqual([
      "Grok Build",
      "Grok Imagine",
      "Grok",
      "API",
      "GPT-5 Codex",
      "grok chat",
    ]);
  });

  it("names a window by its length, in hours under two days, else days, and the model it counts alone", () => {
    expect(
      [
        window(1),
        window(1, 604_800),
        window(1, 604_800, "Fable"),
        window(1, 3600),
        window(1, 172_799),
        window(1, 172_800),
        window(1, null),
        window(1, null, "Opus"),
      ].map(windowName),
    ).toStrictEqual(["5 小时窗口", "每周", "每周 · Fable", "1 小时窗口", "48 小时窗口", "2 天", "额度", "额度 · Opus"]);
  });

  it("says when a window resets: how long within a day, the day and time further off", () => {
    const now = new Date(2026, 9, 15, 12, 0).getTime();
    const minute = 60_000;

    expect(
      [
        null,
        now,
        now + 16 * minute + 59_000,
        now + (4 * 60 + 16) * minute,
        now + (24 * 60 - 1) * minute,
        new Date(2026, 9, 18, 8, 0).getTime(),
        new Date(2026, 9, 20, 23, 5).getTime(),
      ].map((at) => resetText(at, now)),
    ).toStrictEqual([
      "",
      "即将重置",
      "16 分后重置",
      "4 小时 16 分后重置",
      "23 小时 59 分后重置",
      "周日 08:00 重置",
      "周二 23:05 重置",
    ]);
  });

  it("names every day of the week, and counts a reset a whole day off by its day", () => {
    const now = new Date(2026, 9, 15, 12, 0).getTime();
    const days = [15, 16, 17, 18, 19, 20, 21].map((day) => resetText(new Date(2026, 9, day + 2, 9, 30).getTime(), now));

    expect(days.map((text) => text.slice(0, 2))).toStrictEqual([
      "周六",
      "周日",
      "周一",
      "周二",
      "周三",
      "周四",
      "周五",
    ]);
    expect(resetText(now + 24 * 3_600_000, now)).toBe("周五 12:00 重置");
  });

  it("says how long ago the usage was found", () => {
    const now = 10_000_000;

    expect(
      [now + 5000, now - 59_999, now - 60_000, now - 3_599_999, now - 3_600_000, now - 7_300_000].map((at) =>
        foundAgo(at, now),
      ),
    ).toStrictEqual(["刚刚", "刚刚", "1 分钟前", "59 分钟前", "1 小时前", "2 小时前"]);
  });
});
