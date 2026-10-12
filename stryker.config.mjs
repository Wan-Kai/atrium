/**
 * Mutation testing for the core modules (testing.md, "让每个测试都有效").
 *
 * @remarks
 * A mutant that survives means no test noticed a deliberate bug. The run fails below an 80%
 * score. Incremental mode reuses earlier results for unchanged code; `pnpm test:mutation --force`
 * re-runs everything, as the nightly run does (testing.md, "什么时候跑"). Every mutant runs the
 * Node tests of its group (`mutation-groups.mjs`), because the command runner has no per-test
 * coverage; `pnpm test:mutation` runs the groups one after another, each with its own incremental
 * file.
 */
import { MUTATION_GROUPS } from "./mutation-groups.mjs";

// Without a group, as when a tool loads this file or Stryker runs alone, every file runs every test.
const name = process.env["ATRIUM_MUTATION_GROUP"] ?? "all";
const group = Object.entries(MUTATION_GROUPS).find(([key]) => key === name)?.[1] ?? {
  mutate: Object.values(MUTATION_GROUPS).flatMap((one) => one.mutate),
};

export default {
  // The command runner activates each mutant through the `__STRYKER_ACTIVE_MUTANT__` variable.
  // Stryker's Vitest plugin activates mutants through Vitest's provide/inject, which no longer
  // reaches the test files in Vitest 5, so every mutant would wrongly "survive".
  testRunner: "command",
  // Temporary files go inside the sandbox, which Stryker deletes: a mutant run killed on timeout
  // never reaches the tests' own cleanup (testing.md, "临时文件").
  commandRunner: {
    command:
      'mkdir -p .tmp && TMPDIR="$PWD/.tmp" node node_modules/vitest/vitest.mjs run --config vitest.mutation.config.ts --bail=1',
  },
  // Process-heavy tests (real child processes, signals) slow down sharply when many mutants run at
  // once; more parallelism turns that slowdown into timeouts that Stryker counts as detected.
  concurrency: 4,
  // Four suites at once can take far longer than the dry run, and a slow mutant judged a timeout
  // counts as caught: 4 of 5 sampled timeouts of M1.6's run passed every test. A mutant that truly
  // hangs a test still times out, a little later.
  timeoutMS: 30_000,
  mutate: [...group.mutate, "!**/*.test.ts", "!**/*.bench.ts", "!**/*.d.ts", "!**/index.ts"],
  coverageAnalysis: "off",
  incremental: true,
  incrementalFile: `reports/stryker-incremental-${name}.json`,
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: { fileName: `reports/mutation/${name}.html` },
  thresholds: { high: 90, low: 80, break: 80 },
  tempDirName: ".stryker-tmp",
  // The app `pnpm package` builds holds framework symlinks the sandbox copy cannot follow, and no
  // Node test uses it.
  ignorePatterns: ["apps/desktop/out"],
  // Stryker rewrites tsconfig paths in its sandbox through the TypeScript JS API, which TypeScript 7
  // no longer ships. The sandbox keeps the repository layout, so relative `extends` stay valid and
  // the rewrite can be skipped by pointing Stryker at a file that does not exist.
  tsconfigFile: "tsconfig.stryker-skip.json",
  cleanTempDir: "always",
};
