import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";
import { toSlashCommand } from "../catalog/commands";
import type { PiEvent } from "../process/pi-process";

/** The first user message pi echoed. */
function firstUserMessage(events: readonly PiEvent[]): PiEvent | undefined {
  return events.find((event) => event.type === "message_end" && event.message.role === "user");
}

describe("pi contract: slash commands", () => {
  it("commands: lists extension commands, prompt templates and skills, and expands a template sent as a prompt", async () => {
    await runScenario(
      {
        scenario: "commands",
        script: { replies: [{ blocks: [{ type: "text", text: "reviewed" }] }] },
        files: {
          "pi-agent/prompts/review.md": "---\ndescription: Reviews the change\n---\nReview $1 carefully.\n",
          "pi-agent/skills/tdd/SKILL.md": "---\nname: tdd\ndescription: Test first\n---\nWrite the test first.\n",
        },
      },
      async ({ pi, events, until }) => {
        const { commands } = await pi.request({ type: "get_commands" });
        await pi.request({ type: "prompt", message: "/review src/a.ts" });
        await until((event) => event.type === "agent_settled");
        const steered = await pi.request({ type: "steer", message: "/faux-noop" }).catch((error: unknown) => error);

        // pi's own extensions (`/llama`, `/mcp`) come after the faux one's, then templates, then skills.
        expect(commands.map(toSlashCommand)).toStrictEqual([
          { name: "faux-noop", description: "Does nothing", source: "extension" },
          { name: "faux-navigate", description: "Navigates the session tree to the given entry", source: "extension" },
          { name: "faux-confirm", description: "Asks for confirmation", source: "extension" },
          { name: "llama", description: "Manage llama.cpp router models", source: "extension" },
          {
            name: "mcp",
            description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure",
            source: "extension",
          },
          { name: "review", description: "Reviews the change", source: "prompt" },
          { name: "skill:tdd", description: "Test first", source: "skill" },
        ]);
        expect(firstUserMessage(events)).toMatchObject({
          message: { content: [{ type: "text", text: "Review src/a.ts carefully." }] },
        });
        expect(steered).toMatchObject({ reason: "rejected" });
      },
    );
  });
});
