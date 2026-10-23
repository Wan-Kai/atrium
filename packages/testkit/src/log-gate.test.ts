import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { findLogProblems, readLogRecords } from "./log-gate";
import { createTempDir } from "./temp-dir";

/** A log record as the host writes it, with fields the gate must not print. */
const record = (level: string, msg: string, extra: Record<string, unknown> = {}) => ({
  level,
  time: "2026-10-23T09:00:00.000Z",
  service: "host",
  cwd: "/Users/someone/secret-project",
  msg,
  ...extra,
});

describe("findLogProblems", () => {
  it("passes a log with only records below warn", () => {
    const log = [record("info", "host listening"), record("debug", "pi started"), record("trace", "span")];

    expect(findLogProblems(log, [])).toStrictEqual([]);
  });

  it("reports warn, error and fatal records nobody declared, by level, msg, the error's type and code, and count", () => {
    const log = [
      record("warn", "pi did not start", { err: { type: "Error", code: "ENOENT", message: "spawn /x ENOENT" } }),
      record("warn", "pi did not start", { err: { type: "Error", code: "ENOENT", message: "spawn /y ENOENT" } }),
      record("error", "unhandled rejection", { err: { type: "TypeError", message: "boom", stack: "at /x" } }),
      record("fatal", "host failed to start"),
      record("info", "host listening"),
    ];

    expect(findLogProblems(log, [])).toStrictEqual([
      'unexpected warn "pi did not start" (Error ENOENT) × 2',
      'unexpected error "unhandled rejection" (TypeError) × 1',
      'unexpected fatal "host failed to start" × 1',
    ]);
  });

  it("leaves the UI's reports of long tasks and slow frames out, but not the errors it reports", () => {
    const log = [
      record("warn", "client issue", { kind: "long_task", issue: "long task 52 ms" }),
      record("warn", "client issue", { kind: "slow_frames", issue: "slow frames" }),
      record("warn", "client issue", { kind: "error", issue: "Minified React error #185" }),
    ];

    expect(findLogProblems(log, [])).toStrictEqual(['unexpected warn "client issue" × 1']);
  });

  it("lets declared records through, matching level and msg exactly", () => {
    const log = [
      record("warn", "pi did not start"),
      record("warn", "pi did not start"),
      record("error", "pi did not start"),
      record("warn", "pi did not start!"),
    ];

    expect(findLogProblems(log, [{ level: "warn", msg: "pi did not start" }])).toStrictEqual([
      'unexpected error "pi did not start" × 1',
      'unexpected warn "pi did not start!" × 1',
    ]);
  });

  it("requires a declared record at least once, or exactly as many times as declared", () => {
    const log = [record("warn", "seen twice"), record("warn", "seen twice"), record("error", "seen once")];

    expect(
      findLogProblems(log, [
        { level: "warn", msg: "seen twice", times: 2 },
        { level: "error", msg: "seen once", times: 2 },
        { level: "warn", msg: "never seen" },
        { level: "error", msg: "never seen either", times: 1 },
      ]),
    ).toStrictEqual([
      'expected error "seen once" 2 times, saw 1',
      'expected warn "never seen" at least once, saw 0',
      'expected error "never seen either" 1 time, saw 0',
    ]);
  });

  it("matches a declaration's fields exactly, and leaves records with other values unexpected", () => {
    const log = [
      record("warn", "one-shot pi failed", { reason: "model_failed" }),
      record("warn", "one-shot pi failed", { reason: "exited" }),
      record("warn", "one-shot pi failed"),
    ];

    expect(
      findLogProblems(log, [
        { level: "warn", msg: "one-shot pi failed", fields: { reason: "model_failed" }, times: 1 },
      ]),
    ).toStrictEqual(['unexpected warn "one-shot pi failed" × 2']);
  });

  it("tells declarations of the same record with different fields apart", () => {
    const log = [record("warn", "x", { reason: "a" }), record("warn", "x", { reason: "b" })];

    expect(
      findLogProblems(log, [
        { level: "warn", msg: "x", fields: { reason: "a" }, times: 1 },
        { level: "warn", msg: "x", fields: { reason: "b" }, times: 2 },
      ]),
    ).toStrictEqual(['expected warn "x" {"reason":"b"} 2 times, saw 1']);
  });

  it("lets an optional record appear any number of times, none included", () => {
    const log = [record("warn", "raced"), record("warn", "raced"), record("warn", "raced")];

    expect(
      findLogProblems(log, [
        { level: "warn", msg: "raced", optional: true },
        { level: "error", msg: "never came", optional: true },
      ]),
    ).toStrictEqual([]);
  });

  it("adds up a declaration made more than once", () => {
    const log = [record("warn", "twice"), record("warn", "twice")];

    expect(
      findLogProblems(log, [
        { level: "warn", msg: "twice", times: 1 },
        { level: "warn", msg: "twice", times: 1 },
      ]),
    ).toStrictEqual([]);
  });
});

describe("readLogRecords", () => {
  it("reads every rotated host log file in number order, skipping partial lines and other files", async () => {
    const dir = await createTempDir("log-gate");
    onTestFinished(dir.cleanup);
    await writeFile(join(dir.path, "host.10.jsonl"), '{"msg":"third"}\n{"msg":"cut sh');
    await writeFile(join(dir.path, "host.2.jsonl"), '{"msg":"first"}\n\n{"msg":"second"}\n');
    await writeFile(join(dir.path, "current.log"), '{"msg":"a link to the current file"}\n');
    await writeFile(join(dir.path, "host.jsonl"), '{"msg":"not numbered"}\n');

    expect(await readLogRecords(dir.path)).toStrictEqual([{ msg: "first" }, { msg: "second" }, { msg: "third" }]);
    expect(await readLogRecords(join(dir.path, "missing"))).toStrictEqual([]);
  });
});
