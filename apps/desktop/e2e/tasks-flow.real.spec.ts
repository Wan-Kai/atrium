import { createGitScene } from "@atrium/testkit";
import { type Page, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./launch";
import { send } from "./messages";
import { addProject } from "./projects";

/** Where the screenshots go; set with `E2E_TASK_SHOTS`, otherwise nothing is taken. */
const SHOTS = process.env["E2E_TASK_SHOTS"];

/**
 * Saves a screenshot when `E2E_TASK_SHOTS` names a folder.
 *
 * @sideEffects Writes a file.
 * @param window - The app's window.
 * @param name - The shot's name.
 */
async function shoot(window: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await window.screenshot({ path: join(SHOTS, `t8b-real-${name}.png`) });
}

/**
 * Answers the node's question in the list's row with its first option, if the node asked one.
 *
 * @remarks
 * A real model may go straight to the end without asking, which is no failure.
 *
 * @sideEffects Clicks.
 * @param window - The app's window.
 * @param shot - Takes a screenshot.
 */
async function answerIfAsked(window: Page, shot: (name: string) => Promise<void>): Promise<void> {
  const asking = window.getByTestId("question");
  if (!(await asking.isVisible())) return;
  await shot("list-question");
  await asking.getByRole("radio").first().click();
  await asking.getByRole("button", { name: "提交回答" }).click();
}

/**
 * The same flow as `tasks-flow.spec.ts` with a real model: `/task` from a chat, confirm and start, answer what the node
 * asks, accept and merge, archive.
 *
 * @remarks
 * Run by hand: `E2E_TASK_REAL=1 E2E_TASK_SHOTS=<dir> pnpm --filter @atrium/desktop test:e2e --grep "real model"`. It uses
 * a temporary Atrium home, a temporary pi agent directory with only the DeepSeek login copied in (nothing is written to
 * the real one), and a scratch repository with a local bare origin so merging works. Skipped unless `E2E_TASK_REAL=1`,
 * since a real model costs money and does not always answer the same way: a node that does not ask has no question
 * to answer, and the test goes on.
 */
test.skip(process.env["E2E_TASK_REAL"] !== "1", "a real model: run by hand with E2E_TASK_REAL=1");

test("a real model walks /task to merge and archive (SPEC-0006, 验证 · 端到端)", async () => {
  test.setTimeout(900_000);
  const agentDir = await mkdtemp(join(tmpdir(), "atrium-real-pi-"));
  const auth = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ deepseek: auth["deepseek"] }), { mode: 0o600 });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-flash", defaultThinkingLevel: "off" }),
  );
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  const scene = await createGitScene("e2e-task-real");
  const launched = await launchApp({ PI_CODING_AGENT_DIR: agentDir, SHELL: "/usr/bin/false" });
  const shot = (name: string): Promise<void> => shoot(launched.window, name);
  try {
    const { window, app } = launched;
    const repo = await realpath(scene.repo);
    await addProject(app, window, repo);
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
    await send(
      window,
      "We want to add a file hello.txt at the repository root whose only line is a greeting. " +
        "Plan it as a task with exactly two nodes: an agent node (role work) that first asks me with ask_user which greeting " +
        "to use (two options: 'hello atrium' and 'hi atrium') and then writes hello.txt with my choice, and the human node " +
        "'验收合并' (merge) after it. Do not write anything yourself now; just confirm the plan in one sentence.",
    );
    await expect(window.getByTestId("turn").first()).toBeVisible({ timeout: 120_000 });
    await expect(window.getByRole("button", { name: "停止" })).toHaveCount(0, { timeout: 180_000 });
    await send(window, "/task");
    await expect(window.getByTestId("task-tab")).toBeVisible({ timeout: 60_000 });
    // Fail fast with the reason: a model that answers with an error never draws a graph.
    await expect(window.getByTestId("graph-node").first().or(window.getByText("回复出错"))).toBeVisible({
      timeout: 240_000,
    });
    await expect(window.getByText("回复出错"), "the task conversation's model failed to answer").toHaveCount(0);
    await expect(window.getByTestId("task-model"), "the task must use deepseek-flash").toContainText("deepseek-flash");
    await shot("designing");
    await window.getByRole("button", { name: "确认并启动" }).click();
    await expect(window.getByTestId("task-bar-status")).not.toContainText("设计中", { timeout: 30_000 });

    // The node may ask; answer in the list's row. Whatever comes first: the question or the human node's review.
    await window.getByRole("tab", { name: "任务", exact: true }).click();
    await window.getByTestId("task-row").click();
    const reviewing = window.getByRole("button", { name: "打开任务" });
    await expect(
      window.getByTestId("question").or(window.getByTestId("task-status").filter({ hasText: "等你验收" })),
    ).toBeVisible({ timeout: 600_000 });
    await answerIfAsked(window, shot);
    await expect(window.getByTestId("task-status")).toContainText("等你验收", { timeout: 600_000 });
    await shot("list-human");
    await reviewing.click();
    const review = window.getByTestId("review");
    await expect(review).toBeVisible({ timeout: 60_000 });
    await shot("review-human");
    await review.getByRole("button", { name: "通过并合并" }).click();
    await expect(window.getByTestId("review-subject")).toContainText("要归档 worktree 吗", { timeout: 120_000 });
    await shot("review-archive");
    expect(await readdir(repo)).toContain("hello.txt");
    await window.getByTestId("review").getByRole("button", { name: "归档" }).click();
    await expect(window.getByTestId("review")).toHaveCount(0, { timeout: 60_000 });
    await shot("done");
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(
      1,
    );
  } finally {
    await launched.close();
    await scene.cleanup();
    await rm(agentDir, { recursive: true, force: true });
  }
});
