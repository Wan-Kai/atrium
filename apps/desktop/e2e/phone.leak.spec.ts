import { expect, type Page, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";

/**
 * Visits the phone page twice through the real settings window, then closes it.
 *
 * @remarks
 * Switching categories exercises content unmounts separately from the window-owned remote watch.
 * Remote access stays disabled in the isolated home; no relay credentials or keychain access are needed.
 *
 * @sideEffects Clicks settings controls and waits for authoritative remote state to render.
 * @param page - The isolated Electron renderer.
 * @returns When settings and phone content have unmounted.
 */
async function cyclePhoneSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "手机", exact: true }).click();
  const phone = settings.getByRole("region", { name: "手机设置", exact: true });
  await expect(phone.getByRole("heading", { name: "接上你的 relay", exact: true })).toBeVisible();

  await settings.getByRole("button", { name: "关于", exact: true }).click();
  await expect(phone).toHaveCount(0);
  await expect(settings.getByRole("heading", { name: "关于", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "手机", exact: true }).click();
  await expect(phone.getByRole("heading", { name: "接上你的 relay", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(settings).toHaveCount(0);
}

test("@leak opening phone settings and switching categories releases detached DOM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atrium-phone-heap-"));
  try {
    const launched = await launchApp();
    try {
      for (let cycle = 0; cycle < 2; cycle++) await cyclePhoneSettings(launched.window);
      const baseline = join(directory, "baseline.heapsnapshot");
      const final = join(directory, "final.heapsnapshot");
      await takeHeapSnapshot(launched.window, baseline);
      for (let cycle = 0; cycle < 20; cycle++) await cyclePhoneSettings(launched.window);
      await takeHeapSnapshot(launched.window, final);
      expect(await findDetachedDomLeaks(baseline, final)).toStrictEqual([]);
    } finally {
      await launched.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
