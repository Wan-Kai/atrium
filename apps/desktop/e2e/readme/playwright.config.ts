import { defineConfig } from "@playwright/test";

/**
 * Takes the README's screenshots (`pnpm readme:shots`) by driving the built app through a demo.
 *
 * @remarks
 * A config of its own, so `pnpm test:e2e` never picks the run up: it is no test, it takes minutes,
 * and it captures the window on screen. One story takes every image, so one long timeout; no
 * trace or screenshots of its own, since the images are the output.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.shots\.ts$/,
  timeout: 15 * 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "off" },
});
