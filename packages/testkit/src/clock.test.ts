import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock";

describe("FakeClock", () => {
  it("fires due timers in due order and leaves later ones pending", () => {
    const clock = new FakeClock(1000);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push(`b@${clock.now()}`), 200);
    clock.setTimeout(() => fired.push(`a@${clock.now()}`), 100);
    clock.setTimeout(() => fired.push(`c@${clock.now()}`), 500);

    clock.advance(300);

    expect(fired).toStrictEqual(["a@1100", "b@1200"]);
    expect(clock.now()).toBe(1300);
    expect(clock.pendingTimers()).toBe(1);
  });

  it("runs timers scheduled by a callback when they fall inside the window", () => {
    const clock = new FakeClock();
    const fired: number[] = [];
    clock.setTimeout(() => {
      fired.push(clock.now());
      clock.setTimeout(() => fired.push(clock.now()), 50);
    }, 100);

    clock.advance(200);

    expect(fired).toStrictEqual([100, 150]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("fires timers due at the same moment in the order they were scheduled", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("first"), 50);
    clock.setTimeout(() => fired.push("second"), 50);
    clock.setTimeout(() => fired.push("third"), 50);

    clock.advance(50);

    expect(fired).toStrictEqual(["first", "second", "third"]);
  });

  it("keeps other timers pending when one is cancelled", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    const cancel = clock.setTimeout(() => fired.push("cancelled"), 10);
    clock.setTimeout(() => fired.push("kept"), 10);

    cancel();
    clock.advance(10);

    expect(fired).toStrictEqual(["kept"]);
  });

  it("does not fire a cancelled timer", () => {
    const clock = new FakeClock();
    const fired: number[] = [];
    const cancel = clock.setTimeout(() => fired.push(1), 10);

    cancel();
    clock.advance(100);

    expect(fired).toStrictEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });
});
