import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "stress.mjs");

/** A test's result as Vitest's JSON report has it. */
const passed = { fullName: "adds", status: "passed", duration: 1, failureMessages: [] };

/**
 * A stand-in for Vitest that writes the report given and ends as told.
 *
 * @remarks
 * Writes `written` where `--outputFile=` says, then exits with `exit`, or kills itself with
 * `signal`, so the real Vitest never runs.
 *
 * @sideEffects Makes a temporary folder, removed when the test ends.
 * @param written - The JSON report, or `null` for none.
 * @param end - The exit code, or the signal it is killed with.
 * @returns The stand-in.
 */
async function standIn(written: unknown, end: { exit: number } | { signal: NodeJS.Signals }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atrium-stress-test-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const runner = join(dir, "runner.mjs");
  await writeFile(
    runner,
    [
      'import { writeFileSync } from "node:fs";',
      'const file = process.argv.find((arg) => arg.startsWith("--outputFile="))?.slice("--outputFile=".length);',
      `const report = ${JSON.stringify(written)};`,
      "if (report !== null) writeFileSync(file, JSON.stringify(report));",
      "exit" in end
        ? `process.exit(${String(end.exit)});`
        : `process.kill(process.pid, ${JSON.stringify(end.signal)});`,
    ].join("\n"),
  );
  return runner;
}

/**
 * A report of one file with the tests and file outcome given.
 *
 * @sideEffects none
 * @param tests - The file's tests.
 * @param file - The file's own status and error message, as Vitest gives them.
 * @param success - The report's overall outcome.
 * @returns The report.
 */
function report(tests: unknown[], file = { status: "passed", message: "" }, success = true) {
  return { numTotalTests: tests.length, success, testResults: [{ ...file, assertionResults: tests }] };
}

/**
 * Runs the script once, one copy, with the stand-in; never fails on its exit code.
 *
 * @sideEffects Runs the script, which runs the stand-in.
 * @param runner - The stand-in for Vitest.
 * @returns What it printed and its exit code.
 */
async function stress(runner: string) {
  return run(process.execPath, [script, "--copies", "1", "--rounds", "1", "some.test.ts"], {
    env: { ...process.env, ATRIUM_STRESS_RUNNER: runner },
  }).then(
    ({ stdout, stderr }) => ({ out: stdout + stderr, code: 0 }),
    (error: unknown) => ({
      out: String(Reflect.get(Object(error), "stdout")) + String(Reflect.get(Object(error), "stderr")),
      code: Number(Reflect.get(Object(error), "code")),
    }),
  );
}

describe("stress", () => {
  it("passes a copy whose tests all passed and which exited cleanly", async () => {
    const result = await stress(await standIn(report([passed]), { exit: 0 }));

    expect([result.code, result.out]).toStrictEqual([0, expect.stringContaining("1 runs (1 rounds of 1 copies")]);
    expect(result.out).not.toContain("copy 1-1");
  });

  it.each([
    ["exited with an error, as after an error outside the tests", true, 1, "exit 1"],
    ["reported the run failed, as when an afterAll throws", false, 0, "exit 0, run failed"],
  ])("fails a copy whose tests all passed but which %s", async (_case, success, exit, reason) => {
    const result = await stress(await standIn(report([passed], undefined, success), { exit }));

    expect([result.code, result.out]).toStrictEqual([
      1,
      expect.stringContaining(`copy 1-1 did not run cleanly: ${reason}`),
    ]);
  });

  it("fails a copy with a file that failed apart from its tests, as when it cannot be imported, even beside a failed test", async () => {
    const failed = { fullName: "subtracts", status: "failed", duration: 1, failureMessages: ["expected 1 to be 2"] };
    const result = await stress(
      await standIn(report([passed, failed], { status: "failed", message: "Cannot find module './gone'" }, false), {
        exit: 1,
      }),
    );

    expect([result.code, result.out]).toStrictEqual([
      1,
      expect.stringContaining("copy 1-1 did not run cleanly: a file failed: Cannot find module './gone'"),
    ]);
    expect(result.out).toContain("FAILED 1/1: subtracts");
  });

  it("fails a copy that was killed, though it wrote a report", async () => {
    const result = await stress(await standIn(report([passed]), { signal: "SIGKILL" }));

    expect([result.code, result.out]).toStrictEqual([
      1,
      expect.stringContaining("copy 1-1 did not run cleanly: killed by SIGKILL"),
    ]);
  });

  it("fails a copy that ran no tests", async () => {
    const result = await stress(await standIn(report([]), { exit: 0 }));

    expect([result.code, result.out]).toStrictEqual([
      1,
      expect.stringContaining("copy 1-1 did not run cleanly: no tests"),
    ]);
  });

  it("counts only failed tests, not the copy, when a test failed and that is all", async () => {
    const failed = { fullName: "subtracts", status: "failed", duration: 1, failureMessages: ["expected 1 to be 2"] };
    const result = await stress(
      await standIn(report([passed, failed], { status: "failed", message: "" }, false), { exit: 1 }),
    );

    expect([result.code, result.out]).toStrictEqual([1, expect.stringContaining("FAILED 1/1: subtracts")]);
    expect(result.out).not.toContain("did not run cleanly");
  });
});
