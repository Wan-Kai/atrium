import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MUTATION_GROUPS } from "../mutation-groups.mjs";

const root = join(import.meta.dirname, "..");
const stryker = join(root, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js");

/**
 * Drops the survivors from a group's incremental results, so they run again.
 *
 * @remarks
 * The command runner reports no test files, so Stryker's incremental mode sees no test change and
 * would keep a survivor "survived" after a test was added for it (testing.md, "什么时候跑"). A
 * group never run has no file yet.
 *
 * @sideEffects Rewrites `reports/stryker-incremental-<group>.json`.
 * @param {string} group - The group's name.
 * @returns {Promise<number>} How many survivors were dropped.
 */
async function retrySurvivors(group) {
  const path = join(root, "reports", `stryker-incremental-${group}.json`);
  let report;
  try {
    report = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let dropped = 0;
  for (const file of Object.values(report.files)) {
    const kept = file.mutants.filter((mutant) => mutant.status !== "Survived");
    dropped += file.mutants.length - kept.length;
    file.mutants = kept;
  }
  await writeFile(path, JSON.stringify(report));
  return dropped;
}

/**
 * Runs one group's mutation test.
 *
 * @remarks
 * Stryker is started through `process.execPath`, never through `npx` or `.bin` shims
 * (overview.md, "宿主内部的依赖"); the group goes to `stryker.config.mjs` and
 * `vitest.mutation.config.ts` in `ATRIUM_MUTATION_GROUP`.
 *
 * @sideEffects Spawns Stryker, which inherits stdio; rewrites the group's incremental results.
 * @param {string} group - The group's name.
 * @param {readonly string[]} flags - Stryker's flags, such as `--force`.
 * @returns {Promise<number>} Stryker's exit code.
 */
async function runGroup(group, flags) {
  console.log(`\n=== mutation group ${group} ===`);
  if (!flags.includes("--force")) console.log(`retrying ${await retrySurvivors(group)} survivors`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [stryker, "run", ...flags], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ATRIUM_MUTATION_GROUP: group },
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 130)));
  });
}

/**
 * Runs the mutation test, group by group (testing.md, "每个变异只跑本组的测试").
 *
 * @remarks
 * `pnpm test:mutation [--force] [group…]`: every group unless some are named, each retrying its
 * survivors (`retrySurvivors`). A failing group does not stop the next; the run fails if any did.
 * An interrupt stops at once.
 *
 * @sideEffects Runs Stryker; sets the exit code.
 */
async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith("-"));
  const named = args.filter((arg) => !arg.startsWith("-"));
  const unknown = named.filter((name) => !Object.hasOwn(MUTATION_GROUPS, name));
  if (unknown.length > 0) {
    console.error(`no mutation group named ${unknown.join(", ")}; groups: ${Object.keys(MUTATION_GROUPS).join(", ")}`);
    process.exitCode = 2;
    return;
  }
  let failed = false;
  for (const group of named.length > 0 ? named : Object.keys(MUTATION_GROUPS)) {
    const code = await runGroup(group, flags);
    if (code === 130) {
      process.exitCode = 130;
      return;
    }
    failed ||= code !== 0;
  }
  process.exitCode = failed ? 1 : 0;
}

await main();
