import { afterEach, describe, expect, it, vi } from "vitest";

/** Counts Node's live timers, independent of the host's own bookkeeping. */
function liveTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}
import { type TestHost, startTestHost } from "../../test/harness";

let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
});

describe("connection resources", () => {
  it("returns every resource count to its baseline after 200 accepted and 50 rejected connections", async () => {
    testHost = await startTestHost({ logLevel: "warn" });
    const host = testHost.host;
    // Two timers stay: the heartbeat and the background fetch's next run.
    const baseline = {
      ...host.resources.snapshot(),
      span: 0,
      timer: 2,
      "git.process": 0,
      "ws.connection": 0,
      "sync.connection": 0,
    };
    const timersBefore = liveTimers();

    for (let round = 0; round < 200; round++) {
      const connection = testHost.connect();
      expect(await connection.connect()).toMatchObject({ status: "connected" });
      connection.disconnect();
    }
    for (let round = 0; round < 50; round++) {
      expect(await testHost.connect({ token: "wrong-token-0123456789abcdefghijklmnop" }).connect()).toStrictEqual({
        status: "rejected",
        reason: "unauthorized",
      });
    }

    await vi.waitFor(() => expect(host.resources.snapshot()).toStrictEqual(baseline), { timeout: 5_000 });
    await vi.waitFor(() => expect(liveTimers()).toBeLessThanOrEqual(timersBefore), { timeout: 2_000 });
  });
});
