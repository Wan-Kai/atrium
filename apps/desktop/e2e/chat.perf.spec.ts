import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp, median } from "./launch";

/** One section of a long reply: a table, code, a diff and formulas (testing.md, "性能预算"). */
function section(index: number): string {
  return [
    `## 第 ${index} 节`,
    "",
    "| 模块 | 职责 | 行数 |",
    "|---|---|---:|",
    `| protocol | 命令和事件 | ${400 + index} |`,
    `| host | 宿主与会话 | ${3000 + index} |`,
    "",
    "```ts",
    `export function sum${index}(values: readonly number[]): number {`,
    "  return values.reduce((total, value) => total + value, 0);",
    "}",
    "```",
    "",
    "```diff",
    `- const before = ${index};`,
    `+ const after = ${index + 1};`,
    "```",
    "",
    String.raw`行内公式 \(a^2 + b^2 = c^2\)，**注意：**块公式如下。`,
    "",
    "$$",
    String.raw`\sum_{k=1}^{n} k = \frac{n(n+1)}{2}`,
    "$$",
    "",
  ].join("\n");
}

const LONG_REPLY = Array.from({ length: 6 }, (_, index) => section(index + 1)).join("\n");

/** What the page measured while the reply streamed. */
interface Measured {
  readonly longTasks: number[];
  readonly frames: number[];
}

/**
 * The 95th percentile of a list.
 *
 * @remarks
 * Nearest-rank, so the result is one of the measured values.
 */
function p95(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

/**
 * Starts recording long tasks and frame intervals in the page.
 *
 * @remarks
 * Runs inside the renderer, so it must not use anything from this module.
 */
function startMeasuring(): void {
  const measured = { longTasks: [] as number[], frames: [] as number[], stop: false };
  (window as unknown as { measured: typeof measured }).measured = measured;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) measured.longTasks.push(entry.duration);
  }).observe({ type: "longtask" });
  let last = performance.now();
  /** Records the interval since the previous frame and asks for the next one until stopped. */
  const frame = (now: number): void => {
    measured.frames.push(now - last);
    last = now;
    if (!measured.stop) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/**
 * Stops recording and returns what the page measured.
 *
 * @remarks
 * The first interval runs from setup to the first frame, not between two frames, so it is dropped.
 */
function stopMeasuring(): Measured {
  const state = (window as unknown as { measured: Measured & { stop: boolean } }).measured;
  state.stop = true;
  return { longTasks: state.longTasks, frames: state.frames.slice(1) };
}

test("@perf streams a long Markdown reply at 50 tok/s without long tasks or slow frames (median of 3)", async () => {
  test.setTimeout(240_000);
  const longest: number[] = [];
  const frameP95: number[] = [];
  for (let run = 0; run < 3; run++) {
    const pi = await fauxPiEnvironment({
      tokensPerSecond: 50,
      replies: [{ blocks: [{ type: "text", text: LONG_REPLY }] }],
    });
    const launched = await launchApp(pi.env);
    try {
      const { window } = launched;
      await window.evaluate(startMeasuring);
      await window.getByRole("textbox", { name: "消息" }).fill("写一份长的说明");
      await window.getByRole("textbox", { name: "消息" }).press("Enter");
      await expect(window.locator('[data-testid="assistant-message"][data-streaming="true"]')).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(window.locator('[data-testid="assistant-message"][data-streaming="false"]')).toHaveCount(1, {
        timeout: 120_000,
      });
      const measured = await window.evaluate(stopMeasuring);
      longest.push(Math.max(0, ...measured.longTasks));
      frameP95.push(p95(measured.frames));
      test.info().annotations.push({
        type: `run ${run + 1}`,
        description: `long tasks ${JSON.stringify(measured.longTasks.map(Math.round))}, frames ${measured.frames.length}, p95 ${p95(measured.frames).toFixed(2)} ms`,
      });
    } finally {
      await launched.close();
      await pi.cleanup();
    }
  }

  expect(median(longest)).toBeLessThanOrEqual(50);
  expect(median(frameP95)).toBeLessThanOrEqual(16.7);
});
