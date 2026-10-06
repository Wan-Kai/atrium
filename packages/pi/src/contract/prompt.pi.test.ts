import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";
import type { PiEvent } from "../process/pi-process";

/** The text deltas of the stream, joined. */
function text(events: readonly PiEvent[], kind: "text_delta" | "thinking_delta"): string {
  return events
    .flatMap((event) =>
      event.type === "message_update" && event.assistantMessageEvent.type === kind
        ? [event.assistantMessageEvent.delta]
        : [],
    )
    .join("");
}

describe("pi contract: prompt", () => {
  it("prompt-started: answers started, streams thinking and text, and settles once", async () => {
    await runScenario(
      {
        scenario: "prompt-started",
        script: {
          replies: [
            {
              blocks: [
                { type: "thinking", text: "Plan first." },
                { type: "text", text: "Hello from faux." },
              ],
            },
          ],
        },
      },
      async ({ pi, events, until }) => {
        expect(await pi.request({ type: "prompt", message: "hi" })).toStrictEqual({ disposition: "started" });
        await until((event) => event.type === "agent_settled");

        expect(text(events, "thinking_delta")).toBe("Plan first.");
        expect(text(events, "text_delta")).toBe("Hello from faux.");
        expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(1);
        expect(events.at(-1)?.type).toBe("agent_settled");
      },
    );
  });
});

describe("pi contract: prompt, continued", () => {
  it("prompt-tool: runs a tool call and feeds its result into the next turn", async () => {
    await runScenario(
      {
        scenario: "prompt-tool",
        script: {
          replies: [
            {
              blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf 'tool-%s' ok" } }],
            },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, events, until }) => {
        await pi.request({ type: "prompt", message: "run it" });
        await until((event) => event.type === "agent_settled");

        expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({
          toolCallId: "call-1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "tool-ok" }] },
        });
        expect(events.filter((event) => event.type === "turn_end")).toHaveLength(2);
      },
    );
  });

  it("prompt-queued: a follow-up sent during a run is queued, reported, and runs after it", async () => {
    await runScenario(
      {
        scenario: "prompt-queued",
        script: {
          replies: [
            { waitFor: "first", blocks: [{ type: "text", text: "first answer" }] },
            { blocks: [{ type: "text", text: "second answer" }] },
          ],
        },
      },
      async ({ pi, events, until, release, heldAfterUserMessage }) => {
        await pi.request({ type: "prompt", message: "one" });
        await heldAfterUserMessage(1);

        expect(await pi.request({ type: "prompt", message: "two", streamingBehavior: "followUp" })).toStrictEqual({
          disposition: "queued",
        });
        await until((event) => event.type === "queue_update");
        await release("first");
        await until((event) => event.type === "agent_settled");

        expect(events.find((event) => event.type === "queue_update")).toMatchObject({ followUp: ["two"] });
        expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(1);
        expect(text(events, "text_delta")).toBe("first answersecond answer");
      },
    );
  });

  it("prompt-handled: an extension command consumes the input without a run", async () => {
    await runScenario({ scenario: "prompt-handled", script: { replies: [] } }, async ({ pi, events }) => {
      expect(await pi.request({ type: "prompt", message: "/faux-noop" })).toStrictEqual({ disposition: "handled" });
      expect(await pi.request({ type: "get_state" })).toMatchObject({ isStreaming: false });
      expect(events).toStrictEqual([]);
    });
  });
});
