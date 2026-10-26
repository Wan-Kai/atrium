import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { SlidingWindowLimit } from "./rate-limit";
import { ResourceTracker } from "./resources";

/**
 * A limit of 3 per 60 seconds on a fake clock.
 *
 * @remarks
 * Small enough to reach in a test.
 *
 * @sideEffects none
 * @param limit - Events per window.
 * @returns The limit, its clock and its counters.
 */
function limitOf(limit = 3): { limiter: SlidingWindowLimit; clock: FakeClock; resources: ResourceTracker } {
  const clock = new FakeClock(1_000_000);
  const resources = new ResourceTracker();
  return { limiter: new SlidingWindowLimit(clock, resources, limit, 60_000), clock, resources };
}

describe("SlidingWindowLimit", () => {
  it("allows `limit` events per key and refuses the next, per key", () => {
    const { limiter } = limitOf();

    const first = [limiter.take("a"), limiter.take("a"), limiter.take("a"), limiter.take("a")];

    expect(first).toStrictEqual([true, true, true, false]);
    expect(limiter.take("b")).toBe(true);
  });

  it("slides: an event frees its slot exactly a window after it happened", () => {
    const { limiter, clock } = limitOf(2);
    limiter.take("a");
    clock.advance(30_000);
    limiter.take("a");

    clock.advance(29_999);
    expect(limiter.take("a")).toBe(false);
    clock.advance(1);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("does not count refused attempts", () => {
    const { limiter, clock } = limitOf(1);
    limiter.take("a");
    clock.advance(59_000);
    limiter.take("a");

    clock.advance(1_000);

    expect(limiter.take("a")).toBe(true);
  });

  it("forgets keys once their window passed and stops its timer", () => {
    const { limiter, clock, resources } = limitOf();
    limiter.take("a");
    clock.advance(30_000);
    limiter.take("b");

    clock.advance(30_000);
    expect(limiter.size).toBe(1);
    expect(resources.snapshot()).toStrictEqual({ timer: 1 });
    clock.advance(60_000);

    expect(limiter.size).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
    expect(resources.snapshot()).toStrictEqual({ timer: 0 });
  });

  it("holds nothing and allows everything when the limit is 0", () => {
    const { limiter, clock } = limitOf(0);

    const results = Array.from({ length: 100 }, () => limiter.take("a"));

    expect(results.every(Boolean)).toBe(true);
    expect(limiter.size).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("clears every key and its timer", () => {
    const { limiter, clock, resources } = limitOf();
    limiter.take("a");

    limiter.clear();

    expect(limiter.size).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
    expect(resources.snapshot()).toStrictEqual({ timer: 0 });
    expect(limiter.take("a")).toBe(true);
  });
});
