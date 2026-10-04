import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { trackedTimeout } from "./clock";
import { ResourceTracker } from "./resources";

describe("trackedTimeout", () => {
  it("counts the timer until it fires, then runs the callback once", () => {
    const clock = new FakeClock();
    const resources = new ResourceTracker();
    let calls = 0;

    trackedTimeout(clock, resources, () => calls++, 100);
    const whilePending = resources.snapshot();
    clock.advance(100);

    expect(whilePending).toStrictEqual({ timer: 1 });
    expect(resources.snapshot()).toStrictEqual({ timer: 0 });
    expect(calls).toBe(1);
  });

  it("releases the count and skips the callback when cancelled", () => {
    const clock = new FakeClock();
    const resources = new ResourceTracker();
    let calls = 0;

    const cancel = trackedTimeout(clock, resources, () => calls++, 100);
    cancel();
    clock.advance(200);

    expect(resources.snapshot()).toStrictEqual({ timer: 0 });
    expect(calls).toBe(0);
  });

  it("does not release twice when cancelled after firing", () => {
    const clock = new FakeClock();
    const resources = new ResourceTracker();
    const cancel = trackedTimeout(clock, resources, () => undefined, 10);
    trackedTimeout(clock, resources, () => undefined, 1_000);

    clock.advance(10);
    cancel();

    expect(resources.snapshot()).toStrictEqual({ timer: 1 });
  });
});
