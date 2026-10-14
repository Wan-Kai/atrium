import { createGitScene } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { addProject } from "./projects";

test("counts a workspace's git changes above the input box, lists them in the right panel and shows them in viewer tabs", async () => {
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
    const panel = window.getByRole("complementary", { name: "文件与更改" });
    await expect(panel.getByRole("tab", { name: /更改/ })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByTestId("changes-tree").getByRole("button")).toHaveText(["README.md+1−0", "new.txt+2−0"], {
      timeout: 30_000,
    });
    await panel
      .getByTestId("changes-tree")
      .getByRole("button", { name: /new\.txt/ })
      .click();
    await expect(window.getByRole("region", { name: "改动" }).getByRole("region", { name: "new.txt" })).toContainText(
      "2b",
    );
    await expect(box).toHaveCount(0);

    await panel.getByRole("button", { name: "比较" }).click();
    await window.getByRole("menuitemradio", { name: /已提交/ }).click();
    await expect(panel.getByText("没有改动")).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: "看未提交的改动" }).click();
    await expect(window.getByRole("region", { name: "README.md" })).toBeVisible({ timeout: 30_000 });

    await panel.getByRole("tab", { name: "文件" }).click();
    const files = panel.getByTestId("files-tree").getByRole("button");
    await expect(files).toHaveText(["new.txt", "README.md"], { timeout: 30_000 });
    await files.filter({ hasText: "new.txt" }).click();
    await expect(window.getByRole("region", { name: "new.txt" })).toContainText("new.txt4 B · 2 行+2−0查看改动1a2b");
    await window.getByRole("tab", { name: "一" }).click();
    await expect(box).toBeVisible();
    await panel.getByRole("button", { name: "关闭右栏" }).click();
    await expect(panel).toHaveCount(0);
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
