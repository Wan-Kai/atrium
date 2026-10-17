import { describe, expect, it } from "vitest";
import {
  claudeUsage,
  codexUsage,
  grokUsage,
  isPlanProvider,
  isPlanQuery,
  planReplyOf,
  readPlanReport,
  replyUsage,
} from "./plan";

/** ChatGPT's answer to `wham/usage`, as the public write-ups show it (ADR-0010). */
const CODEX_ANSWER = {
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 27,
      limit_window_seconds: 18_000,
      reset_after_seconds: 13_140,
      reset_at: 1_782_770_922,
    },
    secondary_window: {
      used_percent: 4,
      limit_window_seconds: 604_800,
      reset_after_seconds: 566_340,
      reset_at: 1_783_357_722,
    },
  },
  rate_limit_reset_credits: { available_count: 2 },
};

/** Claude's newer answer to `api/oauth/usage`, with `limits[]` (ADR-0010). */
const CLAUDE_ANSWER = {
  five_hour: { utilization: 9, resets_at: "2026-09-02T04:09:59Z" },
  seven_day: { utilization: 7, resets_at: "2026-09-05T17:59:59Z" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: "session", group: "session", percent: 9, resets_at: "2026-09-02T04:09:59Z", scope: null, is_active: false },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 7,
      resets_at: "2026-09-05T17:59:59Z",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 12,
      resets_at: "2026-09-05T17:59:59Z",
      is_active: true,
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

/** Grok's answer to `v1/billing?format=credits`, as pi's xAI login got it on 2026-10-16 (ADR-0011). */
const GROK_ANSWER = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-10-12T09:56:20.057003+00:00",
      end: "2026-10-19T09:56:20.057003+00:00",
    },
    creditUsagePercent: 34,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [
      { product: "GrokBuild", usagePercent: 33 },
      { product: "GrokChat", usagePercent: 1 },
      { product: "GrokImagine" },
    ],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
    billingPeriodStart: "2026-10-12T09:56:20.057003+00:00",
    billingPeriodEnd: "2026-10-19T09:56:20.057003+00:00",
  },
};

describe("codexUsage", () => {
  it("reads the plan and both windows, reset times in milliseconds", () => {
    expect(codexUsage(CODEX_ANSWER)).toStrictEqual({
      plan: "plus",
      windows: [
        { seconds: 18_000, model: null, usedPercent: 27, resetsAt: 1_782_770_922_000, parts: [] },
        { seconds: 604_800, model: null, usedPercent: 4, resetsAt: 1_783_357_722_000, parts: [] },
      ],
    });
  });

  it("leaves out a window without a percentage, and knows what it can of the rest", () => {
    expect(
      codexUsage({
        plan_type: 7,
        rate_limit: { primary_window: { used_percent: "27" }, secondary_window: { used_percent: 50 } },
      }),
    ).toStrictEqual({
      plan: null,
      windows: [{ seconds: null, model: null, usedPercent: 50, resetsAt: null, parts: [] }],
    });
  });

  it("finds no usage in an answer without windows", () => {
    expect(
      [null, [], "x", {}, { rate_limit: null }, { rate_limit: { primary_window: null } }].map(codexUsage),
    ).toStrictEqual([null, null, null, null, null, null]);
  });
});

