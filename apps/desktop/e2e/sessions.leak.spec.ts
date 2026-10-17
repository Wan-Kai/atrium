import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitScene } from "@atrium/testkit";
import { realpath } from "node:fs/promises";
import { fauxPiEnvironment } from "./faux-pi";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";
import { send, sentAs } from "./messages";
import { addProject } from "./projects";

test("@leak switching between three sessions back and forth leaks no DOM", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      { blocks: [{ type: "text", text: "## 回复\n\n带一个列表：\n\n- 一\n- 二\n\n```ts\nconst a = 1;\n```" }] },
    ],
  });
  const launched = await launchApp(pi.env);
  const dir = await mkdtemp(join(tmpdir(), "atrium-heap-"));
  try {
    const { window } = launched;
    const tabs = window.getByRole("tab");
    const replies = window.locator('[data-testid="reply"][data-streaming="false"]');
    await send(window, "一");
    await expect(replies).toHaveCount(1, { timeout: 30_000 });
    for (const [at, text] of ["二", "三"].entries()) {
      await window.keyboard.press("Meta+T");
      await expect(tabs).toHaveCount(at + 2);
      await expect(replies).toHaveCount(0);
      await send(window, text);
      await expect(replies).toHaveCount(1, { timeout: 30_000 });
    }
    await expect(tabs).toHaveText(["一", "二", "三"], { timeout: 30_000 });
    /** Shows a session and waits until its transcript is on screen. */
    const show = async (text: string) => {
      await tabs.filter({ hasText: text }).click();
      await expect(window.getByTestId("user-message")).toHaveText([sentAs(text)]);
      await expect(replies).toHaveCount(1);
    };
    // Every session has been shown once, so what stays cached for them is in the baseline.
    for (const text of ["一", "二", "三"]) await show(text);

    await takeHeapSnapshot(window, join(dir, "baseline.heapsnapshot"));
    for (let round = 0; round < 15; round++) for (const text of ["一", "二", "三"]) await show(text);
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

test("@leak opening a child conversation and archiving it from its parent's capsule leaks no DOM (SPEC-0002)", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "好的" }] }] });
  const scene = await createGitScene("e2e-children-leak");
  const launched = await launchApp(pi.env);
  const dir = await mkdtemp(join(tmpdir(), "atrium-heap-"));
  try {
    const { window, app } = launched;
    await addProject(app, window, await realpath(scene.repo));
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    const tabs = window.getByRole("tab");
    await expect(tabs).toHaveText(["新会话"], { timeout: 30_000 });
    await send(window, "一");
    await expect(window.getByTestId("reply")).toHaveText(["好的"], { timeout: 60_000 });
    await expect(tabs).toHaveText(["一"], { timeout: 30_000 });
    /** Opens an empty child from the tab bar's menu, goes back up, and archives it from the capsule. */
    const round = async () => {
      await window.getByRole("button", { name: "新建", exact: true }).click();
      await window.getByRole("menuitem", { name: /子对话/ }).click();
      await window.getByRole("dialog", { name: "开子对话" }).getByRole("button", { name: "开子对话" }).click();
      await expect(tabs).toHaveText(["一", "子对话 1"], { timeout: 30_000 });
      await window.getByRole("navigation", { name: "子对话的位置" }).getByRole("button", { name: "一" }).click();
      await window.getByRole("button", { name: /^子对话 1/ }).click();
      await window.getByRole("button", { name: "「子对话 1」的操作" }).click();
      await window.getByRole("menuitem", { name: "归档" }).click();
      await expect(tabs).toHaveText(["一"], { timeout: 30_000 });
      await expect(window.getByRole("button", { name: /^子对话 1/ })).toHaveCount(0);
    };
    // The dialog, capsule and breadcrumb have each been shown once, so what stays cached is in the baseline.
    await round();

    await takeHeapSnapshot(window, join(dir, "baseline.heapsnapshot"));
    for (let at = 0; at < 10; at++) await round();
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
