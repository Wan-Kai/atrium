import { createGitScene } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";
import { addProject } from "./projects";

test("@leak opening and closing viewer tabs back and forth leaks no DOM", async () => {
  const pi = await fauxPiEnvironment({ replies: [] });
  const scene = await createGitScene("e2e-viewers-leak");
  const repo = await realpath(scene.repo);
  const code = Array.from({ length: 200 }, (_, line) => `export const value${line} = ${line};`).join("\n");
  await writeFile(join(repo, "a.ts"), `${code}\n`);
  await writeFile(join(repo, "b.ts"), `${code}\n// b\n`);
  const launched = await launchApp(pi.env);
  const dir = await mkdtemp(join(tmpdir(), "atrium-heap-"));
  try {
    const { window, app } = launched;
    await addProject(app, window, repo);
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    await window.keyboard.press("Meta+Alt+b");
    const panel = window.getByRole("complementary", { name: "文件与更改" });
    await panel.getByRole("tab", { name: "文件" }).click();
    const tree = panel.getByTestId("files-tree");
    const tabs = window.getByRole("tablist", { name: "打开的会话" }).getByRole("tab");
    const sessions = await tabs.count();
    /** Opens the two files and the 改动 tab, each coloured, then closes them. */
    const round = async () => {
      for (const name of ["a.ts", "b.ts"]) {
        await tree.getByRole("button", { name, exact: true }).dblclick();
        await expect(window.getByRole("region", { name }).locator("span[style]").first()).toBeAttached({
          timeout: 30_000,
        });
      }
      await panel.getByRole("tab", { name: /更改/ }).click();
      await panel.getByTestId("changes-tree").getByRole("button", { name: /a\.ts/ }).click({ timeout: 30_000 });
      await expect(window.getByRole("region", { name: "改动" }).locator("span[style]").first()).toBeAttached({
        timeout: 30_000,
      });
      await panel.getByRole("tab", { name: "文件" }).click();
      for (let open = 3; open > 0; open--) await window.keyboard.press("Meta+w");
      await expect(tabs).toHaveCount(sessions);
    };
    // Each kind of tab has been shown once, so what stays cached for them is in the baseline.
    await round();

    await takeHeapSnapshot(window, join(dir, "baseline.heapsnapshot"));
    for (let again = 0; again < 15; again++) await round();
    await takeHeapSnapshot(window, join(dir, "final.heapsnapshot"));

    expect(
      await findDetachedDomLeaks(join(dir, "baseline.heapsnapshot"), join(dir, "final.heapsnapshot")),
    ).toStrictEqual([]);
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
