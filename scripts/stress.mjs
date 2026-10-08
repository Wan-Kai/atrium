import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const root = join(import.meta.dirname, "..");

/**
 * Reads the command line.
 *
 * @remarks
 * `--copies` defaults to one per core but one, so every copy has a core: the point is to run tests
 * against each other, not to starve them (testing.md, "压力测试").
 *
 * @sideEffects none
 * @returns How many copies, how many rounds, the Vitest project and the test paths.
 */
function options() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      copies: { type: "string", default: String(Math.max(1, availableParallelism() - 1)) },
      rounds: { type: "string", default: "2" },
      project: { type: "string", default: "unit" },
    },
  });
  return {
    copies: Number(values.copies),
    rounds: Number(values.rounds),
    project: values.project,
    paths: positionals,
  };
}

/**
 * Runs one copy of the tests with a single worker and reads its report.
 *
 * @remarks
 * The JSON report holds every test's outcome and duration; the copy's own output is kept only
 * for a run that produced no report.
 *
 * @sideEffects Spawns Vitest; writes its report into `dir`.
 * @param dir - Where the report goes.
 * @param name - The copy's name, used for its report file.
 * @param project - The Vitest project.
 * @param paths - The test paths.
 * @returns The report, or the copy's output when there is none.
 */
function runCopy(dir, name, project, paths) {
  const report = join(dir, `${name}.json`);
  const args = [
    join(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--project",
    project,
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
    ...paths,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", () => {
      try {
        resolve({ name, report: JSON.parse(readFileSync(report, "utf8")) });
      } catch {
        resolve({ name, output });
      }
    });
  });
}

/**
 * Runs the tests many times at once, round after round, and summarizes what failed and what was slow.
 *
 * @remarks
 * A test that fails only sometimes is a bug (testing.md, "结果必须确定"); running copies side by side
 * shakes out races and timing assumptions. Each copy gets one worker, so all copies together use
 * about as many processes as there are cores; with Vitest's default of one worker per core, 13
 * copies ran some 170 test processes on 14 cores, and tests that start processes timed out from
 * starvation rather than from any fault (M1.4).
 *
 * @sideEffects Spawns the copies; writes reports to a temporary directory and removes it; prints
 * the summary; sets the exit code to 1 when any test failed or any copy produced no report.
 */
async function stress() {
  const { copies, rounds, project, paths } = options();
  const dir = mkdtempSync(join(tmpdir(), "atrium-stress-"));
  const failures = new Map();
  const durations = [];
  let runs = 0;
  let broken = 0;
  for (let round = 1; round <= rounds; round += 1) {
    const results = await Promise.all(
      Array.from({ length: copies }, (_, index) => runCopy(dir, `${round}-${index + 1}`, project, paths)),
    );
    for (const result of results) {
      runs += 1;
      if (result.report === undefined) {
        broken += 1;
        console.error(`copy ${result.name} produced no report:\n${result.output.slice(-2000)}`);
        continue;
      }
      for (const file of result.report.testResults) {
        for (const test of file.assertionResults) {
          durations.push({ name: test.fullName, ms: test.duration ?? 0 });
          if (test.status === "failed") {
            const known = failures.get(test.fullName) ?? { count: 0, message: test.failureMessages[0] ?? "" };
            failures.set(test.fullName, { ...known, count: known.count + 1 });
          }
        }
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`${runs} runs (${rounds} rounds of ${copies} copies, one worker each)`);
  for (const [name, { count, message }] of failures) {
    console.log(`FAILED ${count}/${runs}: ${name}\n  ${message.split("\n")[0]}`);
  }
  console.log("slowest:");
  for (const { name, ms } of durations.toSorted((a, b) => b.ms - a.ms).slice(0, 5)) {
    console.log(`  ${Math.round(ms)} ms  ${name}`);
  }
  if (failures.size > 0 || broken > 0) process.exitCode = 1;
}

await stress();
