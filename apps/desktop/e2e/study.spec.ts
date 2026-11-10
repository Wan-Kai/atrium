import { expect, test } from "@playwright/test";
import { lstat, mkdir, readFile, readdir, realpath, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

/**
 * Whether something is at a path.
 *
 * @remarks
 * `lstat`, so a link counts.
 *
 * @sideEffects Looks at the path.
 * @param path - The path.
 * @returns Whether it exists.
 */
async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

test("makes a direction from the first message and goes on in its discussion; archives and restores it (SPEC-0008)", async () => {
  const pi = await fauxPiEnvironment({
    replies: [{ blocks: [{ type: "text", text: "先问两件事" }] }],
    direction: JSON.stringify({ dir: "node-backend", name: "Node 后端" }),
  });
  const launched = await launchApp(pi.env);
  // ATRIUM_HOME is set, so the learning directory is inside it, never the real ~/Atrium/Learning.
  const learning = join(await realpath(launched.home), "Learning");
  try {
    const { window } = launched;
    await window.getByTestId("learning-row").click();
    // The learning directory the host uses, in its own home here: never the real ~/Atrium/Learning.
    await expect(window.getByText(`一个方向一个目录，放在 ${learning}/ 下面`)).toBeVisible();
    await window.getByRole("button", { name: "新建方向" }).click();
    await expect(window.getByText("想学点什么？")).toBeVisible();
    // Nothing is made before the first message.
    expect(await exists(learning)).toBe(false);

    await window.getByRole("textbox", { name: "消息" }).fill("我想学后端，目标是能自己写一个服务并部署上线");
    await window.getByRole("textbox", { name: "消息" }).press("Enter");

    await expect(window.getByTestId("reply")).toHaveText("先问两件事", { timeout: 60_000 });
    await expect(window.getByTestId("user-message")).toHaveText(/^我想学后端/);
    await expect(window.getByTestId("direction-created")).toHaveText(/^建了方向 Node 后端 · .*\/node-backend\/$/);
    const tabs = window.getByRole("tablist", { name: "打开的会话" });
    await expect(tabs.getByRole("tab", { name: "Node 后端", exact: true })).toBeVisible();
    const dir = join(learning, "node-backend");
    expect((await readdir(dir)).toSorted()).toStrictEqual([".atrium-study.json", "AGENTS.md", "lab"]);
    expect(JSON.parse(await readFile(join(dir, ".atrium-study.json"), "utf8"))).toMatchObject({ name: "Node 后端" });
    expect(await exists(join(dir, "lab", ".git"))).toBe(true);
    const sessions = JSON.parse(await readFile(join(launched.home, "sessions.json"), "utf8")) as {
      sessions: { containerId: string; cwd: string; study?: unknown }[];
    };
    expect(sessions.sessions).toMatchObject([
      { containerId: "lrn_node-backend", cwd: dir, study: { kind: "discuss" } },
    ]);

    // The home tab, then back to the learning home, where the direction has a card.
    await tabs.getByRole("tab", { name: "Node 后端", exact: true }).click();
    await expect(window.getByTestId("direction-home")).toContainText("讨论中");
    await window.getByRole("button", { name: /^学习 ›/ }).click();
    const card = window.getByRole("group", { name: "Node 后端" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Node 后端 的更多操作" }).click();
    await window.getByRole("menuitem", { name: "归档" }).click();

    await expect(card).toHaveCount(0, { timeout: 30_000 });
    expect(await exists(dir)).toBe(false);
    expect(await exists(join(learning, "Archive", "node-backend", ".atrium-study.json"))).toBe(true);

    // Its discussion can still be read, from its file, without pi.
    await window.getByRole("button", { name: "已归档的方向" }).click();
    await window
      .getByRole("list", { name: "已归档的方向" })
      .getByRole("button", { name: "Node 后端", exact: true })
      .click();
    await window.getByTestId("direction-home").getByRole("list", { name: "会话" }).getByRole("button").first().click();
    await expect(window.getByTestId("user-message")).toHaveText(/^我想学后端/, { timeout: 30_000 });
    await expect(window.getByRole("region", { name: "方向已归档" })).toBeVisible();
    await expect(window.getByRole("textbox", { name: "消息" })).toHaveCount(0);
    await window.getByRole("button", { name: /^学习 ›/ }).click();

    // Restoring is refused while something took its place.
    await mkdir(dir);
    await window.getByRole("button", { name: "已归档的方向" }).click();
    await window.getByRole("button", { name: "恢复 Node 后端" }).click();
    await expect(window.getByRole("alert")).toHaveText("原来的位置已经有同名的目录了，先把它挪走再恢复");
    expect(await exists(join(learning, "Archive", "node-backend"))).toBe(true);

    await rmdir(dir);
    await window.getByRole("button", { name: "恢复 Node 后端" }).click();
    await expect(window.getByRole("group", { name: "Node 后端" })).toBeVisible({ timeout: 30_000 });
    expect(await exists(join(dir, ".atrium-study.json"))).toBe(true);

    // Its discussion goes on where it was: in from its card, then its row on the direction's home.
    await window.getByRole("group", { name: "Node 后端" }).click();
    await window.getByTestId("direction-home").getByRole("list", { name: "会话" }).getByRole("button").first().click();
    await expect(window.getByTestId("user-message")).toHaveText(/^我想学后端/, { timeout: 30_000 });
    await expect(window.getByRole("textbox", { name: "消息" })).toBeEnabled();
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

/**
 * The tools a request offered the model.
 *
 * @remarks
 * None for no request.
 *
 * @sideEffects none
 * @param context - The request.
 * @returns The tools' names.
 */
function toolsOf(context: { readonly tools?: readonly string[] } | undefined): readonly string[] {
  return context?.tools ?? [];
}

test("writes the ladder the discussion's agent calls study_set_ladder with; the step strip starts the first lesson (SPEC-0008, ML2)", async () => {
  const ladder = {
    levels: [
      { name: "语法", topics: "类型、函数", pass: "一个小工具", skip: true },
      { name: "并发", topics: "goroutine", pass: "一个爬虫" },
    ],
    lessons: ["goroutine", "channel"],
  };
  const pi = await fauxPiEnvironment({
    replies: [
      { blocks: [{ type: "toolCall", id: "ladder-1", name: "study_set_ladder", arguments: ladder }] },
      { blocks: [{ type: "text", text: "阶梯排好了" }] },
    ],
    // The lesson's pi starts its own replies; its kickoff is Atrium's message, not the learner's.
    byPrompt: [{ startsWith: "<atrium-study", reply: { blocks: [{ type: "text", text: "今天讲 goroutine" }] } }],
    direction: JSON.stringify({ dir: "go", name: "Go" }),
  });
  const launched = await launchApp(pi.env);
  const learning = join(await realpath(launched.home), "Learning");
  try {
    const { window } = launched;
    await window.getByTestId("learning-row").click();
    await window.getByRole("button", { name: "新建方向" }).click();
    await window.getByRole("textbox", { name: "消息" }).fill("我想学 Go，写一个爬虫");
    await window.getByRole("textbox", { name: "消息" }).press("Enter");

    await expect(window.getByTestId("reply").last()).toHaveText("阶梯排好了", { timeout: 60_000 });
    const strip = window.getByTestId("step-strip");
    await expect(strip).toHaveAttribute("data-state", "learning", { timeout: 30_000 });
    await expect(strip).toContainText("第 2 级 · 并发");
    await expect(strip).toContainText("第 1 步 · goroutine");
    await expect(strip.getByRole("button", { name: "开始上课" })).toBeEnabled();
    const marker = JSON.parse(await readFile(join(learning, "go", ".atrium-study.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(marker).toMatchObject({
      name: "Go",
      ladder: [
        { id: "l1", name: "语法", state: "skipped" },
        { id: "l2", name: "并发", state: "current" },
      ],
      steps: {
        l2: [
          { id: "s1", title: "goroutine" },
          { id: "s2", title: "channel" },
          { kind: "sheet" },
          { kind: "project" },
          { kind: "exam" },
          { kind: "up" },
        ],
      },
    });
    // The discussion's model had the discussion's tools, and none of a lesson's.
    const tools = (await pi.contexts()).flatMap(toolsOf);
    expect(tools).toContain("study_set_ladder");
    expect(tools).not.toContain("study_report");

    // The lesson's session opens with its use as its first turn, then the strip goes back to it.
    await strip.getByRole("button", { name: "开始上课" }).click();
    await expect(window.getByTestId("source-line")).toHaveText("上课 · 第 2 级第 1 步 · goroutine", {
      timeout: 60_000,
    });
    await expect(window.getByTestId("reply").last()).toHaveText("今天讲 goroutine", { timeout: 60_000 });
    await expect(window.getByTestId("user-message")).toHaveCount(0);
    await expect(strip.getByRole("button", { name: "回到会话" })).toBeVisible({ timeout: 30_000 });
    const lessonTools = toolsOf((await pi.contexts()).at(-1));
    expect(lessonTools).toContain("study_report");
    expect(lessonTools).not.toContain("study_set_ladder");
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
