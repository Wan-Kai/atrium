import { describe, expect, it } from "vitest";
import { PRESS_MS, VisualPresses } from "./visual-presses";

/** Two frames' elements, as `elementFromPoint` would find them. */
const first = { name: "first" };
const second = { name: "second" };

describe("VisualPresses", () => {
  it("takes a fresh press on the frame once", () => {
    const presses = new VisualPresses<object>();
    presses.pressed(first, 1000);

    expect([presses.spend(first, 1000 + PRESS_MS), presses.spend(first, 1000 + PRESS_MS)]).toStrictEqual([true, false]);
  });

  it("refuses a press on anything else, too old, or none, and keeps one on another frame for that frame", () => {
    const presses = new VisualPresses<object>();
    expect(presses.spend(first, 0)).toBe(false);
    presses.pressed(null, 0);
    expect(presses.spend(first, 0)).toBe(false);
    presses.pressed(second, 0);
    expect(presses.spend(first, 0)).toBe(false);
    expect(presses.spend(second, 0)).toBe(true);
    presses.pressed(first, 0);
    expect(presses.spend(first, PRESS_MS + 1)).toBe(false);
    expect(PRESS_MS).toBe(5000);
  });

  it("tells whether a fresh press on the frame is there without spending it", () => {
    const presses = new VisualPresses<object>();
    presses.pressed(first, 0);

    expect([presses.has(second, 0), presses.has(first, PRESS_MS + 1), presses.has(first, 0)]).toStrictEqual([
      false,
      false,
      true,
    ]);
    expect(presses.spend(first, 0)).toBe(true);
  });
});
