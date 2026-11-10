import { type Page, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";
import { pressInWindow } from "./press-in-window";

/** A direction with a ladder, its first lesson still to teach, as its marker holds it. */
const MARKER = {
  version: 1,
  name: "Rust",
  createdAt: "2026-11-10T00:00:00.000Z",
  profile: {},
  ladder: [
    { id: "l1", name: "语法", topics: "", pass: "", state: "current" },
    { id: "l2", name: "所有权", topics: "", pass: "", state: "todo" },
  ],
  steps: { l1: [{ id: "s1", kind: "lesson", title: "变量", lesson: null, quiz: null, done: null }] },
  gaps: [],
  finishedAt: null,
};

/** A demo that asks one question to guess, sending the guess back when clicked (SPEC-0008, "演示"). */
const DEMO = `<div id="guess"><p>猜一下：这段能编译吗？</p><button id="yes">能</button><output id="sent">-</output></div>
<script>document.getElementById("yes").addEventListener("click", () => window.atrium.sendMessage("我猜：能").then((sent) => { document.getElementById("sent").textContent = String(sent); }));</script>`;

/**
 * Makes the Rust direction in the learning directory of a launched app's home, and has the window
 * find it.
 *
 * @remarks
 * As a direction made outside Atrium: the host lists it once the window is focused (ML1).
 *
 * @sideEffects Writes the direction; focuses the window's page.
 * @param home - The app's home.
 * @param page - Its window.
 * @returns The direction's directory.
 */
async function makeDirection(home: string, page: Page): Promise<string> {
  const dir = join(await realpath(home), "Learning", "rust");
  await mkdir(join(dir, "visuals"), { recursive: true });
  await mkdir(join(dir, "notes"));
  await writeFile(join(dir, ".atrium-study.json"), JSON.stringify(MARKER));
  await writeFile(join(dir, "visuals", "1-01-guess.html"), DEMO);
  await writeFile(join(dir, "notes", "1-01.md"), "# 变量\n\n课上的演示：[猜一下](../visuals/1-01-guess.html)\n");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByTestId("learning-row").click();
  await page.getByRole("group", { name: "Rust" }).click({ timeout: 30_000 });
  return dir;
}

test("opens a demo from a direction's archive in the sandbox, and a click in it reaches no session of the direction (SPEC-0008, ML4)", async () => {
  const pi = await fauxPiEnvironment({
    replies: [],
    studyReplies: { lesson: [{ blocks: [{ type: "text", text: "先讲到这里" }] }] },
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    await makeDirection(launched.home, window);
    // A lesson open in the direction, which a click in the demo must not reach.
    await window.getByTestId("step-strip").getByRole("button", { name: "开始上课" }).click();
    await expect(window.getByTestId("reply").last()).toHaveText("先讲到这里", { timeout: 60_000 });
    const asked = (await pi.payloads()).length;
    expect(asked).toBeGreaterThan(0);
    const tabs = window.getByRole("tablist", { name: "打开的会话" });
    await tabs.getByRole("tab", { name: "Rust", exact: true }).click();
    const archive = window.getByRole("region", { name: "档案" });

    await archive.getByRole("button", { name: /1-01-guess\.html/u }).click();

    const viewer = window.getByRole("region", { name: "visuals/1-01-guess.html" });
    await expect(viewer.getByText("在这里点的不会发到对话")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "在浏览器打开" })).toHaveCount(0);
    const frame = viewer.getByTestId("visual-frame");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame).toHaveAttribute("src", /^atrium-visual:\/\/[0-9a-f]{32}\/1-01-guess\.html\?v=\d+$/u);
    const inside = frame.contentFrame();
    // A press the app sees as yours, as a visual in a session would need to send.
    await pressInWindow(launched.app, inside.locator("#yes"));
    await expect(inside.locator("#sent")).toHaveText("false");
    // Nothing went to the lesson: pi was asked nothing more, and the lesson shows no message from a visual.
    const sessions = JSON.parse(await readFile(join(launched.home, "sessions.json"), "utf8")) as {
      sessions: unknown[];
    };
    expect(sessions.sessions).toHaveLength(1);
    expect((await pi.payloads()).length).toBe(asked);
    await tabs.getByRole("tab", { name: /变量/u }).click();
    await expect(window.getByTestId("reply").last()).toHaveText("先讲到这里");
    await expect(window.getByTestId("user-from-visual")).toHaveCount(0);

    // Back on the home, the note's link up to the demo opens the same viewer tab.
    await tabs.getByRole("tab", { name: "Rust", exact: true }).click();
    await archive.getByRole("button", { name: "notes/" }).click();
    await archive.getByRole("button", { name: "1-01.md" }).click();
    await window.getByTestId("markdown-preview").getByRole("button", { name: "猜一下" }).click();
    await expect(window.getByRole("region", { name: "visuals/1-01-guess.html" })).toBeVisible();
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("@leak opening and closing a direction's demo and note in its viewer tab again and again leaks no DOM", async () => {
  const pi = await fauxPiEnvironment({ replies: [] });
  const launched = await launchApp(pi.env);
  const heap = await mkdtemp(join(tmpdir(), "atrium-heap-"));
  try {
    const { window } = launched;
    await makeDirection(launched.home, window);
    const archive = window.getByRole("region", { name: "档案" });
    /** Opens the demo rendered, then its source, then the note's preview, and closes them with ⌘W. */
    const round = async () => {
      await archive.getByRole("button", { name: /1-01-guess\.html/u }).dblclick();
      const viewer = window.getByRole("region", { name: "visuals/1-01-guess.html" });
      await expect(viewer.getByTestId("visual-frame").contentFrame().locator("#yes")).toBeVisible({ timeout: 30_000 });
      await viewer.getByRole("button", { name: "查看源码" }).click();
      await expect(viewer.getByRole("button", { name: "预览" })).toBeVisible();
      await window.keyboard.press("Meta+w");
      await expect(viewer).toHaveCount(0);
      await archive.getByRole("button", { name: "notes/" }).click();
      await archive.getByRole("button", { name: "1-01.md" }).dblclick();
      await expect(window.getByTestId("markdown-preview")).toContainText("变量");
      await window.keyboard.press("Meta+w");
      await expect(window.getByTestId("markdown-preview")).toHaveCount(0);
      await expect(window.getByTestId("direction-home")).toBeVisible();
    };
    await round();
    await takeHeapSnapshot(window, join(heap, "baseline.heapsnapshot"));
    for (let again = 0; again < 10; again++) await round();
    await takeHeapSnapshot(window, join(heap, "final.heapsnapshot"));

    expect(
      await findDetachedDomLeaks(join(heap, "baseline.heapsnapshot"), join(heap, "final.heapsnapshot")),
    ).toStrictEqual([]);
  } finally {
    await launched.close();
    await pi.cleanup();
    await rm(heap, { recursive: true, force: true });
  }
});
