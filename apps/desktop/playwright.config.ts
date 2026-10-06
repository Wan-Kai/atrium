import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests drive the real Electron app (testing.md, layer 6).
 *
 * @remarks
 * One worker, because every test launches its own app with its own host and home directory and
 * performance budgets need a quiet machine.
 */
export default defineConfig({
  testDir: "./e2e",
  // Every temporary directory of the run lives under one root that is deleted at the end.
  globalSetup: "../../test-temp-root.ts",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
