/**
 * Mutation testing for the core modules (testing.md, "让每个测试都有效").
 *
 * @remarks
 * A mutant that survives means no test noticed a deliberate bug. The run fails below an 80%
 * score. Incremental mode reuses earlier results for unchanged code; `pnpm test:mutation --force`
 * re-runs everything, which each milestone requires before it is done. Every mutant runs the
 * whole Node suite, because the command runner has no per-test coverage.
 */
export default {
  // The command runner activates each mutant through the `__STRYKER_ACTIVE_MUTANT__` variable.
  // Stryker's Vitest plugin activates mutants through Vitest's provide/inject, which no longer
  // reaches the test files in Vitest 5, so every mutant would wrongly "survive".
  testRunner: "command",
  commandRunner: { command: "node node_modules/vitest/vitest.mjs run --config vitest.mutation.config.ts --bail=1" },
  mutate: [
    "packages/protocol/src/**/*.ts",
    "packages/client/src/**/*.ts",
    "packages/host/src/platform/{redact,resources,clock}.ts",
    "packages/host/src/server/*.ts",
    "packages/pi/src/locate/version.ts",
    "packages/pi/src/process/jsonl.ts",
    "packages/testkit/src/clock.ts",
    "!**/*.test.ts",
    "!**/*.bench.ts",
    "!**/*.d.ts",
    "!**/index.ts",
  ],
  coverageAnalysis: "off",
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  thresholds: { high: 90, low: 80, break: 80 },
  tempDirName: ".stryker-tmp",
  // Stryker rewrites tsconfig paths in its sandbox through the TypeScript JS API, which TypeScript 7
  // no longer ships. The sandbox keeps the repository layout, so relative `extends` stay valid and
  // the rewrite can be skipped by pointing Stryker at a file that does not exist.
  tsconfigFile: "tsconfig.stryker-skip.json",
  cleanTempDir: "always",
};
