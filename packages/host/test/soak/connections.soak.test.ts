import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startTestHost } from "../harness";

const minutes = Number(process.env["SOAK_MINUTES"] ?? 30);
const durationMs = minutes * 60_000;
/** About sixty samples per run, but never more often than once a second. */
const sampleEveryMs = Math.max(1_000, durationMs / 60);

interface Sample {
  readonly elapsedMs: number;
  readonly cycles: number;
  readonly rss: number;
  readonly heapUsed: number;
  readonly resources: Record<string, number>;
}

/** Least-squares slope of `y` over `x`. */
function slope(points: ReadonlyArray<readonly [number, number]>): number {
  const n = points.length;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
  const covariance = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const variance = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  return variance === 0 ? 0 : covariance / variance;
}

describe("host soak", () => {
  it(
    `keeps resources flat while clients connect and disconnect for ${minutes} minutes`,
    async () => {
      const testHost = await startTestHost({ logLevel: "warn" });
      const baseline = { ...testHost.host.resources.snapshot(), span: 0, timer: 1, "ws.connection": 0 };
      const samples: Sample[] = [];
      const started = Date.now();
      let nextSample = started;
      let cycles = 0;

      while (Date.now() - started < durationMs) {
        const batch = Array.from({ length: 5 }, () => testHost.connect());
        await Promise.all(batch.map((connection) => connection.connect()));
        for (const connection of batch) connection.disconnect();
        await testHost.connect({ token: "wrong-token-0123456789abcdefghijklmnop" }).connect();
        cycles += 1;
        if (Date.now() >= nextSample) {
          globalThis.gc?.();
          const memory = process.memoryUsage();
          samples.push({
            elapsedMs: Date.now() - started,
            cycles,
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            resources: testHost.host.resources.snapshot(),
          });
          nextSample += sampleEveryMs;
        }
      }

      await vi.waitFor(() => expect(testHost.host.resources.snapshot()).toStrictEqual(baseline), { timeout: 5_000 });
      const report = join(process.cwd(), "reports", "soak");
      await mkdir(report, { recursive: true });
      await writeFile(
        join(report, `connections-${new Date().toISOString().replaceAll(":", "-")}.csv`),
        [
          "elapsed_ms,cycles,rss,heap_used,resources",
          ...samples.map(
            (s) =>
              `${s.elapsedMs},${s.cycles},${s.rss},${s.heapUsed},"${JSON.stringify(s.resources).replaceAll('"', "'")}"`,
          ),
        ].join("\n"),
      );
      const afterWarmup = samples.slice(Math.floor(samples.length / 3));
      const bytesPerCycle = slope(afterWarmup.map((s) => [s.cycles, s.heapUsed] as const));
      await testHost.dispose();
      expect(afterWarmup.length).toBeGreaterThanOrEqual(10);
      expect(bytesPerCycle).toBeLessThan(1024);
    },
    durationMs + 120_000,
  );
});