describe("claudeUsage", () => {
  it("reads limits[]: the session, the week, and a window for each model counted alone", () => {
    expect(claudeUsage(CLAUDE_ANSWER)).toStrictEqual([
      { seconds: 18_000, model: null, usedPercent: 9, resetsAt: Date.parse("2026-09-02T04:09:59Z"), parts: [] },
      { seconds: 604_800, model: null, usedPercent: 7, resetsAt: Date.parse("2026-09-05T17:59:59Z"), parts: [] },
      { seconds: 604_800, model: "Fable", usedPercent: 12, resetsAt: Date.parse("2026-09-05T17:59:59Z"), parts: [] },
    ]);
  });

  it("keeps the first eight windows, as many as Atrium takes, of an answer that scopes many models", () => {
    const scoped = Array.from({ length: 10 }, (_, at) => ({
      kind: "weekly_scoped",
      percent: at,
      resets_at: null,
      scope: { model: { display_name: `M${String(at)}` } },
    }));

    expect(claudeUsage({ limits: scoped })?.map((window) => window.model)).toStrictEqual([
      "M0",
      "M1",
      "M2",
      "M3",
      "M4",
      "M5",
      "M6",
      "M7",
    ]);
  });

  it("leaves out limits of other kinds, without a percentage, or scoped to no model, and reset times that do not parse", () => {
    expect(
      claudeUsage({
        limits: [
          { kind: "monthly", percent: 1, scope: { model: { display_name: "Fable" } } },
          { kind: "session", percent: null },
          { kind: "weekly_scoped", percent: 3, scope: { model: { display_name: "" } } },
          { kind: "weekly_scoped", percent: 3, scope: null },
          { kind: "session", percent: 5, resets_at: "soon" },
          { kind: "weekly_all", percent: 6, resets_at: 5 },
        ],
      }),
    ).toStrictEqual([
      { seconds: 18_000, model: null, usedPercent: 5, resetsAt: null, parts: [] },
      { seconds: 604_800, model: null, usedPercent: 6, resetsAt: null, parts: [] },
    ]);
  });

  it("reads the older answer without limits[]: each window that is not null", () => {
    expect(
      claudeUsage({
        five_hour: { utilization: 35, resets_at: "2026-02-06T22:00:00+00:00" },
        seven_day: { utilization: 14, resets_at: null },
        seven_day_opus: { utilization: 60, resets_at: "2026-02-12T20:00:00+00:00" },
        seven_day_sonnet: { utilization: 3, resets_at: null },
      }),
    ).toStrictEqual([
      { seconds: 18_000, model: null, usedPercent: 35, resetsAt: Date.parse("2026-02-06T22:00:00+00:00"), parts: [] },
      { seconds: 604_800, model: null, usedPercent: 14, resetsAt: null, parts: [] },
      {
        seconds: 604_800,
        model: "Opus",
        usedPercent: 60,
        resetsAt: Date.parse("2026-02-12T20:00:00+00:00"),
        parts: [],
      },
      { seconds: 604_800, model: "Sonnet", usedPercent: 3, resetsAt: null, parts: [] },
    ]);
  });

  it("finds no usage in an answer with no window", () => {
    expect([null, {}, { limits: [] }, { five_hour: null }].map(claudeUsage)).toStrictEqual([null, null, null, null]);
  });
});

/** The products Grok's answer with these `productUsage` is read to have. */
function grokParts(productUsage: unknown) {
  return grokUsage({ config: { creditUsagePercent: 5, productUsage } })?.[0]?.parts;
}

describe("grokUsage", () => {
  it("reads one window for the period, resetting at its end, with each product's share; a product left out used none", () => {
    expect(grokUsage(GROK_ANSWER)).toStrictEqual([
      {
        seconds: 604_800,
        model: null,
        usedPercent: 34,
        resetsAt: Date.parse("2026-10-19T09:56:20.057Z"),
        parts: [
          { name: "GrokBuild", usedPercent: 33 },
          { name: "GrokChat", usedPercent: 1 },
          { name: "GrokImagine", usedPercent: 0 },
        ],
      },
    ]);
  });

  it("counts a missing percentage as none used while the period is there, and knows what it can of the period", () => {
    expect(
      [
        { config: { currentPeriod: { start: "2026-10-01T00:00:00Z", end: "2026-10-31T00:00:00Z" } } },
        { config: { currentPeriod: { start: "soon", end: "2026-10-31T00:00:00Z" }, creditUsagePercent: 5 } },
        { config: { currentPeriod: { start: "2026-10-31T00:00:00Z", end: "2026-10-31T00:00:00Z" } } },
        { config: { currentPeriod: {}, creditUsagePercent: 5 } },
        { config: { creditUsagePercent: 5, productUsage: "GrokBuild" } },
      ].map(grokUsage),
    ).toStrictEqual([
      [{ seconds: 2_592_000, model: null, usedPercent: 0, resetsAt: Date.parse("2026-10-31T00:00:00Z"), parts: [] }],
      [{ seconds: null, model: null, usedPercent: 5, resetsAt: Date.parse("2026-10-31T00:00:00Z"), parts: [] }],
      [{ seconds: null, model: null, usedPercent: 0, resetsAt: Date.parse("2026-10-31T00:00:00Z"), parts: [] }],
      [{ seconds: null, model: null, usedPercent: 5, resetsAt: null, parts: [] }],
      [{ seconds: null, model: null, usedPercent: 5, resetsAt: null, parts: [] }],
    ]);
  });

  it("leaves out products without a name, and keeps the first sixteen", () => {
    const many = Array.from({ length: 18 }, (_, at) => ({ product: `P${String(at)}`, usagePercent: 1 }));

    expect(
      grokParts([{ usagePercent: 3 }, { product: "", usagePercent: 1 }, { product: 7 }, { product: "A" }]),
    ).toStrictEqual([{ name: "A", usedPercent: 0 }]);
    expect(grokParts(many)?.map((part) => part.name)).toStrictEqual(many.slice(0, 16).map((part) => part.product));
  });

  it("finds no usage in an answer with neither a percentage nor a period", () => {
    expect(
      [
        null,
        {},
        { config: null },
        { config: {} },
        { config: { currentPeriod: null } },
        { config: { creditUsagePercent: "5" } },
      ].map(grokUsage),
    ).toStrictEqual([null, null, null, null, null, null]);
  });
});

