import { present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";

/** An entry of pi's `get_entries` answer, as far as this scenario reads it. */
interface Entry {
  readonly id: string;
  readonly type: string;
  readonly parentId?: string | null;
  readonly message?: { readonly role: string; readonly content?: unknown };
}

/**
 * Names an entry by its message's role, or by its type when it holds no message.
 *
 * @sideEffects none
 * @param entry - The entry.
 * @returns The role or type.
 */
function kindOf(entry: Entry): string {
  return entry.message?.role ?? entry.type;
}

/**
 * Finds the message of `role` whose only content is the text `text`.
 *
 * @remarks
 * Entry ids are random, so the scenario finds entries by what they say.
 *
 * @sideEffects none
 * @param entries - The entries to search.
 * @param role - The message's role.
 * @param text - The message's text.
 * @returns The entry.
 * @throws If there is no such entry.
 */
function messageEntry(entries: readonly Entry[], role: "user" | "assistant", text: string): Entry {
  return present(
    entries.find(
      (entry) =>
        kindOf(entry) === role && JSON.stringify(entry.message?.content) === JSON.stringify([{ type: "text", text }]),
    ),
    `the ${role} message "${text}"`,
  );
}

describe("pi contract: a session history with tools, a retry, a compaction and a branch", () => {
  it("history: writes one session file holding everything the transcript rebuild must handle", async () => {
    await runScenario(
      {
        scenario: "history",
        session: true,
        settings: { compaction: { keepRecentTokens: 1 }, retry: { baseDelayMs: 1 } },
        script: {
          replies: [
            {
              blocks: [
                { type: "thinking", text: "Look first." },
                { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf 'tool-%s' ok" } },
              ],
            },
            // One call per reply: pi runs a reply's calls in parallel, so their events would come
            // in any order, and each call needs the file the one before it wrote.
            {
              blocks: [
                { type: "toolCall", id: "call-2", name: "write", arguments: { path: "notes.txt", content: "a\nb\n" } },
              ],
            },
            {
              blocks: [
                {
                  type: "toolCall",
                  id: "call-3",
                  name: "edit",
                  arguments: { path: "notes.txt", edits: [{ oldText: "b", newText: "c\nd" }] },
                },
              ],
            },
            {
              blocks: [
                { type: "toolCall", id: "call-4", name: "read", arguments: { path: "notes.txt", offset: 2, limit: 1 } },
              ],
            },
            { blocks: [{ type: "text", text: "first answer" }] },
            { blocks: [], error: "upstream returned 503 service unavailable" },
            { blocks: [{ type: "text", text: "second answer" }] },
            // Compacting asks the model twice: for the history, and for the turn it cuts in half.
            { blocks: [{ type: "text", text: "A short summary." }] },
            { blocks: [{ type: "text", text: "The turn so far." }] },
            { blocks: [{ type: "text", text: "third answer" }] },
            { blocks: [{ type: "text", text: "branch answer" }] },
            { blocks: [{ type: "text", text: "fourth answer" }] },
          ],
        },
      },
      async ({ pi, events, until }) => {
        /** Waits until pi has settled `count` times in all. */
        const settled = (count: number) =>
          until(() => events.filter((event) => event.type === "agent_settled").length === count);

        await pi.request({ type: "prompt", message: "one" });
        await settled(1);
        await pi.request({ type: "prompt", message: "two" });
        await settled(2);
        await pi.request({ type: "compact" });
        await pi.request({ type: "prompt", message: "three" });
        await settled(3);
        const { entries } = (await pi.request({ type: "get_entries" })) as { entries: Entry[] };
        const two = messageEntry(entries, "user", "two");
        expect(await pi.request({ type: "prompt", message: `/faux-navigate ${two.id}` })).toStrictEqual({
          disposition: "handled",
        });
        await pi.request({ type: "prompt", message: "two, differently" });
        await settled(4);
        // Back to the first branch, so the file ends on it: pi takes the last entry as the leaf
        // when it opens the file, and that branch holds the retry and the compaction.
        const branched = (await pi.request({ type: "get_entries" })) as { entries: Entry[] };
        const third = messageEntry(branched.entries, "assistant", "third answer");
        expect(await pi.request({ type: "prompt", message: `/faux-navigate ${third.id}` })).toStrictEqual({
          disposition: "handled",
        });
        await pi.request({ type: "prompt", message: "four" });
        await settled(5);

        const after = (await pi.request({ type: "get_entries" })) as { entries: Entry[]; leafId: string };
        // In file order: the retry's error and its context_edit, then the compaction, then the branch.
        expect(after.entries.map(kindOf)).toStrictEqual([
          "model_change",
          "thinking_level_change",
          "system",
          "user",
          "assistant",
          "toolResult",
          "assistant",
          "toolResult",
          "assistant",
          "toolResult",
          "assistant",
          "toolResult",
          "assistant",
          "user",
          "assistant",
          "context_edit",
          "assistant",
          "compaction",
          "user",
          "assistant",
          "user",
          "assistant",
          "user",
          "assistant",
        ]);
        expect(after.leafId).toBe(after.entries.at(-1)?.id);
        expect(after.entries.at(-2)?.parentId).toBe(third.id);
        expect(events.findLast((event) => event.type === "message_end")).toMatchObject({
          message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "fourth answer" }] },
        });
      },
    );
  });
});
