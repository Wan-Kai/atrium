import { type PlanReport, PiRequestError } from "@atrium/pi";
import type { PlanUsage } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { createPlanUsage } from "./plan-usage";

/** Lets queued promises run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The first window's percentage of a usage, `null` for none. */
function percentOf(usage: PlanUsage | null): number | null {
  return usage?.windows[0]?.usedPercent ?? null;
}

/** ChatGPT's usage with the session window at `used`%. */
function codex(used: number): PlanReport {
  return {
    provider: "openai-codex",
    plan: "plus",
    windows: [{ seconds: 18_000, model: null, usedPercent: used, resetsAt: 9_000_000 }],
  };
}

/**
 * A service over a fake clock, with what it logged and what each provider's listeners heard.
 *
 * @sideEffects none
 * @returns The service, the clock, the log and what was heard.
 */
function harness() {
  const clock = new FakeClock(1_000_000);
  const { logger, records } = recordingTracing();
  const service = createPlanUsage({ clock, logger });
  const heard: (PlanUsage | null)[] = [];
  service.subscribe("openai-codex", (usage) => heard.push(usage));
  /** Asks, answering with `report`, and lets the answer be taken. */
  const ask = async (report: PlanReport | null | Error, provider: "openai-codex" | "anthropic" = "openai-codex") => {
    service.wanted(provider, async () => {
      if (report instanceof Error) throw report;
      return report;
    });
    await settle();
  };
  return { clock, records, service, heard, ask };
}

describe("createPlanUsage", () => {
  it("keeps what a report found, stamped with the time, and tells the provider's listeners", async () => {
    const { service, heard, ask } = harness();
    expect(service.current("openai-codex")).toBeNull();

    await ask(codex(39));

    const found: PlanUsage = {
      provider: "openai-codex",
      plan: "plus",
      windows: [{ seconds: 18_000, model: null, usedPercent: 39, resetsAt: 9_000_000 }],
      at: 1_000_000,
    };
    expect(service.current("openai-codex")).toStrictEqual(found);
    expect(service.current("anthropic")).toBeNull();
    expect(heard).toStrictEqual([found]);
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
    gate.resolve(codex(1));
    await settle();
    clock.advance(59_999);
    service.wanted("openai-codex", waiting("still too soon"));
    clock.advance(1);
    service.wanted("openai-codex", waiting("a minute on"));

    expect(asked).toStrictEqual(["first", "claude", "a minute on"]);
    // An ask still under way a minute on is not asked again either.
    clock.advance(60_000);
    service.wanted("openai-codex", waiting("while the last is under way"));
    expect(asked).toHaveLength(3);
  });

  it("drops what it knew on no_login at once, on other failures once ten minutes old, logging the code alone", async () => {
    const { clock, service, records, heard, ask } = harness();
    await ask(codex(39));

    clock.advance(9 * 60_000);
    await ask({ provider: "openai-codex", failure: "http_500" });
    expect(service.current("openai-codex")?.windows[0]?.usedPercent).toBe(39);
    clock.advance(60_000);
    await ask({ provider: "openai-codex", failure: "unreachable" });
    expect(service.current("openai-codex")).toBeNull();

    clock.advance(60_000);
    await ask(codex(40));
    clock.advance(60_000);
    await ask({ provider: "openai-codex", failure: "no_login" });

    expect(service.current("openai-codex")).toBeNull();
    expect(heard.map(percentOf)).toStrictEqual([39, null, 40, null]);
    expect(
      records
        .filter((record) => record["msg"] === "plan usage unavailable")
        .map(({ provider, failure }) => [provider, failure]),
    ).toStrictEqual([
      ["openai-codex", "http_500"],
      ["openai-codex", "unreachable"],
      ["openai-codex", "no_login"],
    ]);
  });

  it("changes nothing for a query that found no report or failed, logging only pi's command and reason", async () => {
    const { clock, service, records, heard, ask } = harness();
    await ask(codex(39));

    clock.advance(60_000);
    await ask(null);
    clock.advance(60_000);
    await ask(new PiRequestError("prompt", "timeout", "secret text"));
    clock.advance(60_000);
    await ask(new Error("bug"));

    expect(service.current("openai-codex")?.windows[0]?.usedPercent).toBe(39);
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

  it("tells listeners only of changes, and no longer once they unsubscribe", async () => {
    const { clock, service, heard, ask } = harness();
    const later: (PlanUsage | null)[] = [];
    const unsubscribe = service.subscribe("openai-codex", (usage) => later.push(usage));

    await ask(codex(39));
    clock.advance(60_000);
    // The same usage found again a minute on is a change: its time is new.
    await ask(codex(39));
    unsubscribe();
    clock.advance(60_000);
    await ask(codex(41));

    expect(heard.map((usage) => usage?.at)).toStrictEqual([1_000_000, 1_060_000, 1_120_000]);
    expect(later.map((usage) => usage?.at)).toStrictEqual([1_000_000, 1_060_000]);
  });
});
