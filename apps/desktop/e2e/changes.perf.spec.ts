import { createGitScene } from "@atrium/testkit";
import { type CDPSession, type Page, expect, test } from "@playwright/test";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { addProject } from "./projects";

/** The longest any one step of drawing a frame may take, in milliseconds (testing.md, "性能预算"). */
const BUDGET_MS = 4;

/** The renderer's steps of drawing a frame that a trace times, and the scripts run before them. */
const STEPS = ["FunctionCall", "UpdateLayoutTree", "Layout", "PrePaint", "Paint"];

/** A trace event, as much of it as is read. */
interface TraceEvent {
  readonly name: string;
  readonly dur?: number;
}

/**
 * Writes 40 new files of 500 lines each into the repository, about 20,000 lines of diff.
 *
 * @sideEffects Creates the files.
 * @param repo - The repository.
 */
async function writeLargeChange(repo: string): Promise<void> {
  for (let file = 0; file < 40; file++) {
    const lines = Array.from(
      { length: 500 },
      (_, line) => `const value${line} = compute(${line}, "${"x".repeat(line % 50)}"); // ${file}:${line}`,
    );
    await writeFile(join(repo, `file-${String(file).padStart(2, "0")}.ts`), `${lines.join("\n")}\n`);
  }
}

/**
 * Presses a key and times each step of drawing the frames over the next 0.6 s.
 *
 * @remarks
 * Times steps rather than frame intervals, which a 60Hz screen makes 16.7 ms whatever the work
 * (testing.md, "性能预算"). 0.6 s covers a 0.24 s animation and what follows it.
 *
 * @sideEffects Presses the key; traces the renderer.
 * @param page - The window.
 * @param cdp - A DevTools session on it.
 * @param key - The key to press.
 * @returns The longest each step took, in milliseconds, by step.
 */
async function longestSteps(page: Page, cdp: CDPSession, key: string): Promise<Record<string, number>> {
  const events: TraceEvent[] = [];
  /** Keeps the events the trace hands over. */
  const keep = ({ value }: { value: object[] }): void => {
    events.push(...(value as TraceEvent[]));
  };
  cdp.on("Tracing.dataCollected", keep);
  await cdp.send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
  await page.keyboard.press(key);
  await page.waitForTimeout(600);
  const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  await complete;
  cdp.off("Tracing.dataCollected", keep);
  return Object.fromEntries(
    STEPS.map((step) => [
      step,
      Math.max(0, ...events.filter((event) => event.name === step).map((event) => (event.dur ?? 0) / 1000)),
    ]),
  );
}

test(`@perf folds and unfolds the sidebar beside a 20,000-line diff, no step of a frame over ${BUDGET_MS} ms`, async () => {
  test.setTimeout(240_000);
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "好的" }] }] });
  const scene = await createGitScene("e2e-changes-perf");
  const repo = await realpath(scene.repo);
  await writeLargeChange(repo);
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, repo);
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("一");
    await box.press("Enter");
    await expect(window.getByTestId("reply")).toHaveText("好的", { timeout: 30_000 });
    await window.getByRole("button", { name: "查看改动" }).click({ timeout: 30_000 });
    const panel = window.getByRole("complementary", { name: "改动" });
    await expect(panel.getByRole("region", { name: "file-39.ts" })).toBeVisible({ timeout: 60_000 });
    await window.waitForTimeout(1000);
    const cdp = await window.context().newCDPSession(window);

    const fold = await longestSteps(window, cdp, "Meta+b");
    const unfold = await longestSteps(window, cdp, "Meta+b");
    test.info().annotations.push({ type: "longest steps", description: JSON.stringify({ fold, unfold }) });

    await expect(panel).toBeVisible();
    expect([fold, unfold].flatMap((steps) => Object.entries(steps).filter(([, ms]) => ms > BUDGET_MS))).toStrictEqual(
      [],
    );
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
