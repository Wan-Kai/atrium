import { describe, expect, it } from "vitest";
import { instantOf, lastDue, localTimeZone, nextDue, wallOf } from "./cadence";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** An instant from its parts in UTC. */
const utc = (y: number, m: number, d: number, h = 0, min = 0): number => Date.UTC(y, m - 1, d, h, min);

describe("nextDue: a clock time of day", () => {
  it("is the next 2:00 on the machine's clocks, in the zone given", () => {
    const at = { every: "day", at: "2:00" } as const;
    // 2026-11-09 10:00 in Shanghai (UTC+8) is 02:00 UTC.
    const after = utc(2026, 11, 9, 2, 0);
    expect(nextDue(at, after, 0, "Asia/Shanghai")).toBe(utc(2026, 11, 9, 18, 0));
    // The same instant on New York's clocks (UTC-5) reads 21:00 on the 8th, so 2:00 is five hours away.
    expect(nextDue(at, after, 0, "America/New_York")).toBe(utc(2026, 11, 9, 7, 0));
  });

  it("is strictly after the instant given", () => {
    const at = { every: "day", at: "10:00" } as const;
    const ten = utc(2026, 11, 9, 2, 0);
    expect(nextDue(at, ten, 0, "Asia/Shanghai")).toBe(ten + 24 * HOUR);
  });

  it("finds the weekday: Monday at 10:00", () => {
    const at = { every: "week", day: 1, at: "10:00" } as const;
    // 2026-11-09 is a Monday; 10:00 Shanghai is 02:00 UTC.
    expect(nextDue(at, utc(2026, 11, 9, 3, 0), 0, "Asia/Shanghai")).toBe(utc(2026, 11, 16, 2, 0));
    expect(nextDue(at, utc(2026, 11, 9, 1, 0), 0, "Asia/Shanghai")).toBe(utc(2026, 11, 9, 2, 0));
    // Sunday is 0.
    expect(nextDue({ every: "week", day: 0, at: "0:30" }, utc(2026, 11, 9, 3, 0), 0, "UTC")).toBe(
      utc(2026, 11, 15, 0, 30),
    );
  });
});

describe("nextDue and lastDue: an interval", () => {
  it("counts from the anchor, every so many minutes", () => {
    const every = { every: "interval", minutes: 5 } as const;
    const anchor = utc(2026, 11, 9, 10, 2);
    expect(nextDue(every, anchor, anchor, "UTC")).toBe(anchor + 5 * MINUTE);
    expect(nextDue(every, anchor + 7 * MINUTE, anchor, "UTC")).toBe(anchor + 10 * MINUTE);
    expect(nextDue(every, anchor - 3 * MINUTE, anchor, "UTC")).toBe(anchor + 5 * MINUTE);
    expect(lastDue(every, anchor, anchor + 7 * MINUTE, anchor, "UTC")).toBe(anchor + 5 * MINUTE);
    expect(lastDue(every, anchor, anchor + 4 * MINUTE, anchor, "UTC")).toBeNull();
    expect(lastDue(every, anchor + 5 * MINUTE, anchor + 5 * MINUTE, anchor, "UTC")).toBeNull();
  });

  it("names only the latest of the triggers missed", () => {
    const every = { every: "interval", minutes: 5 } as const;
    const anchor = utc(2026, 11, 9, 10, 0);
    expect(lastDue(every, anchor, anchor + 17 * MINUTE, anchor, "UTC")).toBe(anchor + 15 * MINUTE);
  });
});

