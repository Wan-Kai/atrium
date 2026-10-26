import { type Page, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { send } from "./messages";

test("keeps top-layer menu actions marked no-drag when constrained into the native title strip", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "好的" }] }] });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    await expect(window.getByRole("button", { name: /^模型与推理强度/ })).toContainText("faux-1", { timeout: 30_000 });
    await send(window, "演示对话");
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["好的"], {
      timeout: 30_000,
    });
    await window.getByTestId("chat-row").hover();
    const trigger = window.getByRole("button", { name: "对话 演示对话", exact: true, includeHidden: true });
    await trigger.click();
    // Stress the actual menu's clamp without relying on a particular macOS window position.
    await trigger.evaluate((button) =>
      Object.assign(button.style, { position: "fixed", left: "500px", top: "0px", height: "0px" }),
    );
    const menu = window.getByRole("menu");
    await expect.poll(() => menu.evaluate((element) => element.getBoundingClientRect().top)).toBe(12);
    expect(await menu.evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-app-region"))).toBe(
      "no-drag",
    );
    await menu.getByRole("menuitem", { name: "重命名", exact: true }).click();
    await expect(window.getByRole("textbox", { name: "对话名称", exact: true })).toBeFocused();
    await window.keyboard.press("Escape");
    await trigger.evaluate((button) =>
      ["position", "left", "top", "height"].forEach((property) => button.style.removeProperty(property)),
    );
    for (const colorScheme of ["light", "dark"] as const) {
      await window.emulateMedia({ colorScheme });
      await window.getByTestId("chat-row").hover();
      await trigger.click();
      await window.screenshot({ path: test.info().outputPath(`menu-${colorScheme}.png`) });
      await window.keyboard.press("Escape");
    }
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

/**
 * Opens and closes two real floating surfaces repeatedly.
 * @remarks Exercises both a shared menu and the model panel, including their native popovers,
 * observers and window listeners, with a settled closed state before each heap snapshot.
 * @sideEffects Clicks the app's controls and dismisses their popovers.
 * @param window - The isolated app window.
 * @param rounds - How often to repeat the lifecycle.
 */
async function cyclePopups(window: Page, rounds: number): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await window.getByRole("button", { name: "添加", exact: true }).click();
    await expect(window.getByRole("menu")).toBeVisible();
    await window.getByRole("button", { name: "添加", exact: true }).click();
    await expect(window.getByRole("menu")).toHaveCount(0);
    await window.getByRole("button", { name: /^模型与推理强度/ }).click();
    await expect(window.getByRole("dialog", { name: "模型与推理强度" })).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByRole("dialog", { name: "模型与推理强度" })).toHaveCount(0);
  }
}

test("@leak opening and closing floating menus and model panels retains no detached DOM", async () => {
  const pi = await fauxPiEnvironment({ replies: [] });
  const launched = await launchApp(pi.env);
  const dir = await mkdtemp(join(tmpdir(), "atrium-popup-heap-"));
  try {
    const { window } = launched;
    await expect(window.getByRole("button", { name: /^模型与推理强度/ })).toContainText("faux-1", { timeout: 30_000 });
    await cyclePopups(window, 3);
    await takeHeapSnapshot(window, join(dir, "before.heapsnapshot"));
    await cyclePopups(window, 20);
    await takeHeapSnapshot(window, join(dir, "after.heapsnapshot"));
    expect(await findDetachedDomLeaks(join(dir, "before.heapsnapshot"), join(dir, "after.heapsnapshot"))).toStrictEqual(
      [],
    );
  } finally {
    await launched.close();
    await pi.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
