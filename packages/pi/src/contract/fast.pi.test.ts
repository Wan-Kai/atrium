import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
});
