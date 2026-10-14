import { createGitScene } from "@atrium/testkit";
import { type CDPSession, type Locator, type Page, expect, test } from "@playwright/test";
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
 * Does something and times each step of drawing the frames meanwhile.
 *
 * @remarks
 * Times steps rather than frame intervals, which a 60Hz screen makes 16.7 ms whatever the work
 * (testing.md, "性能预算").
 *
 * @sideEffects Does it; traces the renderer.
 * @param cdp - A DevTools session on the window.
 * @param action - What to do.
 * @returns The longest each step took, in milliseconds, by step.
 */
async function longestSteps(cdp: CDPSession, action: () => Promise<unknown>): Promise<Record<string, number>> {
  const events: TraceEvent[] = [];
  /** Keeps the events the trace hands over. */
  const keep = ({ value }: { value: object[] }): void => {
    events.push(...(value as TraceEvent[]));
  };
  cdp.on("Tracing.dataCollected", keep);
  await cdp.send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
  await action();
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

/** The longest switching tabs may take, in milliseconds (testing.md, "性能预算"). */
const SWITCH_MS = 100;

/**
 * Presses a key and waits 0.6 s, which covers a 0.24 s animation and what follows it.
 *
 * @sideEffects Presses the key.
 * @param page - The window.
 * @param key - The key.
 */
async function pressAndWait(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await page.waitForTimeout(600);
}

/**
 * Launches Atrium on a repository with about 20,000 lines of diff, the 改动 tab open and coloured.
 *
 * @sideEffects Creates a repository and a faux pi; launches the app; cleans all up after `run`.
 * @param run - What to do with the window and the 改动 tab.
 */
async function withLargeChange(run: (window: Page, viewer: Locator) => Promise<void>): Promise<void> {
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
    await window
      .getByRole("complementary", { name: "文件与更改" })
      .getByTestId("changes-tree")
      .getByRole("button", { name: /file-00\.ts/ })
      .click({ timeout: 60_000 });
    const viewer = window.getByRole("region", { name: "改动" });
    // Coloured a file at a time, the last file last: all are coloured once it is.
    await expect(viewer.locator('section[data-path="file-39.ts"] span[style]').first()).toBeAttached({
      timeout: 120_000,
    });
    await window.waitForTimeout(1000);
    await run(window, viewer);
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
}

/**
 * Starts timing from the next press of a tab and resolves once what it shows is drawn.
 *
 * @remarks
 * Runs inside the renderer, so it must not use anything from this module. Drawn is once an
 * element matching the selector is in the page and two frames have passed.
 *
 * @sideEffects Listens for the press; observes the page; sets `window.switched`.
 * @param selector - What the tab shows.
 */
function timeSwitch(selector: string): void {
  const page = window as unknown as { switched: Promise<number> };
  page.switched = new Promise((resolve) => {
    let start = 0;
    document.addEventListener(
      "pointerdown",
      () => {
        start = performance.now();
      },
      { capture: true, once: true },
    );
    const observer = new MutationObserver(() => {
      if (start === 0 || document.querySelector(selector) === null) return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Scrolls the 改动 tab to its end with the mouse wheel, 400px a turn, as a hand on a trackpad would.
 *
 * @remarks
 * Wheel events scroll as the user does, on the compositor; setting `scrollTop` from a script
 * would lay out in the script and time the test rather than the tab.
 *
 * @sideEffects Moves the mouse over the tab and turns the wheel.
 * @throws When 2000 turns do not bring it to its end.
 * @param page - The window.
 * @param viewer - The 改动 tab.
 */
async function scrollThrough(page: Page, viewer: Locator): Promise<void> {
  const body = viewer.getByTestId("viewer-body");
  const box = await body.boundingBox();
  if (box === null) throw new Error("no 改动 tab");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  /** Whether the tab is scrolled to its end. */
  const atEnd = (): Promise<boolean> =>
    body.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1);
  for (let turns = 0; turns % 50 !== 0 || !(await atEnd()); turns++) {
    if (turns > 2000) throw new Error("the 改动 tab never came to its end");
    await page.mouse.wheel(0, 400);
  }
}

/**
 * The middle of a few values.
 *
 * @sideEffects none
 * @param values - The values.
 * @returns The median, nearest-rank.
 */
function median(values: readonly number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

/**
 * Each step's median over a few runs' longest.
 *
 * @sideEffects none
 * @param runs - Each run's longest steps, from `longestSteps`.
 * @returns The medians, by step.
 */
function medianSteps(runs: readonly Record<string, number>[]): Record<string, number> {
  return Object.fromEntries(STEPS.map((step) => [step, median(runs.map((each) => each[step] ?? 0))]));
}

test(`@perf folds and unfolds the sidebar beside a 20,000-line 改动 tab, no step of a frame over ${BUDGET_MS} ms`, async () => {
  test.setTimeout(240_000);
  await withLargeChange(async (window, viewer) => {
    const cdp = await window.context().newCDPSession(window);

    const fold = await longestSteps(cdp, () => pressAndWait(window, "Meta+b"));
    const unfold = await longestSteps(cdp, () => pressAndWait(window, "Meta+b"));
    test.info().annotations.push({ type: "longest steps", description: JSON.stringify({ fold, unfold }) });

    await expect(viewer).toBeVisible();
    expect([fold, unfold].flatMap((steps) => Object.entries(steps).filter(([, ms]) => ms > BUDGET_MS))).toStrictEqual(
      [],
    );
  });
});

test(`@perf switches between a session and a 20,000-line 改动 tab within ${SWITCH_MS} ms (median of 3)`, async () => {
  test.setTimeout(240_000);
  await withLargeChange(async (window) => {
    const tabs = window.getByRole("tablist", { name: "打开的会话" }).getByRole("tab");
    const toSession: number[] = [];
    const toChanges: number[] = [];
    for (let run = 0; run < 3; run++) {
      await window.evaluate(timeSwitch, '[data-testid="reply"]');
      await tabs.first().click();
      toSession.push(await window.evaluate(() => (window as unknown as { switched: Promise<number> }).switched));
      await window.evaluate(timeSwitch, 'section[data-path="file-00.ts"] [data-kind]');
      await tabs.filter({ hasText: "改动" }).click();
      toChanges.push(await window.evaluate(() => (window as unknown as { switched: Promise<number> }).switched));
    }
    test.info().annotations.push({ type: "switches", description: JSON.stringify({ toSession, toChanges }) });

    expect([median(toSession), median(toChanges)].filter((ms) => ms > SWITCH_MS)).toStrictEqual([]);
  });
});

test(`@perf scrolls a 20,000-line 改动 tab to its end, no step of a frame over ${BUDGET_MS} ms (median of 3)`, async () => {
  test.setTimeout(300_000);
  await withLargeChange(async (window, viewer) => {
    const cdp = await window.context().newCDPSession(window);
    const runs: Record<string, number>[] = [];
    for (let run = 0; run < 3; run++) {
      // Back at the top at once: the groups scrolled past are laid out afresh as they come into view again.
      await viewer.getByTestId("viewer-body").evaluate((element) => element.scrollTo(0, 0));
      await window.waitForTimeout(500);
      runs.push(await longestSteps(cdp, () => scrollThrough(window, viewer)));
    }
    const steps = medianSteps(runs);
    test.info().annotations.push({ type: "scroll", description: JSON.stringify(runs) });

    expect(Object.entries(steps).filter(([, ms]) => ms > BUDGET_MS)).toStrictEqual([]);
  });
});
