import { createGitScene } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { addProject } from "./projects";

test("counts a workspace's git changes above the input box and shows them file by file in the panel", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "好的" }] }] });
  const scene = await createGitScene("e2e-changes");
  const repo = await realpath(scene.repo);
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, repo);
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("一");
    await box.press("Enter");
    await expect(window.getByTestId("reply")).toHaveText("好的", { timeout: 30_000 });
    const capsule = window.getByRole("button", { name: "查看改动" });
    await expect(capsule).toHaveCount(0);

    await writeFile(join(repo, "README.md"), "start\nmore\n");
    await writeFile(join(repo, "new.txt"), "a\nb\n");

    await expect(capsule).toHaveText("+3−0", { timeout: 30_000 });
    await capsule.click();
    const panel = window.getByRole("complementary", { name: "改动" });
    await expect(panel.getByRole("list", { name: "改动的文件" }).getByRole("button")).toHaveText(
      ["README.md+1−0", "new.txt+2−0"],
      { timeout: 30_000 },
    );
    await expect(panel.getByRole("region", { name: "new.txt" })).toContainText("2b");

    await panel.getByRole("button", { name: "比较" }).click();
    await window.getByRole("menuitemradio", { name: /已提交/ }).click();
    await expect(panel.getByText("没有改动")).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: "看未提交的改动" }).click();
    await expect(panel.getByRole("region", { name: "README.md" })).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: "关闭改动" }).click();
    await expect(panel).toHaveCount(0);
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
