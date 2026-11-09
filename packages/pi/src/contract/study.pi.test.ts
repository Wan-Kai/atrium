import { type FauxContext, present } from "@atrium/testkit";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";
import { AGENT_MESSAGE, encodeArgument } from "../agent/agent";
import { readRequest } from "../agent/channel";
import type { PiEvent } from "../process/pi-process";
import { AGENTS_RULE, STUDY_FLAG, STUDY_TOOLS, kickoffText, startCommand, studyArgument } from "../study/study";

/** Atrium's extension, as the host has pi load it (ADR-0008, ADR-0013). */
const ATRIUM_EXTENSION = fileURLToPath(new URL("../extension/atrium.ts", import.meta.url));

/**
 * The study tools a request offered the model, sorted.
 *
 * @remarks
 * pi's and the other parts' tools are left out.
 *
 * @sideEffects none
 * @param request - The request; none offered nothing.
 * @returns The tools.
 */
function studyTools(request: FauxContext | undefined): string[] {
  return [...(request?.tools ?? [])].filter((tool) => (STUDY_TOOLS as readonly string[]).includes(tool)).toSorted();
}

/**
 * Whether an event is a call the extension made on its status line.
 *
 * @remarks
 * `atrium-agent:<request id>` with the envelope as its text (ADR-0013, point 1).
 *
 * @sideEffects none
 * @param id - The request id.
 * @returns The predicate.
 */
function asked(id: string): (event: PiEvent) => boolean {
  return (event) =>
    event.type === "extension_ui_request" &&
    event.method === "setStatus" &&
    event.statusKey === `atrium-agent:${id}` &&
    event.statusText !== undefined;
}

/**
 * Whether an event ends a custom message.
 *
 * @remarks
 * The kickoff is one (SPEC-0008, "ML2 定的细节").
 *
 * @sideEffects none
 * @param event - The event.
 * @returns Whether it does.
 */
function customEnd(event: PiEvent): boolean {
  return event.type === "message_end" && event.message.role === "custom";
}

/**
 * The text of the last tool result a request carried.
 *
 * @remarks
 * What the model was told.
 *
 * @sideEffects none
 * @param request - The request; none has no result.
 * @returns The text.
 */
function lastResult(request: FauxContext | undefined): string {
  const result = (request?.messages ?? []).findLast(
    (message) => Reflect.get(message as object, "role") === "toolResult",
  );
  const content: unknown = result === undefined ? [] : Reflect.get(Object(result), "content");
  return Array.isArray(content)
    ? content.map((block: unknown) => String(Reflect.get(block as object, "text") ?? "")).join("")
    : "";
}

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

  it("study-tools-none: a session without --atrium-study, as a workspace's, a chat's or an asking one, has no study tool", async () => {
    await runScenario(
      {
        scenario: "study-tools-none",
        extensions: [ATRIUM_EXTENSION],
        // An asking session's use is never given; one that came anyway is read as none.
        args: [`--${STUDY_FLAG}=${encodeArgument({ v: 1, kind: "ask" })}`],
        script: { replies: [{ blocks: [{ type: "text", text: "ok" }] }] },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "hi" });
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();

        expect(studyTools(request)).toStrictEqual([]);
        expect(systemText(present(request, "the request").messages)).not.toContain("atrium_study");
      },
    );
  });

  it("study-tools-discuss: a discussion has its three tools, registered at session start, and its prompt", async () => {
    await runScenario(
      {
        scenario: "study-tools-discuss",
        extensions: [ATRIUM_EXTENSION],
        args: [`--${STUDY_FLAG}=${studyArgument({ kind: "discuss" })}`],
        script: { replies: [{ blocks: [{ type: "text", text: "ok" }] }] },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "我想学 Go" });
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();

        expect(studyTools(request)).toStrictEqual(["study_set_ladder", "study_set_name", "study_set_profile"]);
        expect(systemText(present(request, "the request").messages)).toContain("This session's use: discuss.");
        expect(systemText(present(request, "the request").messages)).toContain(AGENTS_RULE);
      },
    );
  });

  it("study-call: a study tool asks the host on the agent channel and the model reads the answer", async () => {
    await runScenario(
      {
        scenario: "study-call",
        extensions: [ATRIUM_EXTENSION],
        args: [`--${STUDY_FLAG}=${studyArgument({ kind: "lesson", level: "l1", step: "s1" })}`],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "study_report", arguments: {} }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        const call = await until(asked("call-1"));
        const read = readRequest(String(Reflect.get(call, "statusText")));
        await pi.request({
          type: "prompt",
          message: `/atrium-agent reply ${encodeArgument({ v: 1, id: "call-1", ok: true, result: {} })}`,
        });
        await until((event) => event.type === "agent_settled");
        const [first, second] = await contexts();

        expect(read).toStrictEqual({ request: { kind: "call", id: "call-1", op: "study_report", args: {} } });
        expect(studyTools(first)).toStrictEqual(["study_report"]);
        expect(lastResult(second)).toBe("Reported.");
      },
    );
  });

  it("study-too-long: a text over its limit reaches the extension, which answers agent_text_too_long without asking the host", async () => {
    await runScenario(
      {
        scenario: "study-too-long",
        extensions: [ATRIUM_EXTENSION],
        args: [`--${STUDY_FLAG}=${studyArgument({ kind: "discuss" })}`],
        script: {
          replies: [
            {
              blocks: [
                { type: "toolCall", id: "call-1", name: "study_set_name", arguments: { name: "x".repeat(300) } },
              ],
            },
            { blocks: [{ type: "text", text: "shorter then" }] },
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "给方向起个名字" });
        // pi does not refuse it by its schema; the extension answers without a call to the host.
        await until((event) => event.type === "agent_settled");
        const [, second] = await contexts();

        expect(lastResult(second)).toBe("Error agent_text_too_long: name is too long: at most 256 characters.");
      },
    );
  });

  it("study-kickoff: /atrium-study start opens a turn with the use, which the model reads as Atrium's, not the learner's", async () => {
    const launch = { kind: "lesson", level: "l1", step: "s1" } as const;
    await runScenario(
      {
        scenario: "study-kickoff",
        session: true,
        extensions: [ATRIUM_EXTENSION],
        args: [`--${STUDY_FLAG}=${studyArgument(launch)}`],
        script: { replies: [{ blocks: [{ type: "text", text: "第一课" }] }] },
      },
      async ({ pi, until, contexts }) => {
        const handled = await pi.request({ type: "prompt", message: startCommand() });
        const message = await until(customEnd);
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();

        expect(handled).toStrictEqual({ disposition: "handled" });
        expect(message).toMatchObject({
          message: {
            role: "custom",
            customType: AGENT_MESSAGE,
            details: { v: 1, kind: "study", deliveries: [], study: launch },
          },
        });
        expect(JSON.stringify(present(request, "the request").messages)).toContain(
          JSON.stringify(kickoffText(launch)).slice(1, -1),
        );
      },
    );
  });
});
