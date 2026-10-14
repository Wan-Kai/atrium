import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import { ClockContext, type UiClock } from "../state/clock";
import { pageNotices, showNotice } from "../state/session-notices";
import { SessionNoticeLine } from "./session-notice";

afterEach(() => pageNotices().setState(null, true));

/** A timer the held clock was asked for. */
interface HeldTimer {
  readonly ms: number;
  readonly run: () => void;
  cancelled: boolean;
}

/**
 * Fires the timer asked for at `index`.
 *
 * @sideEffects Runs the timer's callback.
 * @param timers - The timers asked for.
 * @param index - Which one.
 * @throws {Error} When there is no such timer.
 */
function fire(timers: readonly HeldTimer[], index: number): void {
  const timer = timers[index];
  if (timer === undefined) throw new Error(`no timer ${index}`);
  timer.run();
}

/**
 * A clock whose timers wait to be fired by hand.
 *
 * @sideEffects none; `after` records its timers.
 * @returns The clock and the timers it was asked for.
 */
function heldClock() {
  const timers: HeldTimer[] = [];
  const clock: UiClock = {
    now: () => 0,
    every: () => () => undefined,
    after: (ms, run) => {
      const timer: HeldTimer = { ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return { clock, timers };
}

/**
 * Renders the line for session s1.
 *
 * @sideEffects Renders.
 * @param clock - The clock.
 * @returns The screen.
 */
async function line(clock: UiClock) {
  return render(
    <ClockContext value={clock}>
      <SessionNoticeLine sessionId="s1" />
    </ClockContext>,
  );
}

/** The colour CSS gives `value`, as computed. */
function colorOf(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

describe("SessionNoticeLine", () => {
  it("says what was done for the session shown, for 3 seconds", async () => {
    const { clock, timers } = heldClock();
    const screen = await line(clock);

    showNotice("s2", "别的会话");
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    showNotice("s1", "已复制最后一条回复");
    await expect.element(screen.getByRole("status")).toHaveTextContent("已复制最后一条回复");
    expect(timers.map((timer) => [timer.ms, timer.cancelled])).toStrictEqual([
      [3000, true],
      [3000, false],
    ]);
    fire(timers, 1);

    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  });

  it("puts a newer notice in place of the older, the older's time not taking it away", async () => {
    const { clock, timers } = heldClock();
    const screen = await line(clock);

    showNotice("s1", "已复制最后一条回复");
    await expect.element(screen.getByRole("status")).toBeVisible();
    showNotice("s1", "已复制最后一条回复");
    await expect.poll(() => timers.length).toBe(2);
    fire(timers, 0);

    expect(pageNotices().getState()?.text).toBe("已复制最后一条回复");
    await expect.element(screen.getByRole("status")).toBeVisible();
    fire(timers, 1);
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  });

  it("keeps a failure in the danger colour until another notice takes its place", async () => {
    const { clock, timers } = heldClock();
    const screen = await line(clock);

    showNotice("s1", "已复制最后一条回复");
    await expect.element(screen.getByRole("status")).toBeVisible();
    expect(getComputedStyle(screen.getByRole("status").element()).color).toBe(colorOf("var(--text-muted)"));
    showNotice("s1", "没能分叉：pi 出错了", true);
    await expect.element(screen.getByRole("status")).toHaveTextContent("没能分叉：pi 出错了");

    expect(getComputedStyle(screen.getByRole("status").element()).color).toBe(colorOf("var(--danger)"));
    expect(timers.map((timer) => [timer.ms, timer.cancelled])).toStrictEqual([[3000, true]]);
  });
});
