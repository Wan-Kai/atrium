import { type Page, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";

/**
 * Pastes a small PNG into the input box, as a screenshot from the clipboard would come.
 *
 * @remarks
 * The paste event is made in the page, so the real clipboard is never touched (security.md).
 *
 * @sideEffects Dispatches a paste event in the page.
 * @param window - The app's page.
 */
async function pasteScreenshot(window: Page): Promise<void> {
  await window.getByRole("textbox", { name: "消息" }).evaluate(async (box) => {
    const canvas = new OffscreenCanvas(40, 30);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d context");
    context.fillStyle = "#5e84ff";
    context.fillRect(0, 0, 40, 30);
    const data = new DataTransfer();
    data.items.add(new File([await canvas.convertToBlob({ type: "image/png" })], "shot.png", { type: "image/png" }));
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
}

/**
 * Opens the sent screenshot, checks its full pixels and zoom, then returns focus to its thumbnail.
 *
 * @remarks The same path exercises retained previews and images reloaded from pi after restart.
 * @sideEffects Opens and closes the real image modal.
 * @param window - The app's page.
 */
async function previewScreenshot(window: Page): Promise<void> {
  await window.getByTestId("message-images").getByRole("img", { name: "图片 1" }).click();
  const preview = window.getByRole("dialog", { name: "图片预览" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("40 × 30");
  await expect(preview.getByRole("img", { name: "图片 1" })).toHaveJSProperty("naturalWidth", 40);
  await expect(preview.getByLabel("缩放比例")).toHaveText("100%");
  await preview.getByRole("button", { name: "放大", exact: true }).click();
  await expect(preview.getByLabel("缩放比例")).toHaveText("125%");
  await window.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(window.getByRole("button", { name: "放大图片：图片 1" })).toBeFocused();
}

test("opens a sent message's image preview, and again from pi's session file after a restart", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "一张蓝色的图" }] }] });
  let launched = await launchApp(pi.env);
  const home = launched.home;
  try {
    let { window } = launched;
    await pasteScreenshot(window);
    await window.getByRole("textbox", { name: "消息" }).fill("图里有什么");
    await window.getByRole("button", { name: "发送" }).click({ timeout: 30_000 });

    const reply = window.locator('[data-testid="reply"][data-streaming="false"]');
    await expect(reply).toHaveText("一张蓝色的图", { timeout: 30_000 });
    const thumbnail = window.getByTestId("message-images").getByRole("img", { name: "图片 1" });
    await expect(thumbnail).toHaveAttribute("src", /^data:image\/(png|jpeg|webp);base64,/);
    await previewScreenshot(window);
    await launched.quit();

    // A new page has no previews, so the thumbnail is the host's, read from pi's session file.
    launched = await launchApp(pi.env, home);
    window = launched.window;
    await expect(window.getByTestId("user-message")).toHaveCount(1, { timeout: 30_000 });
    await expect(window.getByTestId("message-images").getByRole("img", { name: "图片 1" })).toHaveAttribute(
      "src",
      /^data:image\/(png|jpeg|webp);base64,/,
      { timeout: 30_000 },
    );
    await expect(window.getByRole("img", { name: "图片不可用" })).toHaveCount(0);
    await previewScreenshot(window);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("@leak repeatedly opening sent image previews releases modal DOM", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "收到图片" }] }] });
  const launched = await launchApp(pi.env);
  const dir = await mkdtemp(join(tmpdir(), "atrium-sent-image-heap-"));
  try {
    const { window } = launched;
    await pasteScreenshot(window);
    await window.getByRole("textbox", { name: "消息" }).fill("预览图片");
    await window.getByRole("button", { name: "发送" }).click({ timeout: 30_000 });
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText("收到图片", {
      timeout: 30_000,
    });
    await previewScreenshot(window);
    await takeHeapSnapshot(window, join(dir, "baseline.heapsnapshot"));
    for (let round = 0; round < 20; round += 1) await previewScreenshot(window);
    await takeHeapSnapshot(window, join(dir, "final.heapsnapshot"));
    expect(
      await findDetachedDomLeaks(join(dir, "baseline.heapsnapshot"), join(dir, "final.heapsnapshot")),
    ).toStrictEqual([]);
  } finally {
    await launched.close();
    await pi.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
