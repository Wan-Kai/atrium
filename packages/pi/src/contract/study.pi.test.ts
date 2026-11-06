import { present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";

/** What a direction's `AGENTS.md` says, to find in what the model is told. */
const METHOD = "Teach one idea at a time. study-agents-marker";

/** What an untrusted directory's `.pi/SYSTEM.md` says, which pi must not use. */
const UNTRUSTED = "untrusted-system-marker";

/**
 * Everything the model was told in a request's system message, as one text.
 *
 * @remarks
 * pi 1.x sends its system prompt as a `system` message with `sections` (the faux extension's
 * `instructionsOf`); stringified, the text of every part is in it.
 *
 * @sideEffects none
 * @param messages - The request's messages.
 * @returns The system message as JSON, or empty without one.
 */
function systemText(messages: readonly unknown[]): string {
  const system = messages.find((message) => Reflect.get(Object(message), "role") === "system");
  return system === undefined ? "" : JSON.stringify(system);
}

describe("pi contract: study mode (SPEC-0008)", () => {
  it("study-agents: reads AGENTS.md in a direction's directory without trusting it", async () => {
    await runScenario(
      {
        scenario: "study-agents",
        script: { replies: [{ blocks: [{ type: "text", text: "ok" }] }] },
        // A direction's directory as the host makes it, and what only trust would let in.
        files: {
          "AGENTS.md": `# Learning direction\n\n${METHOD}\n`,
          ".atrium-study.json": '{"version":1,"name":"Go"}\n',
          ".pi/SYSTEM.md": `${UNTRUSTED}\n`,
        },
      },
      async ({ pi, until, contexts, cwd }) => {
        await pi.request({ type: "prompt", message: "我想学 Go" });
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();
        const told = systemText(present(request, "the request").messages);

        expect(told).toContain(METHOD);
        expect(told).toContain(`<project_instructions path=\\"${cwd}/AGENTS.md\\">`);
        expect(told).not.toContain(UNTRUSTED);
      },
    );
  });
});
