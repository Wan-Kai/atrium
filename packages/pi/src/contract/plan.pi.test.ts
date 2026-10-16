import { FAUX_BASE_URL_ENV, type ModelListServer, startModelListServer } from "@atrium/testkit";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";
import { isFastSwitch } from "../catalog/commands";
import { isPlanQuery } from "../plan/plan";
import { queryPlanUsage } from "../plan/query";

/** Atrium's extension, Fast and the plan query, as the host has pi load it (ADR-0010). */
const ATRIUM_EXTENSION = fileURLToPath(new URL("../extension/atrium.ts", import.meta.url));

/** ChatGPT's answer to `wham/usage` (ADR-0010). */
const USAGE = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 39, limit_window_seconds: 18_000, reset_at: 1_782_770_922 },
    secondary_window: { used_percent: 52, limit_window_seconds: 604_800, reset_at: 1_783_357_722 },
  },
};

const servers: ModelListServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe("pi contract: Atrium's plan query", () => {
  it("plan: lists the query beside Fast, runs it without a turn, and reports ChatGPT's usage before answering", async () => {
    const usage = await startModelListServer((response) =>
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(USAGE)),
    );
    servers.push(usage);
    await runScenario(
      {
        scenario: "plan",
        script: { provider: "openai-codex", models: [{ id: "gpt-6.1-sol" }], replies: [] },
        extensions: [ATRIUM_EXTENSION],
        env: { [FAUX_BASE_URL_ENV]: usage.baseUrl },
      },
      async ({ pi, events }) => {
        const { commands } = await pi.request({ type: "get_commands" });
        const before = events.length;
        const answered = await pi.request({ type: "prompt", message: "/atrium-plan openai-codex" });
        const printed = events.slice(before);
        const queried = await queryPlanUsage(pi, "openai-codex");

        expect([commands.filter(isPlanQuery).length, commands.filter(isFastSwitch).length]).toStrictEqual([1, 1]);
        expect(answered).toStrictEqual({ disposition: "handled" });
        const report = {
          provider: "openai-codex",
          plan: "plus",
          windows: [
            { seconds: 18_000, model: null, usedPercent: 39, resetsAt: 1_782_770_922_000 },
            { seconds: 604_800, model: null, usedPercent: 52, resetsAt: 1_783_357_722_000 },
          ],
        };
        expect(printed).toStrictEqual([
          {
            type: "extension_ui_request",
            id: expect.any(String),
            method: "setStatus",
            statusKey: "atrium-plan",
            statusText: JSON.stringify(report),
          },
        ]);
        expect(queried).toStrictEqual(report);
        expect(
          usage.requests.map(({ url, headers }) => [url, headers["authorization"], headers["originator"]]),
        ).toStrictEqual([
          ["/backend-api/wham/usage", "Bearer faux-key", "pi"],
          ["/backend-api/wham/usage", "Bearer faux-key", "pi"],
        ]);
      },
    );
  });
});
