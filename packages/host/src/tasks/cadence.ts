import type { Cadence } from "@atrium/protocol";

/*
 * When a schedule rule is due (SPEC-0006, "定时（ScheduleService）" and "T10 定下的细节").
 *
 * Pure functions of a cadence, a time zone and instants in epoch milliseconds: nothing here reads a clock, so the
 * tests drive any day, zone and daylight-saving switch. The service asks two questions: when is the rule due next
 * after an instant (`nextDue`), and which is the latest time at or before now that it should have fired since an
 * instant (`lastDue`).
 */

/** One minute, in milliseconds. */
const MINUTE = 60_000;

/** One day, in milliseconds. */
const DAY = 24 * 60 * MINUTE;

/** A calendar date, with the month from 1. */
interface Day {
  readonly year: number;
  readonly month: number;
  readonly date: number;
}

/** The wall clock of one zone at one instant. */
interface Wall extends Day {
  readonly hour: number;
  readonly minute: number;
  /** 0 for Sunday to 6 for Saturday. */
  readonly weekday: number;
}

/** The formatters of a zone, which are slow to build. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * The formatter that reads a zone's wall clock.
 *
 * @remarks
 * Cached by zone: a rule is asked about once a minute, and building a formatter costs far more than using one.
 *
 * @sideEffects Adds to the cache.
 * @param timeZone - An IANA zone name.
 * @returns The formatter.
 * @throws {RangeError} For a name Intl does not know.
 */
function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let found = FORMATTERS.get(timeZone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    FORMATTERS.set(timeZone, found);
  }
  return found;
}

/** The weekday names `Intl` gives, in the order of `Date#getDay`. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The wall clock of a zone at an instant.
 *
 * @remarks
 * Seconds are dropped: every question here is in whole minutes.
 *
 * @sideEffects none
 * @param ms - The instant.
 * @param timeZone - An IANA zone name.
 * @returns The date and time on the zone's clocks.
 */
export function wallOf(ms: number, timeZone: string): Wall {
  const parts: Record<string, string> = {};
  for (const part of formatterOf(timeZone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    date: Number(parts["day"]),
    hour: Number(parts["hour"]),
    minute: Number(parts["minute"]),
    weekday: WEEKDAYS.indexOf(parts["weekday"] ?? ""),
  };
}

/**
 * A zone's offset from UTC at an instant, in minutes.
 *
 * @remarks
 * Worked out from the wall clock, so it follows the zone's rules for that day.
 *
 * @sideEffects none
 * @param ms - The instant.
 * @param timeZone - An IANA zone name.
 * @returns Minutes east of UTC.
 */
function offsetOf(ms: number, timeZone: string): number {
  const wall = wallOf(ms, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.date, wall.hour, wall.minute);
  return Math.round((asUtc - Math.floor(ms / MINUTE) * MINUTE) / MINUTE);
}

/**
 * The instant a wall-clock time is reached on a day.
 *
 * @remarks
 * SPEC-0006, "定时 · 时间": when the clocks go back and the time is on twice, the first one counts, so the rule
 * fires once; when the clocks go forward and the time does not exist that day, the rule fires at the first minute
 * that does (the moment the clocks jumped).
 *
 * @sideEffects none
 * @param day - The date.
 * @param hour - Hour, 0 to 23.
 * @param minute - Minute, 0 to 59.
 * @param timeZone - An IANA zone name.
 * @returns The instant.
 */
export function instantOf(day: Day, hour: number, minute: number, timeZone: string): number {
  const naive = Date.UTC(day.year, day.month - 1, day.date, hour, minute);
  // The offsets of the day before and the day after bracket any change in between.
  const offsets = new Set([offsetOf(naive - DAY, timeZone), offsetOf(naive + DAY, timeZone)]);
  const exact = [...offsets]
    .map((offset) => naive - offset * MINUTE)
    .filter((candidate) => {
      const wall = wallOf(candidate, timeZone);
      return wall.hour === hour && wall.minute === minute && wall.date === day.date;
    });
  if (exact.length > 0) return Math.min(...exact);
  // The time does not exist: look for the minute the clocks jumped over it.
  let low = naive - DAY;
  let high = naive + DAY;
  const before = offsetOf(low, timeZone);
  while (high - low > MINUTE) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
    if (offsetOf(middle, timeZone) === before) low = middle;
    else high = middle;
  }
  return high;
}

