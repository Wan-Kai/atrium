import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { sep } from "node:path";

test("queues a message during a run, stops the run, and sends the queue once resumed", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      { waitFor: "first", blocks: [{ type: "text", text: "第一个回复" }] },
      { blocks: [{ type: "text", text: "第二个回复" }] },
    ],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("一");
    await box.press("Enter");
    await expect(window.getByRole("button", { name: "停止" })).toBeVisible({ timeout: 30_000 });

    await box.fill("二");
    await box.press("Enter");
    await expect(window.getByRole("button", { name: "排队 1" })).toBeVisible();
    await expect(window.getByTestId("queued")).toHaveCount(1);
    await expect(window.getByTestId("queued")).toContainText("二");
    await window.getByRole("button", { name: "停止" }).click();

    await expect(window.getByRole("button", { name: "排队 1 · 已暂停" })).toBeVisible({ timeout: 30_000 });
    // pi wrote nothing before the stop, so the turn has no process line; its info line says so.
    await expect(window.getByTestId("turn").first()).toContainText("已停止");
    await window.getByRole("button", { name: "继续发送" }).click();
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["第二个回复"], {
      timeout: 30_000,
    });
    await expect(window.getByRole("button", { name: /^排队/ })).toHaveCount(0);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("steers a run: the steer waits as a capsule and reaches the agent before its next step", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      {
        waitFor: "first",
        blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf ok" } }],
      },
      { blocks: [{ type: "text", text: "按插话改好了" }] },
    ],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("一");
    await box.press("Enter");
    await expect(window.getByRole("button", { name: "停止" })).toBeVisible({ timeout: 30_000 });

    await box.fill("也看看 b");
    await box.press("Meta+Enter");
    await expect(window.getByTestId("steers")).toHaveText("1 条插话将在下一步前送达", { timeout: 30_000 });
    await pi.release("first");

    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["按插话改好了"], {
      timeout: 30_000,
    });
    await expect(window.getByTestId("steers")).toHaveCount(0);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("answers an extension's question on its card", async () => {
  const pi = await fauxPiEnvironment({ replies: [] });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("/faux-confirm");
    await box.press("Enter");

    const card = window.getByTestId("interaction");
    await expect(card).toContainText("Proceed?", { timeout: 30_000 });
    await expect(card).toContainText("The faux extension asks.");
    await card.getByRole("button", { name: "是" }).click();

    await expect(card).toHaveCount(0);
    await expect(window.locator('[data-testid="user-message"][data-pending="true"]')).toHaveCount(0);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

/**
 * The process id of the session's pi the host started last.
 *
 * @remarks
 * Not the short-lived pi the model list asks, which runs in Atrium's own directory: the session's
 * runs in the chat's.
 *
 * @sideEffects Reads the host's log.
 * @param launched - The app.
 * @returns The pid, or `undefined` before one started.
 */
async function sessionPid(launched: {
  readHostLog(): Promise<Record<string, unknown>[]>;
}): Promise<number | undefined> {
  const started = (await launched.readHostLog()).filter(
    (line) => line["msg"] === "pi started" && String(line["cwd"]).includes(`${sep}chats${sep}`),
  );
  return started.length === 0 ? undefined : Number(started.at(-1)?.["pid"]);
}

test("starts pi again after it is killed mid-run, and asks the agent to go on", async () => {
  const pi = await fauxPiEnvironment({
    replies: [{ waitFor: "first", blocks: [{ type: "text", text: "接着做完了" }] }],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("一");
    await box.press("Enter");
    // pi has echoed the message and holds the reply: the run is under way.
    await expect(window.locator('[data-testid="user-message"][data-pending="false"]')).toHaveCount(1, {
      timeout: 30_000,
    });
    const sessionPi = () => sessionPid(launched);
    const first = await sessionPi();
    expect(first).toBeDefined();

    // The kill is a crash to the host, which it logs before starting pi again.
    launched.expectLog({ level: "warn", msg: "pi exited", times: 1 });
    process.kill(Number(first), "SIGKILL");

    await expect(window.getByTestId("notice")).toHaveText("进程已自动重启（第 1 / 3 次）", { timeout: 30_000 });
    await expect.poll(sessionPi, { timeout: 30_000 }).not.toBe(first);
    await pi.release("first");
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["接着做完了"], {
      timeout: 30_000,
    });
    await expect(window.getByTestId("user-message").last()).toContainText("系统自动发出");
    await expect(window.getByTestId("user-message").last()).toContainText("上一次运行意外中断了，请从中断的地方继续。");
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