describe("lastDue: a clock time of day", () => {
  const at = { every: "day", at: "2:00" } as const;

  it("is null when the time has not come since the last trigger", () => {
    const since = utc(2026, 11, 9, 2, 0);
    expect(lastDue(at, since, since + 5 * HOUR, 0, "UTC")).toBeNull();
  });

  it("is the latest trigger, when several days were missed", () => {
    const since = utc(2026, 11, 1, 2, 0);
    expect(lastDue(at, since, utc(2026, 11, 5, 12, 0), 0, "UTC")).toBe(utc(2026, 11, 5, 2, 0));
  });

  it("counts a trigger exactly at now", () => {
    expect(lastDue(at, utc(2026, 11, 8, 12, 0), utc(2026, 11, 9, 2, 0), 0, "UTC")).toBe(utc(2026, 11, 9, 2, 0));
  });

  it("finds nothing when the system clock was set back before the last trigger", () => {
    const since = utc(2026, 11, 9, 10, 0);
    expect(lastDue(at, since, since - 3 * HOUR, 0, "UTC")).toBeNull();
    expect(lastDue({ every: "interval", minutes: 5 }, since, since - 3 * HOUR, 0, "UTC")).toBeNull();
  });

  it("looks a week back for a weekly rule", () => {
    const week = { every: "week", day: 3, at: "9:00" } as const;
    // 2026-11-04 is a Wednesday.
    expect(lastDue(week, utc(2026, 10, 28, 12, 0), utc(2026, 11, 8, 12, 0), 0, "UTC")).toBe(utc(2026, 11, 4, 9, 0));
  });
});

describe("daylight saving time (SPEC-0006, 定时 · 时间)", () => {
  it("skips to the first minute that exists when the clocks go forward over the time", () => {
    // New York, 2026-03-08: 02:00 EST jumps to 03:00 EDT, so 02:30 does not exist. The jump is at 07:00 UTC.
    expect(instantOf({ year: 2026, month: 3, date: 8 }, 2, 30, "America/New_York")).toBe(utc(2026, 3, 8, 7, 0));
    const at = { every: "day", at: "2:30" } as const;
    expect(nextDue(at, utc(2026, 3, 8, 5, 0), 0, "America/New_York")).toBe(utc(2026, 3, 8, 7, 0));
    // The day after it is 2:30 EDT = 06:30 UTC.
    expect(nextDue(at, utc(2026, 3, 8, 7, 0), 0, "America/New_York")).toBe(utc(2026, 3, 9, 6, 30));
    // The day before it is 2:30 EST = 07:30 UTC.
    expect(nextDue(at, utc(2026, 3, 7, 0, 0), 0, "America/New_York")).toBe(utc(2026, 3, 7, 7, 30));
  });

  it("fires once when the clocks go back over the time, at its first occurrence", () => {
    // New York, 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:30 happens twice (05:30 UTC and 06:30 UTC).
    const at = { every: "day", at: "1:30" } as const;
    expect(nextDue(at, utc(2026, 11, 1, 0, 0), 0, "America/New_York")).toBe(utc(2026, 11, 1, 5, 30));
    // Having fired at the first, the second does not count; the next is tomorrow's, 01:30 EST = 06:30 UTC.
    expect(nextDue(at, utc(2026, 11, 1, 5, 30), 0, "America/New_York")).toBe(utc(2026, 11, 2, 6, 30));
    expect(lastDue(at, utc(2026, 11, 1, 5, 30), utc(2026, 11, 1, 6, 45), 0, "America/New_York")).toBeNull();
  });

  it("keeps a time that is fine all year at the same wall clock across the switch", () => {
    const at = { every: "day", at: "9:00" } as const;
    expect(nextDue(at, utc(2026, 3, 7, 15, 0), 0, "America/New_York")).toBe(utc(2026, 3, 8, 13, 0));
    expect(nextDue(at, utc(2026, 3, 8, 13, 0), 0, "America/New_York")).toBe(utc(2026, 3, 9, 13, 0));
  });

  it("does not count an interval's minutes as clock time", () => {
    const every = { every: "interval", minutes: 60 } as const;
    const anchor = utc(2026, 3, 8, 5, 0);
    expect(nextDue(every, anchor + 2 * HOUR, anchor, "America/New_York")).toBe(anchor + 3 * HOUR);
  });
});

describe("wallOf", () => {
  it("reads the date, the time and the weekday on a zone's clocks", () => {
    expect(wallOf(utc(2026, 11, 9, 16, 5), "Asia/Shanghai")).toStrictEqual({
      year: 2026,
      month: 11,
      date: 10,
      hour: 0,
      minute: 5,
      weekday: 2,
    });
  });
});

describe("localTimeZone", () => {
  it("is the zone the process runs in, a name wallOf can read", () => {
    const zone = localTimeZone();
    expect(zone).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(wallOf(0, zone).year).toBeGreaterThanOrEqual(1969);
  });
});
