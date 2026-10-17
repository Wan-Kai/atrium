import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "../../test/contract";
import { encodeArgument, noteText } from "../agent/agent";
import { isAgentCommand } from "../catalog/commands";
import { createEventTranslator } from "../events/translate";
import { toLogEntry } from "../history/log-entry";

/** Atrium's extension, as the host has pi load it (ADR-0008, ADR-0013). */
const ATRIUM_EXTENSION = fileURLToPath(new URL("../extension/atrium.ts", import.meta.url));

/** The note a child forked into a new worktree gets (SPEC-0002, "带上下文的子对话怎么做出来"). */
const NOTE = { v: 1, kind: "note", note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" } as const;

describe("pi contract: Atrium's note to the model", () => {
  it("agent-note: idle, /atrium-agent note writes the note into the session at once, and the next request carries it", async () => {
    await runScenario(
      {
        scenario: "agent-note",
        session: true,
        extensions: [ATRIUM_EXTENSION],
        script: {
          replies: [{ blocks: [{ type: "text", text: "first" }] }, { blocks: [{ type: "text", text: "second" }] }],
        },
      },
      async ({ pi, events, until, contexts }) => {
        await pi.request({ type: "prompt", message: "one" });
        await until((event) => event.type === "agent_settled");
        const { commands } = await pi.request({ type: "get_commands" });
        const before = events.length;

        const answered = await pi.request({ type: "prompt", message: `/atrium-agent note ${encodeArgument(NOTE)}` });
        const translate = createEventTranslator(() => 0);
        const noted = events.slice(before).flatMap((event) => translate(event));
        const { entries } = (await pi.request({ type: "get_entries" })) as unknown as { entries: SessionEntry[] };
        await pi.request({ type: "prompt", message: "two" });
        await vi.waitFor(() => expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(2), {
          timeout: 20_000,
        });
        const [, second] = await contexts();

        expect(commands.filter(isAgentCommand)).toHaveLength(1);
        expect(answered).toStrictEqual({ disposition: "handled" });
        expect(noted).toStrictEqual([
          {
            kind: "note_added",
            note: { note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" },
            timestamp: expect.any(Number),
          },
        ]);
        expect(entries.map(toLogEntry).filter((entry) => entry.kind === "note")).toStrictEqual([
          expect.objectContaining({
            kind: "note",
            note: { note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" },
          }),
        ]);
        expect(
          second?.messages
            .filter((message) => (message as { role: string }).role === "user")
            .map((message) => (message as { content: unknown }).content),
        ).toStrictEqual([
          [{ type: "text", text: "one" }],
          [{ type: "text", text: noteText({ note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" }) }],
          [{ type: "text", text: "two" }],
        ]);
        expect(events.slice(before).filter((event) => event.type === "agent_start")).toHaveLength(1);
      },
    );
  });
});
