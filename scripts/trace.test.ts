import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "trace.mjs");
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const OTHER = "00000000000000000000000000000001";

/** A log directory with the given files, each a list of records or raw lines. */
async function logsWith(files: Readonly<Record<string, readonly (object | string)[]>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atrium-trace-logs-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  for (const [name, lines] of Object.entries(files)) {
    const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
    await writeFile(join(dir, name), `${text}\n`);
  }
  return dir;
}

/** Runs `pnpm trace` and returns its output, or the failure's output and code. */
async function trace(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; code: number };
    return { stdout: failed.stdout, stderr: failed.stderr, code: failed.code };
  }
}

const span = (name: string, id: string, parent: string | undefined, start: string) => ({
  kind: "span",
  name,
  trace_id: TRACE,
  span_id: id,
  parent_span_id: parent,
  start,
  duration_ms: 12.34,
  status: "ok",
});

describe("pnpm trace", () => {
  it("prints the trace as a span tree across rotated files, skipping other traces and partial lines", async () => {
    const dir = await logsWith({
      "host.1.jsonl": [
        span("ws.connect", "a1", "c0ffee0000000000", "2026-10-06T00:00:00.000Z"),
        { level: "info", msg: "client connected", trace_id: TRACE, span_id: "a1", time: "2026-10-06T00:00:00.100Z" },
        { level: "info", msg: "someone else", trace_id: OTHER, span_id: "zz", time: "2026-10-06T00:00:00.200Z" },
      ],
      "host.2.jsonl": [
        span("pi.rpc prompt", "b2", "a1", "2026-10-06T00:00:01.000Z"),
        { level: "warn", msg: "slow answer", trace_id: TRACE, span_id: "b2", time: "2026-10-06T00:00:01.500Z" },
        { level: "info", msg: "orphan log", trace_id: TRACE, span_id: "gone", time: "2026-10-06T00:00:02.000Z" },
        '{"level":"info","msg":"cut sh',
      ],
      "notes.txt": [{ trace_id: TRACE, msg: "not a log file" }],
    });

    expect(await trace(TRACE, dir)).toStrictEqual({
      stdout: [
        "ws.connect  12.3ms  ok",
        "  · [info] client connected",
        "  pi.rpc prompt  12.3ms  ok",
        "    · [warn] slow answer",
        "· [info] orphan log",
        "",
      ].join("\n"),
      stderr: "",
      code: 0,
    });
  });

  it("says so when the trace has no records", async () => {
    const dir = await logsWith({ "host.1.jsonl": [] });

    expect(await trace(TRACE, dir)).toStrictEqual({
      stdout: `no records for trace ${TRACE} in ${dir}\n`,
      stderr: "",
      code: 0,
    });
  });

  it("refuses an id that is not a trace id", async () => {
    expect(await trace("not-a-trace")).toStrictEqual({
      stdout: "",
      stderr: "usage: pnpm trace <32-hex trace id> [logs dir]\n",
      code: 1,
    });
  });
});
