import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";

test("@leak switching translated replies releases their DOM and ephemeral state", async () => {
  test.setTimeout(120_000);
  const pi = await fauxPiEnvironment({
    replies: [{ blocks: [{ type: "text", text: "Only this reply is translated." }] }],
    title: "Translation example",
    translation: "只翻译这条回复。",
  });
  const launched = await launchApp(pi.env);
  const directory = await mkdtemp(join(tmpdir(), "atrium-translation-heap-"));
  try {
    const { window } = launched;
    const tabs = window.getByRole("tab");
    const box = window.getByRole("textbox", { name: "消息", exact: true });
    await box.fill("First example");
    await window.getByRole("button", { name: "发送", exact: true }).click();
    await expect(window.getByRole("button", { name: "翻译回复", exact: true })).toBeVisible({ timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    await expect(tabs).toHaveCount(2);
    await box.fill("Second example");
    await window.getByRole("button", { name: "发送", exact: true }).click();
    await expect(window.getByRole("button", { name: "翻译回复", exact: true })).toBeVisible({ timeout: 30_000 });
    /** Translates a newly mounted reply and removes its visible result with a real tab switch.
     * @remarks Each iteration must reach translated content before testing its teardown.
     * @sideEffects Switches tabs and starts a real standalone pi with a faux model.
     */
    async function cycle(): Promise<void> {
      await tabs.nth(0).click();
      await expect(window.getByTestId("reply-translation")).toHaveCount(0);
      await window.getByRole("button", { name: "翻译回复", exact: true }).click();
      await expect(window.getByTestId("reply-translation")).toContainText("只翻译这条回复。", { timeout: 30_000 });
      await tabs.nth(1).click();
      await expect(window.getByTestId("reply-translation")).toHaveCount(0);
    }
    await cycle();
    await takeHeapSnapshot(window, join(directory, "baseline.heapsnapshot"));
    for (let round = 0; round < 10; round += 1) await cycle();
    await takeHeapSnapshot(window, join(directory, "final.heapsnapshot"));
    expect(
      await findDetachedDomLeaks(join(directory, "baseline.heapsnapshot"), join(directory, "final.heapsnapshot")),
    ).toStrictEqual([]);
  } finally {
    await launched.close();
    await pi.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
