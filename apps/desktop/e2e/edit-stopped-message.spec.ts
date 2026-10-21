import { present } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { send } from "./messages";

const ORIGINAL = "JSON 选 A\nCSV 选";
const REVISED = "JSON 选 A\nCSV 选 B";
const NEXT_DRAFT = "下一条：补充导出文件名";
const NEW_REPLY = "已按 JSON A、CSV B 重新处理。";

/**
 * Reads the JSON lines written by the real pi and its faux extension.
 *
 * @remarks
 * Session files prove append-only branch preservation; provider contexts prove that the old
 * user message did not leak back into the model's new branch as history or a summary.
 *
 * @sideEffects Reads a file in the isolated test environment.
 * @param path - The session or context file.
 * @returns Parsed records, in append order.
 */
async function recordsIn(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Lists the session files created by the real pi in this test.
 *
 * @remarks
 * An edit must keep both the session identity and its file, not fork a second session.
 *
 * @sideEffects Reads pi's isolated session directory.
 * @param agentDir - The faux environment's pi configuration directory.
 * @returns Relative session file paths, sorted for deterministic comparison.
 */
async function sessionFiles(agentDir: string): Promise<string[]> {
  return (await readdir(join(agentDir, "sessions"), { recursive: true }))
    .filter((path) => path.endsWith(".jsonl"))
    .toSorted();
}

test("edits the last stopped message in place, preserves the next draft and old branch, and restores the revision after restart", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      { waitFor: "mis-sent", blocks: [{ type: "text", text: "不应显示的旧回复" }] },
      { blocks: [{ type: "text", text: NEW_REPLY }] },
    ],
    title: "导出格式的选择",
  });
  let launched = await launchApp(pi.env);
  const home = launched.home;
  try {
    let { window } = launched;
    const contextFile = join(dirname(present(pi.env["FAUX_PI_SCRIPT"], "the faux script path")), "contexts.jsonl");
    await send(window, ORIGINAL);
    await expect(window.locator('[data-testid="user-message"][data-pending="false"]')).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(window.getByRole("button", { name: "停止", exact: true })).toBeVisible();
    // The provider is waiting at its gate, not merely waiting for pi to start.
    await expect.poll(() => pi.payloads()).toHaveLength(1);
    await window.getByRole("button", { name: "停止", exact: true }).click();
    await expect(window.getByTestId("turn")).toContainText("已停止", { timeout: 30_000 });
    await expect(window.getByRole("button", { name: "停止中", exact: true })).toHaveCount(0);
    await expect(window.getByRole("tab")).toHaveText(["导出格式的选择"], { timeout: 30_000 });
    const tabsBefore = await window.getByRole("tab").allTextContents();
    const chatsBefore = await window.getByRole("region", { name: "对话" }).getByTestId("chat-row").count();
    const filesBefore = await sessionFiles(pi.agentDir);
    expect(filesBefore).toHaveLength(1);
    const sessionFile = join(pi.agentDir, "sessions", present(filesBefore[0], "the original session file"));
    const originalFile = await readFile(sessionFile, "utf8");
    const originalRecords = await recordsIn(sessionFile);
    const oldUser = present(
      originalRecords.find((record) => JSON.stringify(record["message"])?.includes(JSON.stringify(ORIGINAL))),
      "the original user entry",
    );

    const box = window.getByRole("textbox", { name: "消息", exact: true });
    await box.fill(NEXT_DRAFT);
    await window.getByRole("button", { name: "编辑已停止消息", exact: true }).click();
    await expect(window.getByText("编辑已停止的消息", { exact: true })).toBeVisible();
    await expect(box).toHaveValue(ORIGINAL);
    await expect(box).toBeFocused();
    await expect(window.getByTestId("user-text")).toHaveText([ORIGINAL]);
    await box.fill(REVISED);
    await window.getByRole("button", { name: "取消编辑", exact: true }).click();
    await expect(box).toHaveValue(NEXT_DRAFT);
    await expect(window.getByTestId("user-text")).toHaveText([ORIGINAL]);
    expect(await readFile(sessionFile, "utf8")).toBe(originalFile);
    expect(await pi.payloads()).toHaveLength(1);

    await window.getByRole("button", { name: "编辑已停止消息", exact: true }).click();
    await expect(box).toHaveValue(ORIGINAL);
    // A slash command is outside ordinary-message editing and must fail without losing either draft.
    await box.fill("/help");
    await window.getByRole("button", { name: "重新发送", exact: true }).click();
    await expect(window.getByRole("alert")).toHaveText("没能重新发送，编辑内容已保留，请重试");
    await expect(box).toHaveValue("/help");
    await expect(window.getByTestId("user-text")).toHaveText([ORIGINAL]);
    expect(await readFile(sessionFile, "utf8")).toBe(originalFile);
    expect(await pi.payloads()).toHaveLength(1);
    await box.fill(REVISED);
    await window.getByRole("button", { name: "重新发送", exact: true }).click();
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText([NEW_REPLY], {
      timeout: 30_000,
    });
    await expect(window.getByTestId("user-text")).toHaveText([REVISED]);
    await expect(window.getByTestId("turn")).toHaveCount(1);
    await expect(box).toHaveValue(NEXT_DRAFT);
    await expect(window.getByText("编辑已停止的消息", { exact: true })).toHaveCount(0);
    await expect(window.getByRole("tab")).toHaveText(tabsBefore);
    await expect(window.getByRole("region", { name: "对话" }).getByTestId("chat-row")).toHaveCount(chatsBefore);
    expect(await sessionFiles(pi.agentDir)).toStrictEqual(filesBefore);

    const revisedFile = await readFile(sessionFile, "utf8");
    expect(revisedFile.startsWith(originalFile)).toBe(true);
    const revisedRecords = await recordsIn(sessionFile);
    expect(revisedRecords).toContainEqual(oldUser);
    const newUser = present(
      revisedRecords.find((record) => JSON.stringify(record["message"])?.includes(JSON.stringify(REVISED))),
      "the revised user entry",
    );
    expect(newUser["id"]).not.toBe(oldUser["id"]);
    expect(newUser["parentId"]).toBe(oldUser["parentId"]);
    const contexts = await recordsIn(contextFile);
    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[0]?.["messages"])).toContain(JSON.stringify(ORIGINAL));
    expect(JSON.stringify(contexts[1]?.["messages"])).toContain(JSON.stringify(REVISED));
    expect(JSON.stringify(contexts[1]?.["messages"])).not.toContain(JSON.stringify(ORIGINAL));

    await launched.quit();
    launched = await launchApp(pi.env, home);
    window = launched.window;
    // Explicitly reopen from history, rather than relying only on the restored live tab.
    await expect(window.getByRole("tab")).toHaveText(tabsBefore, { timeout: 30_000 });
    await window.getByRole("tab").click();
    await window.keyboard.press("Meta+W");
    await expect(window.getByRole("tab")).toHaveCount(0);
    await window.getByRole("button", { name: "历史", exact: true }).click();
    await window.getByRole("menuitem", { name: /^导出格式的选择/ }).click();
    await expect(window.getByTestId("user-text")).toHaveText([REVISED], { timeout: 30_000 });
    await expect(window.getByTestId("reply")).toHaveText([NEW_REPLY]);
    await expect(window.getByTestId("turn")).toHaveCount(1);
    await expect(window.getByRole("tab")).toHaveText(tabsBefore);
    expect(await sessionFiles(pi.agentDir)).toStrictEqual(filesBefore);
    expect((await readFile(sessionFile, "utf8")).startsWith(revisedFile)).toBe(true);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
