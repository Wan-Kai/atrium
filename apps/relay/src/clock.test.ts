import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { systemClock, trackedTimeout } from "./clock";
import { ResourceTracker } from "./resources";

describe("systemClock", () => {
  it("reads the real time and runs a timer that can be cancelled", async () => {
    const before = Date.now();
    const fired: string[] = [];

    const now = systemClock.now();
    systemClock.setTimeout(() => fired.push("kept"), 1);
    const cancel = systemClock.setTimeout(() => fired.push("cancelled"), 1);
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(fired).toStrictEqual(["kept"]);
  });
});

describe("trackedTimeout", () => {
  it("counts a timer until it fires or is cancelled, once", () => {
    const clock = new FakeClock();
    const resources = new ResourceTracker();
    const fired: number[] = [];

    trackedTimeout(clock, resources, () => fired.push(1), 10);
    const cancel = trackedTimeout(clock, resources, () => fired.push(2), 10);
    expect(resources.snapshot()).toStrictEqual({ timer: 2 });
    cancel();
    cancel();
    clock.advance(10);

    expect(fired).toStrictEqual([1]);
    expect(resources.snapshot()).toStrictEqual({ timer: 0 });
  });
});
