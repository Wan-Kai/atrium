import { expect, test } from "@playwright/test";
import { launchApp, median } from "./launch";

test("@perf connects to the host within 2 seconds of launch (median of 3)", async () => {
  const timings: number[] = [];
  for (let run = 0; run < 3; run++) {
    const launched = await launchApp();
    timings.push(launched.connectedAfterMs);
    await launched.close();
  }

  test.info().annotations.push({ type: "timings", description: timings.join(", ") });
  expect(median(timings)).toBeLessThanOrEqual(2_000);
});
