import { createGitScene } from "@atrium/testkit";
import { type Page, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
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
 * @remarks
 * Only for looking at the real run by hand.
 *
 * @sideEffects Writes a file.
 * @param window - The app's window.
 * @param name - The shot's name.
 */
async function shoot(window: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await window.screenshot({ path: join(SHOTS, `t10-real-${name}.png`) });
}

/**
 * A rule "every 5 minutes" from a real conversation, saved, and waited for until it makes its first task.
 *
 * @remarks
 * Run by hand: `E2E_TASK_REAL=1 E2E_TASK_SHOTS=<dir> pnpm --filter @atrium/desktop test:e2e --grep "real model sets"`.
 * The host has no shortened clock, so it waits for the real trigger (5 minutes after the rule is saved). Temporary
 * Atrium home, temporary pi agent directory with only the DeepSeek login copied in, `SHELL=/usr/bin/false` so the host
 * does not read a login shell that would bring back the real agent directory. Skipped unless `E2E_TASK_REAL=1`.
 */
test.skip(process.env["E2E_TASK_REAL"] !== "1", "a real model: run by hand with E2E_TASK_REAL=1");

test("a real model sets an every-5-minutes rule, and the trigger makes a task (SPEC-0006, T10)", async () => {
  test.setTimeout(1_200_000);
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
  const scene = await createGitScene("e2e-schedule-real");
  const launched = await launchApp({ PI_CODING_AGENT_DIR: agentDir, SHELL: "/usr/bin/false" });
  try {
    const { window, app } = launched;
    const repo = await realpath(scene.repo);
    await addProject(app, window, repo);
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
    await send(
      window,
      "I want a research that repeats: every 5 minutes, look at the files in the project's root directory and say in " +
        "one sentence what the project seems to be. It only reads, so it runs read-only in the project's own directory. " +
        "Plan it as a schedule rule with one agent node (role explore) and one human node after it. " +
        "Do not do anything now; just confirm the plan in one sentence.",
    );
    await expect(window.getByTestId("turn").first()).toBeVisible({ timeout: 120_000 });
    await expect(window.getByRole("button", { name: "停止" })).toHaveCount(0, { timeout: 180_000 });
    await send(window, "/task");
    await expect(window.getByTestId("task-tab")).toBeVisible({ timeout: 60_000 });
    await expect(window.getByTestId("graph-node").first().or(window.getByText("回复出错"))).toBeVisible({
      timeout: 240_000,
    });
    await expect(window.getByText("回复出错"), "the task conversation's model failed to answer").toHaveCount(0);
    await expect(window.getByTestId("task-model")).toContainText("deepseek-flash");
    // The model made the task a rule's template: the button says so.
    await expect(
      window.getByRole("button", { name: "确认并保存规则" }),
      "the model did not set a schedule",
    ).toBeVisible({
      timeout: 120_000,
    });
    await shoot(window, "designing");
    await window.getByRole("button", { name: "确认并保存规则" }).click();

    await window.getByRole("tab", { name: "定时", exact: true }).click();
    const row = window.getByTestId("rule-row");
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(window.getByTestId("rule-when")).toHaveText("每 5 分钟");
    await shoot(window, "rule-saved");

    // Waits for the real trigger: 5 minutes after the rule was saved, and then one task in the list.
    await expect(window.getByTestId("rule-result")).not.toHaveText("—", { timeout: 420_000 });
    await shoot(window, "rule-triggered");
    await window.getByRole("tab", { name: "任务", exact: true }).click();
    const made = window.getByTestId("task-row");
    await expect(made.first()).toBeVisible({ timeout: 30_000 });
    await expect(made.first().getByLabel("定时触发的任务")).toBeVisible();
    await shoot(window, "task-listed");
    // Paused, it makes no more.
    await window.getByRole("tab", { name: "定时", exact: true }).click();
    await window.getByRole("button", { name: "暂停" }).click();
    await expect(window.getByTestId("rule-result")).toHaveText("已暂停");
    await shoot(window, "rule-paused");
  } finally {
    await launched.close();
    await scene.cleanup();
  }
});