describe("readPlanReport", () => {
  it("takes a report of usage or of a failure for a provider Atrium asks", () => {
    const usage = {
      provider: "xai",
      plan: null,
      windows: [
        {
          seconds: 604_800,
          model: null,
          usedPercent: 34,
          resetsAt: 5,
          parts: [{ name: "GrokBuild", usedPercent: 33 }],
        },
      ],
    };
    const claude = {
      provider: "anthropic",
      plan: null,
      windows: [{ seconds: 18_000, model: null, usedPercent: 9, resetsAt: 5 }],
    };

    expect(readPlanReport(JSON.stringify(usage))).toStrictEqual(usage);
    // Products not reported are none.
    expect(readPlanReport(JSON.stringify(claude))).toStrictEqual({
      ...claude,
      windows: [{ seconds: 18_000, model: null, usedPercent: 9, resetsAt: 5, parts: [] }],
    });
    expect(readPlanReport('{"provider":"openai-codex","failure":"http_503"}')).toStrictEqual({
      provider: "openai-codex",
      failure: "http_503",
    });
  });

  it("makes windows fit: percentages held to 0–100, lengths and times that are not ones dropped, names cut", () => {
    const report = readPlanReport(
      JSON.stringify({
        provider: "openai-codex",
        plan: "p".repeat(40),
        windows: [
          {
            seconds: 1.5,
            model: "m".repeat(70),
            usedPercent: 120,
            resetsAt: 12.6,
            parts: [
              { name: "n".repeat(70), usedPercent: 130 },
              { name: "B", usedPercent: -2 },
            ],
          },
          { seconds: -1, model: "", usedPercent: -3, resetsAt: -1, parts: [] },
          { seconds: "18000", model: 7, usedPercent: 50, resetsAt: "soon", parts: [] },
          { seconds: 1e300, model: null, usedPercent: 50, resetsAt: 1e300, parts: [] },
        ],
      }),
    );

    expect(report).toStrictEqual({
      provider: "openai-codex",
      plan: "p".repeat(32),
      windows: [
        {
          seconds: null,
          model: "m".repeat(64),
          usedPercent: 100,
          resetsAt: 13,
          parts: [
            { name: "n".repeat(64), usedPercent: 100 },
            { name: "B", usedPercent: 0 },
          ],
        },
        { seconds: null, model: null, usedPercent: 0, resetsAt: null, parts: [] },
        { seconds: null, model: null, usedPercent: 50, resetsAt: null, parts: [] },
        { seconds: null, model: null, usedPercent: 50, resetsAt: null, parts: [] },
      ],
    });
  });

  it("takes what is just within the limits: 8 windows, 16 products, a 40-letter failure, a reset at the epoch", () => {
    const window = { seconds: 0, model: null, usedPercent: 9, resetsAt: 0, parts: [] };
    const report = readPlanReport(
      JSON.stringify({ provider: "anthropic", plan: null, windows: Array.from({ length: 8 }, () => window) }),
    );

    expect(report).toStrictEqual({
      provider: "anthropic",
      plan: null,
      windows: Array.from({ length: 8 }, () => ({
        seconds: null,
        model: null,
        usedPercent: 9,
        resetsAt: 0,
        parts: [],
      })),
    });
    const parts = Array.from({ length: 16 }, () => ({ name: "P", usedPercent: 1 }));
    expect(
      readPlanReport(JSON.stringify({ provider: "xai", plan: null, windows: [{ ...window, seconds: 1, parts }] })),
    ).toStrictEqual({
      provider: "xai",
      plan: null,
      windows: [{ seconds: 1, model: null, usedPercent: 9, resetsAt: 0, parts }],
    });
    expect(readPlanReport(JSON.stringify({ provider: "anthropic", plan: "", windows: [] }))).toStrictEqual({
      provider: "anthropic",
      plan: null,
      windows: [],
    });
    expect(readPlanReport(JSON.stringify({ provider: "anthropic", failure: "x".repeat(40) }))).toStrictEqual({
      provider: "anthropic",
      failure: "x".repeat(40),
    });
  });

  it("takes nothing that does not fit", () => {
    const window = { seconds: 18_000, model: null, usedPercent: 9, resetsAt: 5, parts: [] };
    const texts = [
      undefined,
      "not json",
      "null",
      JSON.stringify({ provider: "github-copilot", plan: null, windows: [window] }),
      JSON.stringify({ plan: null, windows: [window] }),
      JSON.stringify({ provider: "anthropic", failure: "HTTP 500" }),
      JSON.stringify({ provider: "anthropic", failure: "x".repeat(41) }),
      JSON.stringify({ provider: "anthropic", failure: 500 }),
      JSON.stringify({ provider: "anthropic", failure: ["ab"] }),
      JSON.stringify({ provider: "anthropic", failure: "http 500" }),
      JSON.stringify({ provider: "anthropic", plan: null, windows: "none" }),
      JSON.stringify({ provider: "anthropic", plan: null, windows: Array.from({ length: 9 }, () => window) }),
      JSON.stringify({ provider: "anthropic", plan: null, windows: [window, { ...window, usedPercent: null }] }),
      ...[
        "GrokBuild",
        null,
        Array.from({ length: 17 }, () => ({ name: "P", usedPercent: 1 })),
        [{ name: "", usedPercent: 1 }],
        [{ name: 7, usedPercent: 1 }],
        [{ name: "P", usedPercent: "1" }],
        [{ name: "P" }],
        [null],
      ].map((parts) => JSON.stringify({ provider: "xai", plan: null, windows: [{ ...window, parts }] })),
    ];

    expect(texts.map(readPlanReport)).toStrictEqual(texts.map(() => null));
  });
});

