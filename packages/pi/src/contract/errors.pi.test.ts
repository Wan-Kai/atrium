import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";

describe("pi contract: model errors", () => {
  it("error-retry: retries a transient error itself, but ends at once on one that is not", async () => {
    await runScenario(
      {
        scenario: "error-retry",
        script: {
          replies: [
            { blocks: [], error: "upstream returned 503 service unavailable" },
            { blocks: [{ type: "text", text: "recovered" }] },
            { blocks: [], error: "scripted failure" },
          ],
        },
      },
      async ({ pi, events, until }) => {
        await pi.request({ type: "prompt", message: "one" });
        await until((event) => event.type === "agent_settled");
        await pi.request({ type: "prompt", message: "two" });
        await until(() => events.filter((event) => event.type === "agent_settled").length === 2);

        expect(events.find((event) => event.type === "auto_retry_start")).toMatchObject({
          attempt: 1,
          errorMessage: "upstream returned 503 service unavailable",
        });
        expect(events.find((event) => event.type === "auto_retry_end")).toMatchObject({ success: true });
        expect(events.filter((event) => event.type === "auto_retry_start")).toHaveLength(1);
        expect(events.findLast((event) => event.type === "message_end")).toMatchObject({
          message: { role: "assistant", stopReason: "error", errorMessage: "scripted failure" },
        });
      },
    );
  });
});
