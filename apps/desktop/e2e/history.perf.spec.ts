import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp, median } from "./launch";
import { addProject, piSessionFolder } from "./projects";

/** How many turns the session has (testing.md, "性能预算"). */
const TURNS = 1000;

/** The first screen's budget, in milliseconds. */
const BUDGET_MS = 500;

/**
 * Writes a session file of `TURNS` turns into pi's session directory.
 *
 * @remarks
 * Each turn has thinking, a command with its output, and a reply with a list and code, so the
 * first screen renders the kinds of content real sessions have.
 *
 * @sideEffects Creates the session file.
 * @param agentDir - pi's agent directory.
 * @param cwd - The working directory the session records.
 */
async function writeLongSession(agentDir: string, cwd: string): Promise<void> {
  const sessionId = randomUUID();
  let next = 0;
  let parentId: string | null = null;
  let time = Date.UTC(2026, 9, 1);
  const lines: object[] = [
    { type: "session", version: 3, id: sessionId, timestamp: new Date(time).toISOString(), cwd },
  ];
  /** Appends an entry under the previous one. */
  const entry = (fields: object): void => {
    const id = (next++).toString(16).padStart(8, "0");
    time += 1000;
    lines.push({ ...fields, id, parentId, timestamp: new Date(time).toISOString() });
    parentId = id;
  };
  const usage = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: {} };
  entry({ type: "model_change", provider: "faux", modelId: "faux-1" });
  for (let turn = 0; turn < TURNS; turn += 1) {
    entry({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: `第 ${turn} 个问题` }], timestamp: time },
    });
    entry({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先看看文件。" },
          { type: "toolCall", id: `call-${turn}`, name: "bash", arguments: { command: "ls -la src" } },
        ],
        stopReason: "toolUse",
        usage,
        timestamp: time,
      },
    });
    entry({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call-${turn}`,
        toolName: "bash",
        content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }],
        isError: false,
        timestamp: time,
      },
    });
    entry({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `第 ${turn} 个回答：\n\n- 一\n- 二\n\n\`\`\`ts\nconst x = ${turn};\n\`\`\`` }],
        stopReason: "stop",
        usage,
        timestamp: time,
      },
    });
  }
  const folder = piSessionFolder(agentDir, cwd);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, `2026-10-01T00-00-00-000Z_${sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

/**
 * Starts timing from the next press of the session in "历史" and resolves once its first screen is drawn.
 *
 * @remarks
 * Runs inside the renderer. The first screen is drawn once the snapshot's 20 turns are in the
 * page and two frames have passed, so the browser has painted them.
 */
function timeFirstScreen(): void {
  const page = window as unknown as { firstScreen: Promise<number> };
  page.firstScreen = new Promise((resolve) => {
    let start = 0;
    document.addEventListener(
      "pointerdown",
      () => {
        start = performance.now();
      },
      { capture: true, once: true },
    );
    const observer = new MutationObserver(() => {
      if (start === 0 || document.querySelectorAll('[data-testid="turn"]').length < 20) return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

test(`@perf opens a ${TURNS}-turn session to its first screen within ${BUDGET_MS} ms (median of 3)`, async () => {
  test.setTimeout(240_000);
  const pi = await fauxPiEnvironment({ replies: [] });
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "atrium-e2e-long-")));
  await writeLongSession(pi.agentDir, cwd);
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    await addProject(launched.app, window, cwd);
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    const history = window.getByRole("button", { name: "历史" });
    const open = window.getByRole("menuitem", { name: /第 0 个问题/ });
    const started = Date.now();
    await history.click();
    await open.click({ timeout: 30_000 });
    await expect(window.getByTestId("turn")).toHaveCount(20, { timeout: 60_000 });
    test.info().annotations.push({ type: "first open, pi starting", description: `${Date.now() - started} ms` });
    const timings: number[] = [];
    for (let run = 0; run < 3; run++) {
      await window.getByRole("button", { name: /^关闭 / }).click();
      await expect(window.getByTestId("turn")).toHaveCount(0);
      await history.click();
      await window.evaluate(timeFirstScreen);
      await open.click();
      timings.push(await window.evaluate(() => (window as unknown as { firstScreen: Promise<number> }).firstScreen));
      await expect(window.getByTestId("reply").last()).toHaveText(/第 999 个回答/);
    }
    test.info().annotations.push({ type: "first screen", description: `${timings.map(Math.round).join(", ")} ms` });

    expect(median(timings)).toBeLessThanOrEqual(BUDGET_MS);
  } finally {
    await launched.close();
    await pi.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});
