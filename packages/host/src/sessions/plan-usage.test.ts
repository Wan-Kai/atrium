import { type PlanReport, PiRequestError } from "@atrium/pi";
import type { PlanProvider, PlanUsage, Plans } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { createPlanUsage } from "./plan-usage";

/** Lets queued promises run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** ChatGPT's usage in a list, `null` for none. */
function codexIn(plans: Plans): PlanUsage | null {
  return plans.find((plan) => plan.provider === "openai-codex") ?? null;
}

/** The first window's percentage of ChatGPT's usage in a list, `null` for none. */
function percentOf(plans: Plans): number | null {
  return codexIn(plans)?.windows[0]?.usedPercent ?? null;
}

/** A provider's usage with one window at `used`%. */
function usage(used: number, provider: PlanProvider = "openai-codex"): PlanReport {
  return {
    provider,
    plan: provider === "openai-codex" ? "plus" : null,
    windows: [{ seconds: 18_000, model: null, usedPercent: used, resetsAt: 9_000_000, parts: [] }],
  };
}

/** A provider's report that it is not signed in. */
function noLogin(provider: PlanProvider): PlanReport {
  return { provider, failure: "no_login" };
}

/**
 * A service over a fake clock, with what it logged and what its listener heard.
 *
 * @sideEffects none
 * @returns The service, the clock, the log and what was heard.
 */
function harness() {
  const clock = new FakeClock(1_000_000);
  const { logger, records } = recordingTracing();
  const service = createPlanUsage({ clock, logger });
  const heard: Plans[] = [];
  service.subscribe((plans) => heard.push(plans));
  /** Asks, answering with `report`, and lets the answer be taken. */
  const ask = async (report: PlanReport | null | Error, provider: PlanProvider = "openai-codex") => {
    service.wanted(provider, async () => {
      if (report instanceof Error) throw report;
      return report;
    });
    await settle();
  };
  /** The failures logged, as provider and code. */
  const unavailable = () =>
    records
      .filter((record) => record["msg"] === "plan usage unavailable")
      .map(({ provider, failure }) => [provider, failure]);
  return { clock, records, service, heard, ask, unavailable };
}

