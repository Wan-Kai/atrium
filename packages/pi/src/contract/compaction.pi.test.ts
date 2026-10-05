import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";

describe("pi contract: compaction", () => {
  it("compaction: a prompt sent while compacting fails, and compaction reports start and end", async () => {
    await runScenario(
      {
        scenario: "compaction",
        // Keep almost nothing verbatim, so one exchange is enough to compact.
        settings: { compaction: { keepRecentTokens: 1 } },
        script: {
          replies: [
            { blocks: [{ type: "text", text: "something worth summarizing" }] },
            { waitFor: "summary", blocks: [{ type: "text", text: "A short summary." }] },
          ],
        },
      },
      async ({ pi, events, until, release }) => {
        await pi.request({ type: "prompt", message: "one" });
        await until((event) => event.type === "agent_settled");
        const compacting = pi.request({ type: "compact" }).catch((error: unknown) => error);
        await until((event) => event.type === "compaction_start");
        const during = await pi.request({ type: "prompt", message: "two" }).catch((error: unknown) => error);
        await release("summary");
        const result = await compacting;
        await until((event) => event.type === "compaction_end");

        expect(during).toMatchObject({ reason: "rejected" });
        // pi frames the model's summary with context of its own, such as the split turn.
        expect(result).toMatchObject({ summary: expect.stringContaining("A short summary.") });
        expect(events.find((event) => event.type === "compaction_start")).toMatchObject({ reason: "manual" });
      },
    );
  });
});
