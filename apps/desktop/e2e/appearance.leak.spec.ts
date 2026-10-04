import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";

test("@leak switching the system appearance back and forth leaks no DOM", async () => {
  const launched = await launchApp();
  const dir = await mkdtemp(join(tmpdir(), "atrium-heap-"));
  const isDark = () => launched.window.evaluate(() => document.documentElement.classList.contains("dark"));
  const setTheme = async (source: "dark" | "light") => {
    await launched.app.evaluate(({ nativeTheme }, value) => {
      nativeTheme.themeSource = value;
    }, source);
    await expect.poll(isDark).toBe(source === "dark");
  };

  await setTheme("light");
  await takeHeapSnapshot(launched.window, join(dir, "baseline.heapsnapshot"));
  for (const source of Array.from({ length: 15 }).flatMap(() => ["dark", "light"] as const)) {
    await setTheme(source);
  }
  await takeHeapSnapshot(launched.window, join(dir, "final.heapsnapshot"));
  const leaks = await findDetachedDomLeaks(join(dir, "baseline.heapsnapshot"), join(dir, "final.heapsnapshot"));

  await launched.close();
  await rm(dir, { recursive: true, force: true });
  expect(leaks).toStrictEqual([]);
});
