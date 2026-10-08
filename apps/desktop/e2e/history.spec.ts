import { parseFixture } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { addProject, piSessionFolder } from "./projects";

/** The recorded history scenario, which belongs to the pi package. */
const FIXTURE = join(import.meta.dirname, "..", "..", "..", "packages", "pi", "fixtures", "pi-1.0.2", "history.jsonl");

/**
 * Writes the session file pi wrote in the recorded history scenario into pi's session directory.
 *
 * @remarks
 * The recording keeps placeholders for paths and the session id; they are filled in with a real
 * working directory and a fresh id, so pi opens the file as one of its own.
 *
 * @sideEffects Creates the working directory and the session file.
 * @param agentDir - pi's agent directory.
 * @param cwd - The working directory the session records.
 * @returns The session id.
 */
async function writeRecordedSession(agentDir: string, cwd: string): Promise<string> {
  const fixture = parseFixture(await readFile(FIXTURE, "utf8"));
  const session = fixture.find((record) => record.kind === "session") as unknown as { lines: unknown[] } | undefined;
  if (session === undefined) throw new Error("the history fixture holds no session file");
  const sessionId = randomUUID();
  const text = session.lines
    .map((line) =>
      JSON.stringify(line).replaceAll("<cwd>", cwd).replaceAll("<home>", cwd).replaceAll("<uuid-1>", sessionId),
    )
    .join("\n");
  const folder = piSessionFolder(agentDir, cwd);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `2026-10-08T00-00-00-000Z_${sessionId}.jsonl`), `${text}\n`);
  return sessionId;
}

test("opens a session from pi's file: tools, a retry and a compaction on its branch, not the other branch", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "fifth answer" }] }] });
  // pi records the real path, and the host keeps projects at theirs.
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "atrium-e2e-session-")));
  await writeRecordedSession(pi.agentDir, cwd);
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, cwd);
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    await window.getByRole("button", { name: "历史" }).click();
    await window.getByRole("menuitem", { name: /^one/ }).click({ timeout: 30_000 });

    const turns = window.getByTestId("turn");
    await expect(turns).toHaveCount(4, { timeout: 30_000 });
    await expect(window.getByTestId("reply")).toHaveText([
      "first answer",
      "second answer",
      "third answer",
      "fourth answer",
    ]);
    await expect(window.getByText("branch answer")).toHaveCount(0);
    await expect(window.getByTestId("notice")).toHaveText("上下文已压缩 · 压缩前 0 tokens");
    // The notice comes after the turn it happened in.
    await expect(window.locator('[data-testid="turn"] + [data-testid="notice"]')).toHaveCount(1);
    await expect(turns.nth(0).getByTestId("process-header")).toHaveText(
      "已完成，用时 不到 1 秒 · 读了 1 个文件 · 跑了 1 条命令 · 改了 1 个文件",
    );
    await turns.nth(1).getByTestId("process-header").click();
    await expect(turns.nth(1).getByTestId("step")).toHaveText([
      "自动重试 · 第 1 次·upstream returned 503 service unavailable",
    ]);

    await window.getByRole("textbox", { name: "消息" }).fill("five");
    await window.getByRole("textbox", { name: "消息" }).press("Enter");
    await expect(window.getByTestId("reply").last()).toHaveText("fifth answer", { timeout: 30_000 });
    await expect(turns).toHaveCount(5);
    await expect(window.getByTestId("run-status")).toHaveCount(0);
  } finally {
    await launched.close();
    await pi.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});