describe("createPlanUsage", () => {
  it("keeps what a report found, stamped with the time, and tells listeners every provider's", async () => {
    const { service, heard, ask } = harness();
    expect(service.current()).toStrictEqual([]);

    await ask(usage(39));

    const found: PlanUsage = {
      provider: "openai-codex",
      plan: "plus",
      windows: [{ seconds: 18_000, model: null, usedPercent: 39, resetsAt: 9_000_000, parts: [] }],
      at: 1_000_000,
    };
    expect(service.current()).toStrictEqual([found]);
    expect(heard).toStrictEqual([[found]]);
  });

  it("lists the providers in the protocol's order, whichever was found first", async () => {
    const { clock, service, heard, ask } = harness();

    await ask(usage(5, "xai"), "xai");
    clock.advance(1000);
    await ask(usage(7, "anthropic"), "anthropic");
    clock.advance(1000);
    await ask(usage(9));

    expect(service.current().map(({ provider, at }) => [provider, at])).toStrictEqual([
      ["openai-codex", 1_002_000],
      ["anthropic", 1_001_000],
      ["xai", 1_000_000],
    ]);
    expect(heard.map((plans) => plans.map(({ provider }) => provider))).toStrictEqual([
      ["xai"],
      ["anthropic", "xai"],
      ["openai-codex", "anthropic", "xai"],
    ]);
  });

  it("asks a provider at most once a minute and one ask at a time, each provider on its own", async () => {
    const { clock, service } = harness();
    const asked: string[] = [];
    const gate = Promise.withResolvers<PlanReport | null>();
    /** An ask that notes itself and waits for the gate. */
    const waiting = (name: string) => () => {
      asked.push(name);
      return gate.promise;
    };

    service.wanted("openai-codex", waiting("first"));
    service.wanted("openai-codex", waiting("while asking"));
    service.wanted("anthropic", waiting("claude"));
    service.wanted("xai", waiting("grok"));
    gate.resolve(usage(1));
    await settle();
    clock.advance(59_999);
    service.wanted("openai-codex", waiting("still too soon"));
    clock.advance(1);
    service.wanted("openai-codex", waiting("a minute on"));

    expect(asked).toStrictEqual(["first", "claude", "grok", "a minute on"]);
    // An ask still under way a minute on is not asked again either.
    clock.advance(60_000);
    service.wanted("openai-codex", waiting("while the last is under way"));
    expect(asked).toHaveLength(4);
  });

  it("drops what it knew on no_login at once, on other failures once ten minutes old, logging the code alone", async () => {
    const { clock, service, heard, ask, unavailable } = harness();
    await ask(usage(39));

    clock.advance(9 * 60_000);
    await ask({ provider: "openai-codex", failure: "http_500" });
    expect(percentOf(service.current())).toBe(39);
    clock.advance(60_000);
    await ask({ provider: "openai-codex", failure: "unreachable" });
    expect(service.current()).toStrictEqual([]);

    clock.advance(60_000);
    await ask(usage(40));
    clock.advance(60_000);
    await ask({ provider: "openai-codex", failure: "no_login" });

    expect(service.current()).toStrictEqual([]);
    expect(heard.map(percentOf)).toStrictEqual([39, null, 40, null]);
    expect(unavailable()).toStrictEqual([
      ["openai-codex", "http_500"],
      ["openai-codex", "unreachable"],
      ["openai-codex", "no_login"],
    ]);
  });

  it("logs a provider's failure once in a row, again once it changes or usage came between, each provider apart", async () => {
    const { clock, ask, unavailable } = harness();
    await ask(noLogin("xai"), "xai");
    await ask(noLogin("anthropic"), "anthropic");
    clock.advance(60_000);
    await ask(noLogin("xai"), "xai");
    clock.advance(60_000);
    await ask({ provider: "xai", failure: "http_403" }, "xai");
    clock.advance(60_000);
    await ask(usage(3, "xai"), "xai");
    clock.advance(60_000);
    await ask({ provider: "xai", failure: "http_403" }, "xai");

    expect(unavailable()).toStrictEqual([
      ["xai", "no_login"],
      ["anthropic", "no_login"],
      ["xai", "http_403"],
      ["xai", "http_403"],
    ]);
  });

  it("keeps what it knew through a query that found no report or failed, logging only pi's command and reason", async () => {
    const { clock, service, records, heard, ask } = harness();
    await ask(usage(39));

    clock.advance(60_000);
    await ask(null);
    clock.advance(60_000);
    await ask(new PiRequestError("prompt", "timeout", "secret text"));
    clock.advance(60_000);
    await ask(new Error("bug"));

    expect(percentOf(service.current())).toBe(39);
    expect(heard).toHaveLength(1);
    expect(
      records
        .filter((record) => record["msg"] === "plan usage not asked")
        .map(({ provider, command, reason }) => [provider, command, reason]),
    ).toStrictEqual([
      ["openai-codex", "prompt", "timeout"],
      ["openai-codex", undefined, "unknown"],
    ]);
    expect(JSON.stringify(records)).not.toContain("secret text");
  });

  it.each([
    ["found no report", null],
    ["timed out", new PiRequestError("prompt", "timeout", "")],
    ["failed", new Error("bug")],
  ])("drops what it knew once ten minutes old when a query %s", async (_how, report) => {
    const { clock, service, heard, ask } = harness();
    await ask(usage(39));
    clock.advance(9 * 60_000);
    await ask(report);
    const kept = percentOf(service.current());

    clock.advance(60_000);
    await ask(report);

    expect([kept, service.current(), heard.map(percentOf)]).toStrictEqual([39, [], [39, null]]);
  });

  it("tells listeners only of changes, and no longer once they unsubscribe", async () => {
    const { clock, service, heard, ask } = harness();
    const later: Plans[] = [];
    const unsubscribe = service.subscribe((plans) => later.push(plans));

    await ask(usage(39));
    clock.advance(60_000);
    // The same usage found again a minute on is a change: its time is new.
    await ask(usage(39));
    clock.advance(60_000);
    // A provider not signed in that was not known changes nothing.
    await ask({ provider: "anthropic", failure: "no_login" }, "anthropic");
    unsubscribe();
    clock.advance(60_000);
    await ask(usage(41));

    expect(heard.map((plans) => codexIn(plans)?.at)).toStrictEqual([1_000_000, 1_060_000, 1_180_000]);
    expect(later.map((plans) => codexIn(plans)?.at)).toStrictEqual([1_000_000, 1_060_000]);
  });
});
