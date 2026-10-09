import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";
import type { PiEvent } from "../process/pi-process";

/** The steers pi listed in each `queue_update`, in order. */
function steering(events: readonly PiEvent[]): string[][] {
  return events.flatMap((event) => (event.type === "queue_update" ? [[...event.steering]] : []));
}

/** The content of every user message pi finished, in order. */
function userMessages(events: readonly PiEvent[]): unknown[] {
  return events.flatMap((event) =>
    event.type === "message_end" && event.message.role === "user" ? [event.message.content] : [],
  );
}

describe("pi contract: steering", () => {
  it("steer: lists a steer until it is delivered after the tool batch, and only parks one while idle", async () => {
    await runScenario(
      {
        scenario: "steer",
        script: {
          replies: [
            {
              waitFor: "first",
              blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf ok" } }],
            },
            { blocks: [{ type: "text", text: "steered" }] },
          ],
        },
      },
      async ({ pi, events, until, release, heldAfterUserMessage }) => {
        await pi.request({ type: "prompt", message: "one" });
        await heldAfterUserMessage(1);

        expect(await pi.request({ type: "steer", message: "also" })).toStrictEqual({ disposition: "queued" });
        await until((event) => event.type === "queue_update");
        await release("first");
        await until((event) => event.type === "agent_settled");
        expect(steering(events)).toStrictEqual([["also"], []]);
        expect(userMessages(events)).toStrictEqual([[{ type: "text", text: "one" }], [{ type: "text", text: "also" }]]);
        expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(1);

        // Idle, a steer is only taken into pi's queue; no run starts (SPEC-0001, "运行控制").
        expect(await pi.request({ type: "steer", message: "later" })).toStrictEqual({ disposition: "queued" });
        expect(await pi.request({ type: "get_state" })).toMatchObject({ isStreaming: false, pendingMessageCount: 1 });
        expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
      },
    );
  });
});
