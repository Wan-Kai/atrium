import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "usage.mjs");
const MB = 1024 * 1024;

/** A log directory with the given files, each a list of records or raw lines. */
async function logsWith(files: Readonly<Record<string, readonly (object | string)[]>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atrium-usage-logs-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  for (const [name, lines] of Object.entries(files)) {
    const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
    await writeFile(join(dir, name), `${text}\n`);
  }
  return dir;
}

/** Runs `pnpm usage` in UTC and returns its output, or the failure's output and code. */
async function usage(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { env: { ...process.env, TZ: "UTC" } });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; code: number };
    return { stdout: failed.stdout, stderr: failed.stderr, code: failed.code };
  }
}

/** The record a host writes when it starts listening. */
const listening = (time: string) => ({ level: "info", time, service: "host", port: 1, msg: "host listening" });

/** A host's minute report, with memory in MB. */
const report = (time: string, rssMb: number, heapMb: number, resources: Record<string, number>) => ({
  level: "info",
  time,
  service: "host",
  resources,
  memory: { rss: rssMb * MB, heapTotal: 2 * heapMb * MB, heapUsed: heapMb * MB, external: 0, arrayBuffers: 0 },
  msg: "resource usage",
});

/** A sample of the desktop app's processes, with memory in MB. */
const app = (time: string, processes: ReadonlyArray<readonly [string, number]>) => ({
  level: "info",
  time,
  service: "host",
  processes: processes.map(([type, mb]) => ({ type, memoryKb: mb * 1024, cpuPercent: 0.5 })),
  msg: "app metrics",
});

describe("pnpm usage", () => {
  it("lists each run's hourly usage across rotated files and compares the first and last hour's floors", async () => {
    const dir = await logsWith({
      "host.10.jsonl": [
        report("2026-10-11T09:01:00.000Z", 104, 44, { "pi.process": 1, "ws.client": 1 }),
        app("2026-10-11T09:01:10.000Z", [
          ["Browser", 150],
          ["Tab", 100],
          ["Tab", 60],
        ]),
        report("2026-10-11T10:01:00.000Z", 120, 70, { "pi.process": 2, "ws.client": 1 }),
        app("2026-10-11T10:01:10.000Z", [
          ["Browser", 151],
          ["Tab", 400],
        ]),
        report("2026-10-11T10:30:00.000Z", 150, 90, { "pi.process": 3 }),
        app("2026-10-11T10:30:10.000Z", [
          ["Browser", 300],
          ["Tab", 500],
        ]),
        listening("2026-10-11T11:00:00.000Z"),
        report("2026-10-11T11:01:00.000Z", 90, 30, { "pi.process": 0, "ws.client": 1 }),
        '{"level":"info","time":"2026-10-11T11:02:00.000Z","msg":"resource us',
      ],
      "host.9.jsonl": [
        listening("2026-10-11T08:00:00.000Z"),
        report("2026-10-11T08:01:00.000Z", 100, 40, { "pi.process": 1 }),
        app("2026-10-11T08:01:10.000Z", [
          ["Browser", 150],
          ["GPU", 20],
          ["Tab", 200],
        ]),
        report("2026-10-11T08:30:00.000Z", 110, 42, { "pi.process": 2, "ws.client": 1 }),
        { level: "info", time: "2026-10-11T08:31:00.000Z", service: "host", msg: "client connected" },
      ],
      "notes.txt": [report("2026-10-11T08:02:00.000Z", 1, 1, {})],
    });

    expect(await usage(dir)).toStrictEqual({
      stdout: [
        "run 2026-10-11 08:00 · 2.5 h · 5 samples",
        "  10-11 08:01  rss 100.0 MB  heap 40.0 MB  pi.process=1  app Browser 150.0 MB, GPU 20.0 MB, Tab 200.0 MB",
        "  10-11 09:01  rss 104.0 MB  heap 44.0 MB  pi.process=1 ws.client=1  app Browser 150.0 MB, Tab 160.0 MB",
        "  10-11 10:01  rss 120.0 MB  heap 70.0 MB  pi.process=2 ws.client=1  app Browser 151.0 MB, Tab 400.0 MB",
        "  10-11 10:30  rss 150.0 MB  heap 90.0 MB  pi.process=3  app Browser 300.0 MB, Tab 500.0 MB",
        "  floors, first hour → last hour:",
        "    rss 100.0 → 120.0 MB",
        "    heap 40.0 → 70.0 MB ↑",
        "    pi.process 1 → 2 ↑",
        "    app Browser 150.0 → 151.0 MB",
        "    app Tab 200.0 → 400.0 MB ↑",
        "run 2026-10-11 11:00 · 0.0 h · 1 sample",
        "  10-11 11:01  rss 90.0 MB  heap 30.0 MB  ws.client=1",
        "  shorter than two hours, no comparison",
        "",
      ].join("\n"),
      stderr: "",
      code: 0,
    });
  });

  it("counts a run whose start has rotated out of the log from its first record", async () => {
    const dir = await logsWith({
      "host.3.jsonl": [
        report("2026-10-11T08:00:00.000Z", 100, 40, { "pi.process": 0, "ws.client": 1 }),
        report("2026-10-11T09:00:00.000Z", 90, 40, { "pi.process": 0, "ws.client": 1 }),
        report("2026-10-11T10:00:00.000Z", 200, 40, { "pi.process": 0, "ws.client": 1 }),
      ],
    });

    expect(await usage(dir)).toStrictEqual({
      stdout: [
        "run 2026-10-11 08:00 · 2.0 h · 3 samples",
        "  10-11 08:00  rss 100.0 MB  heap 40.0 MB  ws.client=1",
        "  10-11 09:00  rss 90.0 MB  heap 40.0 MB  ws.client=1",
        "  10-11 10:00  rss 200.0 MB  heap 40.0 MB  ws.client=1",
        "  floors, first hour → last hour:",
        "    rss 100.0 → 90.0 MB",
        "    heap 40.0 → 40.0 MB",
        "    ws.client 1 → 1",
        "",
      ].join("\n"),
      stderr: "",
      code: 0,
    });
  });

  it("marks memory only when its floor grows above one and a half times", async () => {
    const dir = await logsWith({
      "host.1.jsonl": [
        listening("2026-10-11T08:00:00.000Z"),
        report("2026-10-11T08:01:00.000Z", 100, 40, {}),
        report("2026-10-11T10:00:00.000Z", 150, 60.1, {}),
      ],
    });

    expect((await usage(dir)).stdout.split("\n").slice(-4)).toStrictEqual([
      "  floors, first hour → last hour:",
      "    rss 100.0 → 150.0 MB",
      "    heap 40.0 → 60.1 MB ↑",
      "",
    ]);
  });

  it("compares nothing when the first hour has no report", async () => {
    const dir = await logsWith({
      "host.1.jsonl": [
        listening("2026-10-11T08:00:00.000Z"),
        report("2026-10-11T09:30:00.000Z", 100, 40, {}),
        report("2026-10-11T10:30:00.000Z", 100, 40, {}),
      ],
    });

    expect((await usage(dir)).stdout.split("\n").slice(-3)).toStrictEqual([
      "  floors, first hour → last hour:",
      "    no report in the first hour",
      "",
    ]);
  });

  it("says so when the log has no usage records", async () => {
    const dir = await logsWith({ "host.1.jsonl": [listening("2026-10-11T08:00:00.000Z")] });

    expect(await usage(dir)).toStrictEqual({
      stdout: `no usage records in ${dir}\n`,
      stderr: "",
      code: 0,
    });
  });
});
