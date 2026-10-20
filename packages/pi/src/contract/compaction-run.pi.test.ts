import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";
import type { PiEvent } from "../process/pi-process";

/** An entry of pi's `get_entries` answer, as far as this scenario reads it. */
interface Entry {
  readonly type: string;
  readonly message?: { readonly role: string };
  readonly summary?: string;
  readonly firstKeptEntryId?: string;
}

/** The events that mark where a run, a request and a compaction are, by name. */
const MARKS: ReadonlySet<string> = new Set([
  "agent_start",
  "turn_start",
  "agent_end",
  "compaction_start",
  "compaction_end",
  "agent_settled",
]);

/**
 * Names each entry by its message's role, or by its type when it holds no message.
 *
 * @remarks
 * Entry ids are random, so the scenario checks the entries' order by kind.
 *
 * @sideEffects none
 * @param entries - The entries.
 * @returns The names, in order.
 */
function kinds(entries: readonly Entry[]): string[] {
  return entries.map((entry) => entry.message?.role ?? entry.type);
}

/**
 * What pi said of each compaction it started: what set it off.
 *
 * @remarks
 * The host keeps the reason with the turn (SPEC-0001, `compaction`).
 *
 * @sideEffects none
 * @param events - pi's events.
 * @returns The reasons, in order.
 */
function startReasons(events: readonly PiEvent[]): string[] {
  return events.flatMap((event) => (event.type === "compaction_start" ? [event.reason] : []));
}

/**
 * What pi said of each compaction it ended, as far as an entry has it too.
 *
 * @remarks
 * The host ties a compaction seen live to its entry by these (SPEC-0001, `compaction`).
 *
 * @sideEffects none
 * @param events - pi's events.
 * @returns One each, in order.
 */
function ends(events: readonly PiEvent[]): unknown[] {
  return events.flatMap((event) =>
    event.type === "compaction_end"
      ? [
          {
            reason: event.reason,
            aborted: event.aborted,
            willRetry: event.willRetry,
            errorMessage: event.errorMessage,
            summary: event.result?.summary,
            firstKeptEntryId: event.result?.firstKeptEntryId,
          },
        ]
      : [],
  );
}

/**
 * Names the events that mark where things happen, a finished message by its role.
 *
 * @remarks
 * The scenario checks where pi compacts, not what it streams.
 *
 * @sideEffects none
 * @param events - pi's events.
 * @returns The names, in order.
 */
function marks(events: readonly PiEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "message_end") return [event.message.role];
    return MARKS.has(event.type) ? [event.type] : [];
  });
}

describe("pi contract: compaction during a run", () => {
  it("compaction-run: pi compacts after a run's last reply, and between a tool result and the next request", async () => {
    await runScenario(
      {
        scenario: "compaction-run",
        session: true,
        // Keep almost nothing verbatim and leave almost no room, so pi compacts wherever it checks.
        settings: { compaction: { keepRecentTokens: 1, reserveTokens: 127_000 } },
        script: {
          replies: [
            { blocks: [{ type: "text", text: "one" }] },
            { blocks: [{ type: "text", text: "Summary one." }] },
            { blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf ok" } }] },
            // With history before it, a compaction asks for the history's summary and the turn's.
            { blocks: [{ type: "text", text: "Summary two." }] },
            { blocks: [{ type: "text", text: "Summary three." }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, events, until }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await pi.request({ type: "prompt", message: "again" });
        await until(() => events.filter((event) => event.type === "agent_settled").length === 2);
        const { entries } = (await pi.request({ type: "get_entries" })) as unknown as { entries: Entry[] };

        expect(kinds(entries)).toStrictEqual([
          "model_change",
          "thinking_level_change",
          "system",
          "user",
          "assistant",
          "compaction",
          "user",
          "assistant",
          "toolResult",
          "compaction",
          "assistant",
        ]);
        // The first run compacts after its last reply, before it settles; the second between the
        // tool result and the request that follows it.
        expect(marks(events)).toStrictEqual([
          "agent_start",
          "turn_start",
          "system",
          "user",
          "assistant",
          "agent_end",
          "compaction_start",
          "compaction_end",
          "agent_settled",
          "agent_start",
          "turn_start",
          "user",
          "assistant",
          "toolResult",
          "compaction_start",
          "compaction_end",
          "turn_start",
          "assistant",
          "agent_end",
          "agent_settled",
        ]);
        expect(startReasons(events)).toStrictEqual(["threshold", "threshold"]);
        // What the end reports is what pi wrote to its file.
        expect(ends(events)).toStrictEqual(
          entries
            .filter((entry) => entry.type === "compaction")
            .map((entry) => ({
              reason: "threshold",
              aborted: false,
              willRetry: false,
              errorMessage: undefined,
              summary: entry.summary,
              firstKeptEntryId: entry.firstKeptEntryId,
            })),
        );
      },
    );
  });
});
