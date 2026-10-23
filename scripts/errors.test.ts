import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "errors.mjs");

/** A log directory with the given files, each a list of records or raw lines. */
async function logsWith(files: Readonly<Record<string, readonly (object | string)[]>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atrium-errors-logs-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  for (const [name, lines] of Object.entries(files)) {
    const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
    await writeFile(join(dir, name), `${text}\n`);
  }
  return dir;
}

/** Runs `pnpm errors` in UTC and returns its output, or the failure's output and code. */
async function errors(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
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

/** A record at some level, with extra fields. */
const at = (level: string, time: string, msg: string, extra: Record<string, unknown> = {}) => ({
  level,
  time,
  service: "host",
  msg,
  ...extra,
});

/** A problem the UI reported, as the host logs it. */
const issue = (time: string, kind: string, text: string) =>
  at("warn", time, "client issue", {
    client_id: "c1",
    kind,
    issue: text,
    details: "at x (atrium://app/assets/index-abc.js:1:2)",
  });

describe("pnpm errors", () => {
  it("groups warn, error and fatal records by signature across rotated files, with counts, times and runs", async () => {
    const dir = await logsWith({
      "host.2.jsonl": [
        listening("2026-10-22T10:00:00.000Z"),
        at("warn", "2026-10-22T10:05:00.000Z", "pi did not start", {
          cwd: "/Users/someone/gone",
          err: { type: "Error", code: "ENOENT", message: "spawn pi ENOENT", stack: "Error: at /x" },
        }),
        at("error", "2026-10-22T10:06:00.000Z", "unhandled rejection", { err: { type: "TypeError", message: "x" } }),
        '{"level":"warn","time":"2026-10-22T10:07',
      ],
      "host.1.jsonl": [
        listening("2026-10-21T08:00:00.000Z"),
        at("warn", "2026-10-21T08:30:00.000Z", "pi did not start", {
          err: { type: "Error", code: "ENOENT", message: "spawn pi ENOENT" },
        }),
        at("warn", "2026-10-21T08:31:00.000Z", "pi did not start", {
          err: { type: "Error", code: "EACCES", message: "spawn pi EACCES" },
        }),
        at("info", "2026-10-21T08:32:00.000Z", "pi started"),
        { ...at("fatal", "2026-10-21T08:33:00.000Z", "host crashed"), service: "desktop" },
      ],
      "current.log": [at("error", "2026-10-21T08:34:00.000Z", "not read: not a numbered file")],
    });

    const { stdout, code } = await errors(dir);

    expect(code).toBe(0);
    expect(stdout).toBe(
      [
        `4 signatures in ${dir} · 2 host runs · 2026-10-21 08:00 → 2026-10-22 10:06`,
        "new since 2026-10-22 10:00 (latest host start):",
        '  new  1×  error host "unhandled rejection" (TypeError) · first 10-22 10:06 · last 10-22 10:06 · 1 run',
        "earlier:",
        '       2×  warn host "pi did not start" (Error ENOENT) · first 10-21 08:30 · last 10-22 10:05 · 2 runs',
        '       1×  warn host "pi did not start" (Error EACCES) · first 10-21 08:31 · last 10-21 08:31 · 1 run',
        '       1×  fatal desktop "host crashed" · first 10-21 08:33 · last 10-21 08:33 · 1 run',
        "",
      ].join("\n"),
    );
  });

  it("puts the UI's reported problems in their signature, React's minified errors by number and the rest without paths, ids or numbers", async () => {
    const dir = await logsWith({
      "host.1.jsonl": [
        listening("2026-10-20T09:00:00.000Z"),
        issue(
          "2026-10-20T09:01:00.000Z",
          "error",
          "Uncaught Error: Minified React error #185; visit https://react.dev/errors/185 for the full message",
        ),
        issue(
          "2026-10-20T09:02:00.000Z",
          "error",
          "unhandled rejection: Minified React error #185; visit https://react.dev/errors/185?args[]=1",
        ),
        issue("2026-10-20T09:03:00.000Z", "error", "Minified React error #418; visit https://react.dev/errors/418"),
        issue("2026-10-20T09:04:00.000Z", "long_task", "long task 123 ms"),
        issue("2026-10-20T09:05:00.000Z", "long_task", "long task 87 ms"),
        issue(
          "2026-10-20T09:06:00.000Z",
          "error",
          "Cannot read /Users/someone/project/a.ts for session 5b2e9717-eb9b-43aa-818b-a86e5a78a119 at https://x.example/y",
        ),
        issue(
          "2026-10-20T09:07:00.000Z",
          "error",
          "Cannot read ~/other/b.ts for session 0f9a3c1d2e4b5a69 at https://z.example/w?q=1",
        ),
      ],
    });

    const { stdout } = await errors(dir, "--since", "2026-10-20T00:00:00.000Z");

    expect(stdout).toBe(
      [
        `4 signatures in ${dir} · 1 host run · 2026-10-20 09:00 → 2026-10-20 09:07`,
        "new since 2026-10-20 00:00 (--since):",
        '  new  2×  warn host "client issue" error: React #185 · first 10-20 09:01 · last 10-20 09:02 · 1 run',
        '  new  2×  warn host "client issue" long_task: long task <n> ms · first 10-20 09:04 · last 10-20 09:05 · 1 run',
        '  new  2×  warn host "client issue" error: Cannot read <path> for session <id> at <url> · first 10-20 09:06 · last 10-20 09:07 · 1 run',
        '  new  1×  warn host "client issue" error: React #418 · first 10-20 09:03 · last 10-20 09:03 · 1 run',
        "",
      ].join("\n"),
    );
  });

  it("marks only signatures first seen after the cutoff as new, whatever came before it", async () => {
    const dir = await logsWith({
      "host.1.jsonl": [
        listening("2026-10-21T08:00:00.000Z"),
        at("warn", "2026-10-21T08:10:00.000Z", "old and still here"),
        listening("2026-10-22T08:00:00.000Z"),
        at("warn", "2026-10-22T08:10:00.000Z", "only in the middle run"),
        listening("2026-10-23T08:00:00.000Z"),
        at("warn", "2026-10-23T08:10:00.000Z", "old and still here"),
        at("error", "2026-10-23T08:11:00.000Z", "brand new"),
      ],
    });

    const latest = await errors(dir);
    const since = await errors(dir, "--since", "2026-10-22T00:00:00.000Z");

    expect(latest.stdout.split("\n").slice(1, -1)).toStrictEqual([
      "new since 2026-10-23 08:00 (latest host start):",
      '  new  1×  error host "brand new" · first 10-23 08:11 · last 10-23 08:11 · 1 run',
      "earlier:",
      '       2×  warn host "old and still here" · first 10-21 08:10 · last 10-23 08:10 · 2 runs',
      '       1×  warn host "only in the middle run" · first 10-22 08:10 · last 10-22 08:10 · 1 run',
    ]);
    expect(since.stdout.split("\n").slice(1, -1)).toStrictEqual([
      "new since 2026-10-22 00:00 (--since):",
      '  new  1×  warn host "only in the middle run" · first 10-22 08:10 · last 10-22 08:10 · 1 run',
      '  new  1×  error host "brand new" · first 10-23 08:11 · last 10-23 08:11 · 1 run',
      "earlier:",
      '       2×  warn host "old and still here" · first 10-21 08:10 · last 10-23 08:10 · 2 runs',
    ]);
  });

  it("says so when there is nothing new, or nothing at all", async () => {
    const quiet = await logsWith({
      "host.1.jsonl": [
        at("warn", "2026-10-21T07:00:00.000Z", "before any start"),
        listening("2026-10-21T08:00:00.000Z"),
        at("info", "2026-10-21T08:01:00.000Z", "fine"),
      ],
    });
    const empty = await logsWith({ "host.1.jsonl": [listening("2026-10-21T08:00:00.000Z")] });
    const startless = await logsWith({ "host.3.jsonl": [at("error", "2026-10-21T07:00:00.000Z", "a failure")] });

    expect((await errors(quiet)).stdout.split("\n").slice(1, -1)).toStrictEqual([
      "new since 2026-10-21 08:00 (latest host start): none",
      "earlier:",
      '       1×  warn host "before any start" · first 10-21 07:00 · last 10-21 07:00 · 1 run',
    ]);
    expect((await errors(startless)).stdout).toBe(
      [
        `1 signature in ${startless} · 1 host run · 2026-10-21 07:00 → 2026-10-21 07:00`,
        "no host start in the log, nothing marked new; use --since",
        "earlier:",
        '       1×  error host "a failure" · first 10-21 07:00 · last 10-21 07:00 · 1 run',
        "",
      ].join("\n"),
    );
    expect(await errors(empty)).toStrictEqual({
      stdout: `no warn, error or fatal records in ${empty}\n`,
      stderr: "",
      code: 0,
    });
  });

  it("refuses a --since that is not a time, and changes nothing in the log directory", async () => {
    const dir = await logsWith({ "host.1.jsonl": [at("warn", "2026-10-21T07:00:00.000Z", "a warning")] });
    const before = await readFile(join(dir, "host.1.jsonl"), "utf8");

    const refused = await errors(dir, "--since", "yesterday");
    await errors(dir);

    expect(refused).toStrictEqual({ stdout: "", stderr: "--since needs an ISO time, got yesterday\n", code: 1 });
    expect(await errors(join(dir, "missing"))).toStrictEqual({
      stdout: "",
      stderr: `no log directory at ${join(dir, "missing")}\n`,
      code: 1,
    });
    expect(await readdir(dir)).toStrictEqual(["host.1.jsonl"]);
    expect(await readFile(join(dir, "host.1.jsonl"), "utf8")).toBe(before);
  });
});
