import { describe, expect, it } from "vitest";
import { formatWhen } from "./recent-sessions";

/** Local time on 2026-10-08 at `hours`:`minutes`. */
function at(hours: number, minutes = 0, day = 8): number {
  return new Date(2026, 9, day, hours, minutes).getTime();
}

describe("formatWhen", () => {
  it("says today or yesterday with the time, and the date before that", () => {
    const now = at(15);

    expect(formatWhen(at(14, 31), now)).toBe("今天 14:31");
    expect(formatWhen(at(0), now)).toBe("今天 00:00");
    expect(formatWhen(at(23, 59, 7), now)).toBe("昨天 23:59");
    expect(formatWhen(at(0, 0, 7), now)).toBe("昨天 00:00");
    expect(formatWhen(at(23, 59, 6), now)).toBe("10月6日");
    expect(formatWhen(new Date(2026, 0, 2).getTime(), now)).toBe("1月2日");
  });
});
