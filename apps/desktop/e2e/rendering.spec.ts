import { createGitScene } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { addProject } from "./projects";

/** The synthetic reply exercises both renderers and the workspace's guarded file reader. */
const REPLY = [
  "## 请求流程",
  "",
  "```plantuml",
  "@startuml",
  "participant 用户",
  "participant 客户端",
  "participant 服务端",
  "用户 -> 客户端: 提交请求",
  "客户端 -> 服务端: 发送请求",
  "服务端 --> 客户端: 返回结果",
  "客户端 --> 用户: 展示结果",
  "@enduml",
  "```",
  "",
  "```mermaid",
  "graph LR",
  "A[界面] --> B[宿主]",
  "```",
  "",
  "[![布局预览](./preview.png)](https://example.com/preview)",
  "",
  "![越界图片](../outside.png)",
].join("\n");

/** Creates an entirely synthetic PNG inside the page for a readable preview.
 * @remarks No real project names, paths, screenshots or personal data enter the acceptance images.
 * @sideEffects Allocates a browser canvas.
 * @returns The PNG's base64 bytes.
 */
function exampleImage(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1000;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no canvas");
  context.fillStyle = "#f8fafc";
  context.fillRect(0, 0, 1600, 1000);
  context.fillStyle = "#e1e7ee";
  context.fillRect(0, 0, 270, 1000);
  context.fillStyle = "#1e293b";
  context.font = "36px sans-serif";
  context.fillText("请求记录", 340, 100);
  context.font = "22px sans-serif";
  context.fillText("示例工作台", 40, 70);
  context.fillStyle = "#ffffff";
  context.fillRect(340, 180, 1160, 600);
  context.fillStyle = "#475569";
  context.font = "24px monospace";
  for (let row = 0; row < 5; row += 1)
    context.fillText(`GET /api/example-${row + 1}                         200`, 380, 260 + row * 100);
  return canvas.toDataURL("image/png").split(",")[1] ?? "";
}

/** Detects accidental remote renderer requests.
 * @remarks The page may load only local app/worker assets; diagrams never use a server.
 * @sideEffects none
 * @param url - One page request.
 * @returns Whether it would leave the local application.
 */
function isExternal(url: string): boolean {
  return /^https?:/u.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost):/u.test(url);
}

test("renders local diagrams and workspace images under desktop CSP and returns from the fullscreen canvas", async ({
  browserName: _browserName,
}, info) => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: REPLY }] }] });
  const scene = await createGitScene("e2e-rendering");
  const repo = await realpath(scene.repo);
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    const requests: string[] = [];
    window.on("request", (request) => requests.push(request.url()));
    const pngData = await window.evaluate(exampleImage);
    await writeFile(join(repo, "preview.png"), Buffer.from(pngData, "base64"));
    await addProject(app, window, repo);
    await window.getByTestId("workspace-row").click({ timeout: 30000 });
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("展示图表和截图");
    await box.press("Enter");
    const reply = window.locator('[data-testid="reply"][data-streaming="false"]');
    const diagram = reply.locator('img[alt="PlantUML 图表"]');
    await expect(diagram).toBeVisible({ timeout: 30000 });
    await expect.poll(() => diagram.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    // Streamdown draws diagrams on intersection; the decoded image can push this block offscreen.
    await reply.locator(".atrium-mermaid:not(.atrium-plantuml)").scrollIntoViewIfNeeded();
    const mermaidNode = reply.locator('svg[id^="mermaid"] .node rect').first();
    await expect(mermaidNode).toBeVisible({ timeout: 30000 });
    const mermaid = reply.locator(".atrium-mermaid-controls");
    const ratio = mermaid.getByLabel("图表缩放比例");
    await expect(ratio).toHaveText(/^[1-9][0-9]*%$/u);
    const fitRatio = await ratio.innerText();
    const originalWidth = await mermaidNode.evaluate((node) => node.getBoundingClientRect().width);
    await mermaid.getByRole("button", { name: "拉近", exact: true }).click();
    await expect
      .poll(() => mermaidNode.evaluate((node) => node.getBoundingClientRect().width))
      .toBeGreaterThan(originalWidth + 1);
    await mermaid.getByRole("button", { name: "适应窗口", exact: true }).click();
    await expect(ratio).toHaveText(fitRatio);
    const picture = reply.locator('img[alt="布局预览"]');
    await expect.poll(() => picture.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1600);
    await expect(reply.locator("a button, button button")).toHaveCount(0);
    await expect(reply).toContainText("不能显示这张图片");
    await expect(reply.getByRole("img", { name: "越界图片" })).toHaveCount(0);
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await expect.poll(() => mermaidNode.evaluate((node) => getComputedStyle(node).fill)).toBe("rgb(255, 255, 255)");
    await diagram.scrollIntoViewIfNeeded();
    await expect.poll(() => diagram.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await window.screenshot({ path: info.outputPath("rendering-light.png") });
    await reply.getByRole("button", { name: "放大图片：布局预览" }).click();
    const preview = window.getByRole("dialog", { name: "图片预览" });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("1600 × 1000");
    await expect
      .poll(() => preview.locator(".atrium-image-preview-name").evaluate((node) => node.getBoundingClientRect().left))
      .toBeGreaterThanOrEqual(120);
    const before = Number.parseFloat(await preview.locator("output").innerText());
    await preview.getByRole("button", { name: "放大", exact: true }).click();
    await expect
      .poll(async () => Number.parseFloat(await preview.locator("output").innerText()))
      .toBeGreaterThan(before);
    await preview.getByRole("region", { name: "图片画布" }).click();
    await window.screenshot({ path: info.outputPath("fullscreen-canvas.png") });
    await window.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect(reply.getByRole("button", { name: "放大图片：布局预览" })).toBeFocused();
    await reply.getByRole("link", { name: "布局预览", exact: true }).scrollIntoViewIfNeeded();
    await window.screenshot({ path: info.outputPath("linked-image-light.png") });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await reply.locator(".atrium-mermaid:not(.atrium-plantuml)").scrollIntoViewIfNeeded();
    await expect.poll(() => mermaidNode.evaluate((node) => getComputedStyle(node).fill)).toBe("rgb(21, 21, 23)");
    await diagram.scrollIntoViewIfNeeded();
    await expect.poll(() => diagram.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await window.screenshot({ path: info.outputPath("rendering-dark.png") });
    expect(requests.filter(isExternal)).toStrictEqual([]);
    const logs = JSON.stringify(await launched.readHostLog());
    expect(logs).not.toContain("@startuml");
    expect(logs).not.toContain("preview.png");
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