describe("isPlanQuery, isPlanProvider", () => {
  it("knows Atrium's plan query by name and source, and the three providers Atrium asks", () => {
    const commands: Parameters<typeof isPlanQuery>[0][] = [
      { name: "atrium-plan", source: "extension" },
      { name: "atrium-plan", source: "skill" },
      { name: "atrium-fast", source: "extension" },
    ];

    expect(commands.map(isPlanQuery)).toStrictEqual([true, false, false]);
    expect(["openai-codex", "anthropic", "xai", "openai", null].map(isPlanProvider)).toStrictEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("replyUsage", () => {
  it("reads the five hours and the week from a reply's headers, in any case, to two places", () => {
    expect(
      replyUsage({
        "Anthropic-Ratelimit-Unified-5h-Utilization": "0.071",
        "anthropic-ratelimit-unified-5h-reset": "1792218000",
        "anthropic-ratelimit-unified-7d-utilization": "1",
        "anthropic-ratelimit-unified-status": "allowed",
      }),
    ).toStrictEqual([
      { seconds: 18_000, model: null, usedPercent: 7.1, resetsAt: 1_792_218_000_000, parts: [] },
      { seconds: 604_800, model: null, usedPercent: 100, resetsAt: null, parts: [] },
    ]);
  });

  it("leaves out a window whose utilization is not a number, and finds no usage without any", () => {
    expect([
      replyUsage({
        "anthropic-ratelimit-unified-5h-utilization": "",
        "anthropic-ratelimit-unified-7d-utilization": "0.5",
        "anthropic-ratelimit-unified-7d-reset": "soon",
      }),
      replyUsage({
        "anthropic-ratelimit-unified-5h-utilization": "high",
        "anthropic-ratelimit-unified-7d-utilization": " ",
      }),
      replyUsage({}),
    ]).toStrictEqual([[{ seconds: 604_800, model: null, usedPercent: 50, resetsAt: null, parts: [] }], null, null]);
  });
});

/** pi's event setting a status of Atrium's extension. */
function status(statusKey: string, statusText: string) {
  return { type: "extension_ui_request", id: "u1", method: "setStatus", statusKey, statusText } as const;
}

describe("planReplyOf", () => {
  it("takes the usage the extension reported from a reply, and nothing else pi sent", () => {
    const usage = {
      provider: "anthropic",
      plan: null,
      windows: [{ seconds: 18_000, model: null, usedPercent: 5, resetsAt: 9, parts: [] }],
    };

    expect(
      [
        status("atrium-plan-reply", JSON.stringify(usage)),
        status("atrium-plan", JSON.stringify(usage)),
        status("atrium-plan-reply", JSON.stringify({ provider: "anthropic", failure: "no_login" })),
        status("atrium-plan-reply", "not json"),
        { type: "extension_ui_request", id: "u2", method: "notify", message: JSON.stringify(usage) },
        { type: "agent_start" },
      ].map((event) => planReplyOf(event as Parameters<typeof planReplyOf>[0])),
    ).toStrictEqual([usage, null, null, null, null, null]);
  });
});
