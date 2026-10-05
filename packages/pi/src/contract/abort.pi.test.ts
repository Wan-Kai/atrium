import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";

describe("pi contract: stopping a run", () => {
  it("abort: clear_queue returns the queued input, and abort answers only once the run has stopped", async () => {
    await runScenario(
      {
        scenario: "abort",
        script: { replies: [{ waitFor: "never", blocks: [{ type: "text", text: "unseen" }] }] },
      },
      async ({ pi, events, heldAfterUserMessage }) => {
        await pi.request({ type: "prompt", message: "one" });
        await heldAfterUserMessage(1);
        await pi.request({ type: "prompt", message: "two", streamingBehavior: "followUp" });

        expect(await pi.request({ type: "clear_queue" })).toStrictEqual({ steering: [], followUp: ["two"] });
        expect(await pi.request({ type: "abort" })).toBeUndefined();

        expect(events.findLast((event) => event.type === "message_end")).toMatchObject({
          message: { role: "assistant", stopReason: "aborted" },
        });
        expect(events.at(-1)?.type).toBe("agent_settled");
      },
    );
  });
});
