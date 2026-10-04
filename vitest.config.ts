import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const packages = "packages/*/{src,test}/**";

/**
 * Test layers from docs/architecture/testing.md, one Vitest project each.
 *
 * @remarks
 * The file suffix decides the layer, so a test cannot run in the wrong environment by accident.
 */
export default defineConfig({
  test: {
    globalSetup: ["./test-temp-root.ts"],
    projects: [
      {
        test: {
          name: "unit",
          include: [`${packages}/*.test.ts`],
          exclude: [`${packages}/*.{pi,host,leak,soak,browser}.test.ts`],
          benchmark: { include: [`${packages}/*.bench.ts`] },
        },
      },
      { test: { name: "pi", include: [`${packages}/*.pi.test.ts`], benchmark: { include: [] }, testTimeout: 30_000 } },
      {
        test: {
          name: "host",
          include: [`${packages}/*.host.test.ts`],
          benchmark: { include: [] },
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "leak",
          benchmark: { include: [] },
          include: [`${packages}/*.leak.test.ts`],
          pool: "forks",
          execArgv: ["--expose-gc"],
          fileParallelism: false,
          testTimeout: 120_000,
        },
      },
      {
        test: {
          name: "soak",
          benchmark: { include: [] },
          include: [`${packages}/*.soak.test.ts`],
          pool: "forks",
          execArgv: ["--expose-gc"],
          fileParallelism: false,
        },
      },
      {
        root: "./packages/ui",
        plugins: [react()],
        test: {
          name: "ui",
          include: ["src/**/*.browser.test.{ts,tsx}"],
          benchmark: { include: [] },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
