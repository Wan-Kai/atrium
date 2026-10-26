import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Checks that new tests catch the bugs they are for: breaks the code as each case says, runs the
 * named test, and puts the code back.
 *
 * @remarks
 * testing.md ("每个测试先见过失败") and development.md ("标准开发流程"). A test that stays green
 * with the code broken guards nothing. Each case is `{ file, from, to, test, name, project? }`:
 * `from` must be in `file` exactly once; `test` is the test file and `name` the `-t` filter;
 * `project` is the Vitest project, `unit` unless given (`ui` for browser tests). A Swift case is
 * `{ file, from, to, runner: "swift", filter, package? }`: it runs `swift test --filter <filter>`
 * in `package` (default `apps/ios/AtriumKit`), and a break that no longer compiles is `NOBUILD`,
 * counted as missed, since it shows nothing about the tests (testing.md "Swift（手机端）"). Prints one
 * line per case, `CAUGHT` with the first failing test, `MISSED` or `NOBUILD` with the first compiler
 * error, and exits 1 when any was not caught. Vitest runs through `process.execPath` (overview.md,
 * "宿主内部的依赖"); `ATRIUM_BREAK_CHECK_RUNNER` and `ATRIUM_BREAK_CHECK_XCRUN` swap Vitest and
 * `xcrun` for stand-ins in this script's own test.
 */

/** The Vitest entry this script runs, or the stand-in its test gives. */
const runner =
  process.env["ATRIUM_BREAK_CHECK_RUNNER"] ?? join(import.meta.dirname, "..", "node_modules", "vitest", "vitest.mjs");

/** The Swift package a Swift case runs in unless it names one. */
const swiftPackage = join(import.meta.dirname, "..", "apps", "ios", "AtriumKit");

/** The file being broken and its text, put back if the run is interrupted. */
let broken = null;

/**
 * Puts the broken file back.
 *
 * @remarks
 * Also runs on an interrupt, so stopping the script never leaves a bug in the code.
 *
 * @sideEffects Writes the file back.
 */
function restore() {
  if (broken === null) return;
  writeFileSync(broken.file, broken.text);
  broken = null;
}

/**
 * Runs one case.
 *
 * @remarks
 * See the module comment.
 *
 * @sideEffects Writes the broken text, runs Vitest, writes the file back; prints a line.
 * @param {{ file: string, from: string, to: string, test?: string, name?: string, project?: string, runner?: string, filter?: string, package?: string }} item - The case.
 * @param {string} text - The file's text as it was.
 * @returns {boolean} Whether the test caught it.
 */
function runCase(item, text) {
  broken = { file: item.file, text };
  writeFileSync(item.file, text.replace(item.from, item.to));
  try {
    const label = `${basename(item.file)} | ${item.from.slice(0, 50).replaceAll("\n", " ")}`;
    const verdict = item.runner === "swift" ? runSwift(item) : runVitest(item);
    console.log(
      verdict.detail === undefined
        ? `${verdict.status} | ${label}`
        : `${verdict.status} | ${label} -> ${verdict.detail}`,
    );
    return verdict.status === "CAUGHT";
  } finally {
    restore();
  }
}

/**
 * Runs a TypeScript case's test with Vitest.
 *
 * @remarks
 * See the module comment.
 *
 * @sideEffects Runs Vitest.
 * @param {{ test: string, name: string, project?: string }} item - The case.
 * @returns {{ status: string, detail?: string }} `CAUGHT` with the first failing test, or `MISSED`.
 */
function runVitest(item) {
  const result = spawnSync(
    process.execPath,
    [runner, "run", "--project", item.project ?? "unit", item.test, "-t", item.name],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const failed = lines(result.stdout).find((line) => line.startsWith("×"));
  // Vitest ends a failed test's line with its time, which says nothing here.
  return failed === undefined ? { status: "MISSED" } : { status: "CAUGHT", detail: failed.replace(/\s+\d+ms$/u, "") };
}

/**
 * Runs a Swift case's tests with `swift test`.
 *
 * @remarks
 * Swift Testing prints `✘ Test "<name>" failed after …` for a failing test. A failure without such
 * a line, with a compiler error, means the break did not compile.
 *
 * @sideEffects Runs `swift test`, which builds the package.
 * @param {{ filter: string, package?: string }} item - The case.
 * @returns {{ status: string, detail?: string }} `CAUGHT`, `NOBUILD` with the first error, or `MISSED`.
 */
function runSwift(item) {
  const args = ["swift", "test", "--package-path", item.package ?? swiftPackage, "--filter", item.filter];
  const standIn = process.env["ATRIUM_BREAK_CHECK_XCRUN"];
  const [command, commandArgs] = standIn === undefined ? ["xcrun", args] : [process.execPath, [standIn, ...args]];
  const result = spawnSync(command, commandArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = lines(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const failed = output.find((line) => /^✘ Test ".*" (?:with \d+ test cases? )?failed/u.test(line));
  if (failed !== undefined) return { status: "CAUGHT", detail: failed.replace(/ after .*$/u, "") };
  const error = output.find((line) => /\berror: /u.test(line));
  if (result.status !== 0 && error !== undefined) return { status: "NOBUILD", detail: error };
  return { status: "MISSED" };
}

/**
 * Splits output into trimmed lines.
 *
 * @remarks
 * Both runners indent their result lines.
 *
 * @sideEffects none
 * @param {string} text - The output.
 * @returns {string[]} Its lines, trimmed.
 */
function lines(text) {
  return text.split("\n").map((line) => line.trim());
}

/**
 * Runs every case in the file given.
 *
 * @remarks
 * Every case is checked to apply before any is run, so a wrong case changes nothing.
 *
 * @sideEffects Reads the cases; runs them; sets the exit code (2 for a case that does not apply).
 */
function main() {
  /** @type {Array<{ file: string, from: string, to: string, test?: string, name?: string, project?: string, runner?: string, filter?: string, package?: string }>} */
  const cases = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
  const texts = cases.map((item) => readFileSync(item.file, "utf8"));
  const wrong = cases.find((item, index) => texts[index]?.split(item.from).length !== 2);
  if (wrong !== undefined) {
    console.log(`not exactly once in ${basename(wrong.file)}: ${wrong.from.slice(0, 50)}`);
    process.exitCode = 2;
    return;
  }
  const missed = cases.filter((item) => !runCase(item, readFileSync(item.file, "utf8"))).length;
  if (missed > 0) {
    console.log(`${missed} of ${cases.length} missed`);
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    restore();
    process.exit(130);
  });
}
main();
