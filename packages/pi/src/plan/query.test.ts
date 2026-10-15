import { describe, expect, it } from "vitest";
import type { PiEvent, PiProcess } from "../process/pi-process";
import { queryPlanUsage } from "./query";

/** A setStatus event as pi prints the extension's status. */
function status(key: string, text: string | undefined): PiEvent {
  return { type: "extension_ui_request", id: "u1", method: "setStatus", statusKey: key, statusText: text };
}

/**
 * A stand-in for a session's pi: lists `commands`, and answers the plan query after printing `printed`.
 *
 * @remarks
 * pi prints the extension's status before it answers the prompt (pi-internals.md §5).
 *
 * @sideEffects none
 * @param commands - The commands pi lists, by name and source.
 * @param printed - The events pi prints while running the command.
 * @param refusal - What pi refuses the command with, if it does.
 * @returns The stand-in, what it was sent and how many listen.
 */
function standIn(
  commands: readonly { name: string; source: string }[],
  printed: readonly PiEvent[] = [],
  refusal?: Error,
) {
  const listeners = new Set<(event: PiEvent) => void>();
  const sent: unknown[] = [];
  const pi: Pick<PiProcess, "request" | "onEvent"> = {
    request: (async (command: { type: string }, options?: unknown) => {
      sent.push(options === undefined ? command : [command, options]);
      if (command.type === "get_commands") return { commands };
      if (refusal !== undefined) throw refusal;
      for (const event of printed) for (const listener of listeners) listener(event);
      return { disposition: "handled" };
    }) as unknown as Pick<PiProcess, "request">["request"],
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { pi, sent, listening: () => listeners.size };
}

const QUERY = { name: "atrium-plan", source: "extension" };
const USAGE = JSON.stringify({
  provider: "openai-codex",
  plan: "plus",
  windows: [{ seconds: 18_000, model: null, usedPercent: 39, resetsAt: 5 }],
});

describe("queryPlanUsage", () => {
  it("sends the query when pi lists it, and takes the provider's report it printed", async () => {
    const { pi, sent, listening } = standIn(
      [{ name: "atrium-fast", source: "extension" }, QUERY],
      [status("other", "x"), status("atrium-plan", USAGE), { type: "agent_start" }],
    );

    const report = await queryPlanUsage(pi, "openai-codex", 500);

    expect(report).toStrictEqual(JSON.parse(USAGE));
    expect(sent).toStrictEqual([
      { type: "get_commands" },
      [{ type: "prompt", message: "/atrium-plan openai-codex" }, { timeoutMs: 500 }],
    ]);
    expect(listening()).toBe(0);
  });

  it("sends nothing when pi lists no plan query of Atrium's extension", async () => {
    const { pi, sent } = standIn([{ name: "atrium-plan", source: "prompt" }]);

    expect(await queryPlanUsage(pi, "anthropic")).toBeNull();
    expect(sent).toStrictEqual([{ type: "get_commands" }]);
  });

  it("takes no report for another provider, nor one that does not fit", async () => {
    const other = JSON.stringify({ provider: "anthropic", failure: "no_login" });
    const { pi } = standIn([QUERY], [status("atrium-plan", "{ not json"), status("atrium-plan", other)]);

    expect(await queryPlanUsage(pi, "openai-codex")).toBeNull();
  });

  it("stops listening when pi refuses the query", async () => {
    const { pi, listening } = standIn([QUERY], [], new Error("refused"));

    await expect(queryPlanUsage(pi, "openai-codex")).rejects.toThrow("refused");
    expect(listening()).toBe(0);
  });
});