/**
 * Reads `H:MM`.
 *
 * @remarks
 * The protocol's schema has checked the shape.
 *
 * @sideEffects none
 * @param at - The time of day.
 * @returns Hour and minute.
 */
function timeOfDay(at: string): { readonly hour: number; readonly minute: number } {
  const [hour = "0", minute = "0"] = at.split(":");
  return { hour: Number(hour), minute: Number(minute) };
}

/**
 * The calendar date `offset` days from another.
 *
 * @remarks
 * Plain calendar arithmetic, with no zone in it.
 *
 * @sideEffects none
 * @param day - The date.
 * @param offset - Days, negative for earlier.
 * @returns The date.
 */
function shifted(day: Day, offset: number): Day {
  const moved = new Date(Date.UTC(day.year, day.month - 1, day.date + offset));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, date: moved.getUTCDate() };
}

/**
 * The instants a clock-time cadence has on the days around an instant, in order.
 *
 * @remarks
 * A week's rule is on one day in seven, so it looks eight days either side; a day's rule needs only the days
 * next to it, but the same window is simple and cheap.
 *
 * @sideEffects none
 * @param when - A `day` or `week` cadence.
 * @param around - The instant.
 * @param timeZone - An IANA zone name.
 * @returns The slots, ascending.
 */
function slotsAround(when: Extract<Cadence, { every: "day" | "week" }>, around: number, timeZone: string): number[] {
  const { hour, minute } = timeOfDay(when.at);
  const today = wallOf(around, timeZone);
  const slots: number[] = [];
  for (let offset = -8; offset <= 8; offset += 1) {
    const day = shifted(today, offset);
    if (when.every === "week") {
      const weekday = (((today.weekday + offset) % 7) + 7) % 7;
      if (weekday !== when.day) continue;
    }
    slots.push(instantOf(day, hour, minute, timeZone));
  }
  return slots.toSorted((a, b) => a - b);
}

/**
 * The first time a cadence fires after an instant.
 *
 * @remarks
 * An interval counts from `anchor` (the moment the rule was made); a clock-time cadence ignores it.
 *
 * @sideEffects none
 * @param when - The cadence.
 * @param after - The instant; the answer is later.
 * @param anchor - Where an interval starts counting.
 * @param timeZone - An IANA zone name.
 * @returns The instant.
 */
export function nextDue(when: Cadence, after: number, anchor: number, timeZone: string): number {
  if (when.every === "interval") {
    const step = when.minutes * MINUTE;
    return anchor + (Math.max(0, Math.floor((after - anchor) / step)) + 1) * step;
  }
  const next = slotsAround(when, after, timeZone).find((slot) => slot > after);
  // Stryker disable next-line all: a week holds a slot, so the window always has one past `after`.
  return next ?? after + DAY;
}

/**
 * The latest time a cadence should have fired in (`since`, `now`], or `null` when there is none.
 *
 * @remarks
 * However many times it should have fired, only this one is returned: the service catches up once
 * (SPEC-0006, "定时 · 错过"). A `since` later than `now` (the system clock was set back) leaves nothing due.
 *
 * @sideEffects none
 * @param when - The cadence.
 * @param since - The instant after which a trigger counts: the later of the last trigger and the rule's creation.
 * @param now - The present.
 * @param anchor - Where an interval starts counting.
 * @param timeZone - An IANA zone name.
 * @returns The instant, or `null`.
 */
export function lastDue(when: Cadence, since: number, now: number, anchor: number, timeZone: string): number | null {
  if (since >= now) return null;
  if (when.every === "interval") {
    const step = when.minutes * MINUTE;
    const slot = anchor + Math.floor((now - anchor) / step) * step;
    return slot > since && slot <= now ? slot : null;
  }
  const slots = slotsAround(when, now, timeZone).filter((slot) => slot > since && slot <= now);
  return slots.length === 0 ? null : (slots[slots.length - 1] ?? null);
}

/**
 * The machine's time zone.
 *
 * @remarks
 * What the process's `TZ` and the system say; production code asks it once and hands it to the service, and tests
 * give a zone of their own.
 *
 * @sideEffects none
 * @returns An IANA zone name.
 */
export function localTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}
