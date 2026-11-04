import { createGitScene } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { addProject } from "./projects";

test("previews a Markdown file, follows document-relative links and returns to its remembered preview", async ({
  browserName: _browserName,
}, info) => {
  const pi = await fauxPiEnvironment({ replies: [] });
  const scene = await createGitScene("e2e-markdown");
  const repo = await realpath(scene.repo);
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, "docs", "empty.md"), "");
  await writeFile(join(repo, "docs", "guide.md"), "# 开发指南\n\n文件预览保持只读。\n第四行\n");
  await writeFile(
    join(repo, "docs", "pixel.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA8J8BAAf/Af8Bf4mnAAAAAElFTkSuQmCC",
      "base64",
    ),
  );
  await writeFile(
    join(repo, "docs", "README.md"),
    "# Markdown 文件预览\n\n在同一个标签中，阅读文档或查看源码。**文件始终只读。**\n\n## 开始开发\n\n```sh\npnpm dev\n```\n\n| 操作 | 结果 |\n| --- | --- |\n| 预览 | 阅读排版后的文档 |\n| 查看源码 | 回到带行号的原文 |\n\n[开发指南](guide.md#L3-L4) · [空文档](empty.md) · [缺失文件](missing.md)\n\n![本地示例](pixel.png)\n\n<script>throw new Error('must not run')</script>\n",
  );
  const launched = await launchApp(pi.env);
  try {
    const { app, window } = launched;
    await addProject(app, window, repo);
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    await window.keyboard.press("Meta+Alt+b");
    const panel = window.getByRole("complementary", { name: "文件与更改" });
    await panel.getByRole("tab", { name: "文件" }).click();
    const tree = panel.getByTestId("files-tree");
    await tree.getByRole("button", { name: "docs", exact: true }).click();
    // Wait for the directory's children: before they arrive, only the root README exists.
    const readmes = tree.getByRole("button", { name: "README.md", exact: true });
    await expect(readmes).toHaveCount(2);
    const doc = readmes.first();
    await doc.dblclick();
    const file = window.getByRole("region", { name: "docs/README.md", exact: true });
    await expect(file.getByTestId("code-lines")).toBeVisible();
    const toggle = file.getByRole("button", { name: "预览", exact: true });
    await toggle.focus();
    await window.keyboard.press("Enter");
    await expect(file.getByRole("heading", { name: "Markdown 文件预览", exact: true })).toBeVisible();
    await expect(file.getByRole("table")).toBeVisible();
    await expect(file.getByRole("img", { name: "本地示例", exact: true })).toBeVisible();
    await expect(file.locator("script")).toHaveCount(0);
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await expect(window.locator("html")).not.toHaveClass(/dark/u);
    await window.screenshot({ path: info.outputPath("markdown-light.png") });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await expect(window.locator("html")).toHaveClass(/dark/u);
    await window.screenshot({ path: info.outputPath("markdown-dark.png") });
    await file.getByRole("button", { name: "开发指南", exact: true }).click();
    const guide = window.getByRole("region", { name: "docs/guide.md", exact: true });
    await expect(guide.getByRole("status")).toHaveText("第 3–4 行");
    await expect(guide.locator('[data-line-target="true"]')).toHaveCount(2);
    await window.getByRole("tab", { name: /^README\.md /u }).click();
    await expect(file.getByRole("button", { name: "查看源码", exact: true })).toBeVisible();
    await file.getByRole("button", { name: "查看源码", exact: true }).click();
    await expect(file.getByTestId("code-lines")).toBeVisible();
    await expect(file.getByTestId("markdown-preview")).toHaveCount(0);
    await file.getByRole("button", { name: "预览", exact: true }).click();
    await file.getByRole("button", { name: "空文档", exact: true }).click();
    const empty = window.getByRole("region", { name: "docs/empty.md", exact: true });
    await empty.getByRole("button", { name: "预览", exact: true }).click();
    await expect(empty.getByTestId("markdown-preview")).toHaveText("");
    await empty.screenshot({ path: info.outputPath("markdown-empty.png") });
    await window.getByRole("tab", { name: /^README\.md /u }).click();
    await file.getByRole("button", { name: "缺失文件", exact: true }).click();
    const missing = window.getByRole("region", { name: "docs/missing.md", exact: true });
    await expect(missing).toContainText("文件已经不在了");
    await expect(missing.getByRole("button", { name: "预览", exact: true })).toHaveCount(0);
    await missing.screenshot({ path: info.outputPath("markdown-missing.png") });
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
