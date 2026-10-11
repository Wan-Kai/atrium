import { FakeClock } from "@atrium/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { type TestHost, startTestHost } from "../test/harness";

let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
});

/** The host's log records with the given message. */
async function recordsWith(host: TestHost, msg: string): Promise<Record<string, unknown>[]> {
  return (await host.readLog()).filter((record) => record["msg"] === msg);
}

describe("usage in the host's log", () => {
  it("logs resource counts and memory once a minute", async () => {
    const clock = new FakeClock(0);
    testHost = await startTestHost({ clock });
    await testHost.host.tools;

    clock.advance(59_999);
    expect(await recordsWith(testHost, "resource usage")).toStrictEqual([]);
    clock.advance(1);
    clock.advance(60_000);
    const reports = await recordsWith(testHost, "resource usage");

    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report).toMatchObject({
        level: "info",
        resources: expect.objectContaining({ "tools.detect": 0 }),
        memory: {
          rss: expect.any(Number),
          heapTotal: expect.any(Number),
          heapUsed: expect.any(Number),
          external: expect.any(Number),
          arrayBuffers: expect.any(Number),
        },
      });
    }
  });

  it("logs the desktop app's processes it is handed", async () => {
    testHost = await startTestHost();

    testHost.host.recordAppMetrics([
      { type: "Browser", memoryKb: 120_000, cpuPercent: 1.5 },
      { type: "Utility", memoryKb: 80_000, cpuPercent: 0 },
    ]);

    expect(await recordsWith(testHost, "app metrics")).toStrictEqual([
      expect.objectContaining({
        level: "info",
        processes: [
          { type: "Browser", memoryKb: 120_000, cpuPercent: 1.5 },
          { type: "Utility", memoryKb: 80_000, cpuPercent: 0 },
        ],
      }),
    ]);
  });
});
