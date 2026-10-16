import { describe, expect, it } from "vitest";
import { claudeUsage, codexUsage, isPlanProvider, isPlanQuery, readPlanReport } from "./plan";

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

describe("codexUsage", () => {
  it("reads the plan and both windows, reset times in milliseconds", () => {
    expect(codexUsage(CODEX_ANSWER)).toStrictEqual({
      plan: "plus",
      windows: [
        { seconds: 18_000, model: null, usedPercent: 27, resetsAt: 1_782_770_922_000 },
        { seconds: 604_800, model: null, usedPercent: 4, resetsAt: 1_783_357_722_000 },
      ],
    });
  });

  it("leaves out a window without a percentage, and knows what it can of the rest", () => {
    expect(
      codexUsage({
        plan_type: 7,
        rate_limit: { primary_window: { used_percent: "27" }, secondary_window: { used_percent: 50 } },
      }),
    ).toStrictEqual({ plan: null, windows: [{ seconds: null, model: null, usedPercent: 50, resetsAt: null }] });
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
      { seconds: 18_000, model: null, usedPercent: 9, resetsAt: Date.parse("2026-09-02T04:09:59Z") },
      { seconds: 604_800, model: null, usedPercent: 7, resetsAt: Date.parse("2026-09-05T17:59:59Z") },
      { seconds: 604_800, model: "Fable", usedPercent: 12, resetsAt: Date.parse("2026-09-05T17:59:59Z") },
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
      { seconds: 18_000, model: null, usedPercent: 5, resetsAt: null },
      { seconds: 604_800, model: null, usedPercent: 6, resetsAt: null },
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
      { seconds: 18_000, model: null, usedPercent: 35, resetsAt: Date.parse("2026-02-06T22:00:00+00:00") },
      { seconds: 604_800, model: null, usedPercent: 14, resetsAt: null },
      { seconds: 604_800, model: "Opus", usedPercent: 60, resetsAt: Date.parse("2026-02-12T20:00:00+00:00") },
      { seconds: 604_800, model: "Sonnet", usedPercent: 3, resetsAt: null },
    ]);
  });

  it("finds no usage in an answer with no window", () => {
    expect([null, {}, { limits: [] }, { five_hour: null }].map(claudeUsage)).toStrictEqual([null, null, null, null]);
  });
});

describe("readPlanReport", () => {
  it("takes a report of usage or of a failure for a provider Atrium asks", () => {
    const usage = {
      provider: "anthropic",
      plan: null,
      windows: [{ seconds: 18_000, model: null, usedPercent: 9, resetsAt: 5 }],
    };

    expect(readPlanReport(JSON.stringify(usage))).toStrictEqual(usage);
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
          { seconds: 1.5, model: "m".repeat(70), usedPercent: 120, resetsAt: 12.6 },
          { seconds: -1, model: "", usedPercent: -3, resetsAt: -1 },
          { seconds: "18000", model: 7, usedPercent: 50, resetsAt: "soon" },
          { seconds: 1e300, model: null, usedPercent: 50, resetsAt: 1e300 },
        ],
      }),
    );

    expect(report).toStrictEqual({
      provider: "openai-codex",
      plan: "p".repeat(32),
      windows: [
        { seconds: null, model: "m".repeat(64), usedPercent: 100, resetsAt: 13 },
        { seconds: null, model: null, usedPercent: 0, resetsAt: null },
        { seconds: null, model: null, usedPercent: 50, resetsAt: null },
        { seconds: null, model: null, usedPercent: 50, resetsAt: null },
      ],
    });
  });

  it("takes what is just within the limits: 8 windows, a 40-letter failure, a reset at the epoch", () => {
    const window = { seconds: 0, model: null, usedPercent: 9, resetsAt: 0 };
    const report = readPlanReport(
      JSON.stringify({ provider: "anthropic", plan: null, windows: Array.from({ length: 8 }, () => window) }),
    );

    expect(report).toStrictEqual({
      provider: "anthropic",
      plan: null,
      windows: Array.from({ length: 8 }, () => ({ seconds: null, model: null, usedPercent: 9, resetsAt: 0 })),
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
    const window = { seconds: 18_000, model: null, usedPercent: 9, resetsAt: 5 };
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
    ];

    expect(texts.map(readPlanReport)).toStrictEqual(texts.map(() => null));
  });
});

describe("isPlanQuery, isPlanProvider", () => {
  it("knows Atrium's plan query by name and source, and the two providers Atrium asks", () => {
    const commands: Parameters<typeof isPlanQuery>[0][] = [
      { name: "atrium-plan", source: "extension" },
      { name: "atrium-plan", source: "skill" },
      { name: "atrium-fast", source: "extension" },
    ];

    expect(commands.map(isPlanQuery)).toStrictEqual([true, false, false]);
    expect(["openai-codex", "anthropic", "openai", null].map(isPlanProvider)).toStrictEqual([true, true, false, false]);
  });
});
