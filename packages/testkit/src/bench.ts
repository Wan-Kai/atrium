import { existsSync } from "node:fs";
import type { Bench } from "vitest";

/** Slowdown against the baseline that prints a warning. */
const WARN_RATIO = 1.2;

/**
 * Benchmarks `fn` and compares its median latency with the baseline saved on this machine.
 *
 * @remarks
 * Benchmarks only warn at a 20% slowdown, because timings depend on machine load
 * (testing.md, "基准与长时间运行"); the caller asserts a much looser bound to catch real
 * regressions. Baselines are per machine, so they live in the git-ignored `.bench/` folder; the
 * first run, or a run with `BENCH_UPDATE=1`, records a new one instead of comparing.
 *
 * @sideEffects Runs the benchmark; may write the baseline file; prints a warning when slower than
 * the warning threshold.
 * @param bench - The `bench` fixture of the current test.
 * @param name - Benchmark name.
 * @param baselineFile - Baseline path relative to the repository root, under `.bench/`.
 * @param fn - Code to measure.
 * @returns The ratio of current to baseline median latency; 1 when this run recorded the baseline.
 */
export async function compareWithBaseline(
  bench: Bench,
  name: string,
  baselineFile: string,
  fn: () => unknown,
): Promise<number> {
  if (process.env["BENCH_UPDATE"] === "1" || !existsSync(baselineFile)) {
    await bench(name, { writeResult: baselineFile }, fn).run();
    return 1;
  }
  const results = await bench.compare(bench(name, fn), bench.from("baseline", baselineFile));
  const ratio = results.get(name).latency.p50 / results.get("baseline").latency.p50;
  if (ratio > WARN_RATIO) {
    console.warn(`benchmark "${name}" is ${(ratio * 100 - 100).toFixed(0)}% slower than its baseline`);
  }
  return ratio;
}
