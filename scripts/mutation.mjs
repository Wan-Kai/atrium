import { spawn } from "node:child_process";
import { join } from "node:path";
import { MUTATION_GROUPS } from "../mutation-groups.mjs";

const root = join(import.meta.dirname, "..");
const stryker = join(root, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js");

/**
 * Runs one group's mutation test.
 *
 * @remarks
 * Stryker is started through `process.execPath`, never through `npx` or `.bin` shims
 * (overview.md, "宿主内部的依赖"); the group goes to `stryker.config.mjs` and
 * `vitest.mutation.config.ts` in `ATRIUM_MUTATION_GROUP`.
 *
 * @sideEffects Spawns Stryker, which inherits stdio.
 * @param {string} group - The group's name.
 * @param {readonly string[]} flags - Stryker's flags, such as `--force`.
 * @returns {Promise<number>} Stryker's exit code.
 */
function runGroup(group, flags) {
  return new Promise((resolve) => {
    console.log(`\n=== mutation group ${group} ===`);
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
 * `pnpm test:mutation [--force] [group…]`: every group unless some are named. A failing group
 * does not stop the next; the run fails if any did. An interrupt stops at once.
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
