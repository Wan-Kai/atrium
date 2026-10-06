import { present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";

describe("pi contract: exit", () => {
  it("exit-sigterm: exits with 143 on SIGTERM", async () => {
    const records = await runScenario({ scenario: "exit-sigterm", script: { replies: [] } }, async ({ pi }) => {
      await pi.request({ type: "get_state" });
      process.kill(present(pi.pid, "pid"), "SIGTERM");

      expect(await pi.exited).toMatchObject({ code: 143, signal: null, requested: false });
    });

    expect(records.at(-1)).toStrictEqual({ kind: "exit", code: 143, signal: null, requested: false });
  });

  it("exit-stdin: exits with 0 when stdin closes", async () => {
    const records = await runScenario({ scenario: "exit-stdin", script: { replies: [] } }, async ({ pi }) => {
      await pi.request({ type: "get_state" });
    });

    expect(records.at(-1)).toStrictEqual({ kind: "exit", code: 0, signal: null, requested: true });
  });
});
