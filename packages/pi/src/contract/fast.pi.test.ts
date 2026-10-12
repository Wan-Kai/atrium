import { FAUX_BASE_URL_ENV, type ModelListServer, startModelListServer } from "@atrium/testkit";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";
import { isFastSwitch } from "../catalog/commands";
import type { PiEvent } from "../process/pi-process";

/** Atrium's Fast extension, as the host has pi load it (ADR-0008). */
const FAST_EXTENSION = fileURLToPath(new URL("../fast/extension.ts", import.meta.url));

/**
 * Matches a run's end that came after the first `index` events.
 *
 * @remarks
 * Each prompt here waits for its own run, not one an earlier prompt already ended.
 *
 * @sideEffects none
 * @param events - Every event pi printed so far.
 * @param index - How many there were when the prompt went out.
 * @returns The predicate.
 */
function settledAfter(events: readonly PiEvent[], index: number): (event: PiEvent) => boolean {
  return (event) => event.type === "agent_settled" && events.indexOf(event) >= index;
}

const servers: ModelListServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe("pi contract: Atrium's Fast extension", () => {
  it("fast: lists the switch, handles it without a turn, and asks the priority tier only of a model with Fast while on", async () => {
    await runScenario(
      {
        scenario: "fast",
        script: {
          provider: "openai-codex",
          models: [{ id: "gpt-5.5" }],
          replies: ["one", "two", "three", "four"].map((text) => ({ blocks: [{ type: "text" as const, text }] })),
        },
        extensions: [FAST_EXTENSION],
      },
      async ({ pi, events, until, payloads }) => {
        const { commands } = await pi.request({ type: "get_commands" });
        await pi.request({ type: "set_model", provider: "openai-codex", modelId: "gpt-5.5" });
        await pi.request({ type: "prompt", message: "before" });
        await until((event) => event.type === "agent_settled");
        const before = events.length;
        const switched = await pi.request({ type: "prompt", message: "/atrium-fast on" });
        const quiet = events.slice(before);
        await pi.request({ type: "prompt", message: "on" });
        await until(settledAfter(events, before));
        await pi.request({ type: "set_model", provider: "openai-codex", modelId: "faux-1" });
        const settled = events.length;
        await pi.request({ type: "prompt", message: "other model" });
        await until(settledAfter(events, settled));
        await pi.request({ type: "set_model", provider: "openai-codex", modelId: "gpt-5.5" });
        await pi.request({ type: "prompt", message: "/atrium-fast off" });
        const off = events.length;
        await pi.request({ type: "prompt", message: "off" });
        await until(settledAfter(events, off));

        expect(commands.filter(isFastSwitch)).toHaveLength(1);
        expect(switched).toStrictEqual({ disposition: "handled" });
        expect(quiet).toStrictEqual([]);
        expect(await payloads()).toStrictEqual([
          { model: "gpt-5.5" },
          { model: "gpt-5.5", service_tier: "priority" },
          { model: "faux-1" },
          { model: "gpt-5.5" },
        ]);
      },
    );
  });

  it("fast-tiers: asks Codex's model list with pi's credentials, reports it as a status before answering, and goes by it", async () => {
    const list = await startModelListServer();
    servers.push(list);

    await runScenario(
      {
        scenario: "fast-tiers",
        script: {
          provider: "openai-codex",
          models: [{ id: "gpt-5.5" }, { id: "gpt-6" }],
          replies: ["one", "two"].map((text) => ({ blocks: [{ type: "text" as const, text }] })),
        },
        extensions: [FAST_EXTENSION],
        env: { [FAUX_BASE_URL_ENV]: list.baseUrl },
      },
      async ({ pi, events, until, payloads }) => {
        const before = events.length;
        const answered = await pi.request({ type: "prompt", message: "/atrium-fast tiers" });
        const reported = events.slice(before);
        await pi.request({ type: "prompt", message: "/atrium-fast on" });
        await pi.request({ type: "set_model", provider: "openai-codex", modelId: "gpt-5.5" });
        await pi.request({ type: "prompt", message: "listed without Fast" });
        await until((event) => event.type === "agent_settled");
        const settled = events.length;
        await pi.request({ type: "set_model", provider: "openai-codex", modelId: "gpt-6" });
        await pi.request({ type: "prompt", message: "not listed" });
        await until(settledAfter(events, settled));

        expect(answered).toStrictEqual({ disposition: "handled" });
        expect(reported).toStrictEqual([
          {
            type: "extension_ui_request",
            id: expect.any(String),
            method: "setStatus",
            statusKey: "atrium-fast",
            statusText: JSON.stringify({
              models: [
                { id: "gpt-6.1-sol", fast: { speed: 2, moreUsage: true } },
                { id: "gpt-6-sol", fast: { speed: 1.5, moreUsage: false } },
                { id: "gpt-5.5", fast: null },
              ],
            }),
          },
        ]);
        expect(
          list.requests.map(({ url, headers }) => [url, headers["authorization"], headers["originator"]]),
        ).toStrictEqual([["/backend-api/codex/models?client_version=99.0.0", "Bearer faux-key", "pi"]]);
        expect(await payloads()).toStrictEqual([{ model: "gpt-5.5" }, { model: "gpt-6", service_tier: "priority" }]);
      },
    );
  });
});
