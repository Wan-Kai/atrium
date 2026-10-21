import { createGitScene } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { addProject } from "./projects";

/** Synthetic source, including exact integers and duplicate properties which must not disappear. */
const JSON_SOURCE = '{"requestId":9223372036854775807,"service":"profile-api","retry":{"count":3},"id":1,"id":2}';
const CSV_SOURCE = 'endpoint,note\n/profile,"normal, cached"\n/settings,"two\nlines"';
const REPLY = [
  "配置在 `src/auth.ts:195-198`。",
  "",
  "```json",
  JSON_SOURCE,
  "```",
  "",
  "```csv",
  CSV_SOURCE,
  "```",
].join("\n");

/** Checks real row geometry against the viewer's own scrolling viewport.
 * @remarks A synthetic pixel estimate would miss content-visibility and wrapped-line errors.
 * @sideEffects none
 * @param element - The target text row.
 * @returns Whether the row is completely inside its viewer.
 */
function rowInView(element: Element): boolean {
  const viewport = element.closest('[data-testid="viewer-body"]');
  if (viewport === null) throw new Error("missing viewer");
  const row = element.getBoundingClientRect();
  const bounds = viewport.getBoundingClientRect();
  return row.top >= bounds.top && row.bottom <= bounds.bottom;
}

test("keeps JSON source-first, CSV table-first and navigates reply references in a real file tab", async ({
  browserName: _browserName,
}, info) => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: REPLY }] }] });
  const scene = await createGitScene("e2e-reply-data");
  const repo = await realpath(scene.repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src/auth.ts"),
    Array.from({ length: 260 }, (_item, index) => `export const line${index + 1} = ${index + 1};`).join("\n"),
  );
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, repo);
    await window.getByTestId("workspace-row").click({ timeout: 30000 });
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("数据定位");
    await box.press("Enter");
    const reply = window.locator('[data-testid="reply"][data-streaming="false"]');
    await expect(reply).toContainText("requestId", { timeout: 30000 });
    const blocks = reply.locator(".atrium-reply-data");
    await expect(blocks).toHaveCount(2);
    const json = blocks.nth(0);
    const csv = blocks.nth(1);
    await expect(json.locator("details")).toHaveCount(0);
    await expect(json).toContainText("9223372036854775807");
    await expect(csv.getByRole("table")).toBeVisible();
    await expect(csv.getByRole("cell", { name: "normal, cached", exact: true })).toBeVisible();
    await expect(csv.getByRole("cell", { name: "two lines", exact: true })).toBeVisible();
    await window.screenshot({ path: info.outputPath("reply-data-default-light.png") });
    await json.getByRole("button", { name: "查看数据", exact: true }).click();
    await expect(json.locator(".atrium-reply-data-tree")).toContainText("9223372036854775807");
    await expect(json.locator(".atrium-reply-data-tree")).toContainText('"id": 1');
    await expect(json.locator(".atrium-reply-data-tree")).toContainText('"id": 2');
    await window.screenshot({ path: info.outputPath("reply-data-light.png") });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await expect.poll(() => window.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    await window.screenshot({ path: info.outputPath("reply-data-dark.png") });
    const link = reply.getByRole("button", { name: "src/auth.ts:195-198", exact: true });
    await link.click();
    const viewer = window.getByRole("region", { name: "src/auth.ts", exact: true });
    await expect(viewer.getByRole("status")).toHaveText("第 195–198 行");
    await expect(viewer.locator('[data-line-target="true"]')).toHaveCount(4);
    const row = viewer.locator('[data-line-number="195"]');
    await expect.poll(() => row.evaluate(rowInView)).toBe(true);
    await window.screenshot({ path: info.outputPath("reply-file-target.png") });
    await window.getByRole("tab", { name: "数据定位" }).click();
    await link.click();
    await expect(window.getByRole("tab", { name: "auth.ts" })).toHaveCount(1);
    await expect.poll(() => row.evaluate(rowInView)).toBe(true);
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
