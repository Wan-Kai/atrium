import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { ClockContext, type UiClock } from "../state/clock";
import { type ArchiveToast, ArchiveToasts, pushToast } from "./archive-toasts";

/** A timer the held clock was asked for. */
interface HeldTimer {
  readonly ms: number;
  readonly run: () => void;
  cancelled: boolean;
}

/**
 * A clock whose time is set by hand and whose timers wait to be fired by hand.
 *
 * @sideEffects none; `after` records its timers.
 * @returns The clock, the timers it was asked for, and a way to set the time.
 */
function heldClock() {
  const timers: HeldTimer[] = [];
  let time = 0;
  const clock: UiClock = {
    now: () => time,
    every: () => () => undefined,
    after: (ms, run) => {
      const timer: HeldTimer = { ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return {
    clock,
    timers,
    at: (ms: number) => {
      time = ms;
    },
  };
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
 * Renders the toasts, recording which are gone.
 *
 * @sideEffects Renders.
 * @param clock - The clock.
 * @param toasts - The toasts.
 * @returns The screen and the ids told gone.
 */
async function toastsOn(clock: UiClock, toasts: readonly ArchiveToast[]) {
  await page.viewport(1280, 820);
  const gone: number[] = [];
  const screen = await render(
    <ClockContext value={clock}>
      <ArchiveToasts toasts={toasts} onGone={(id) => gone.push(id)} />
    </ClockContext>,
  );
  return { screen, gone };
}

/**
 * Waits for the toasts' entrance to finish, so they stand where they stay.
 *
 * @sideEffects none
 * @param elements - The toasts.
 */
async function settled(elements: readonly Element[]): Promise<void> {
  await Promise.all(elements.flatMap((element) => element.getAnimations().map((animation) => animation.finished)));
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

describe("ArchiveToasts", () => {
  it("says a worktree was archived for 3 seconds, then leaves in 0.2 seconds", async () => {
    const { clock, timers } = heldClock();
    const { screen, gone } = await toastsOn(clock, [{ id: 1, name: "fix/typo" }]);
    const toast = screen.getByRole("status");

    await expect.element(toast).toHaveTextContent("已归档「fix/typo」");
    expect(getComputedStyle(toast.element().querySelector("svg") as Element).color).toBe(colorOf("var(--ok-text)"));
    expect(timers.map((timer) => timer.ms)).toStrictEqual([3000]);
    fire(timers, 0);

    await expect.element(toast).toHaveAttribute("data-leaving", "true");
    expect(timers.map((timer) => timer.ms)).toStrictEqual([3000, 200]);
    expect(gone).toStrictEqual([]);
    fire(timers, 1);
    expect(gone).toStrictEqual([1]);
  });

  it("says why archiving failed, as an alert in the danger colour, for 6 seconds", async () => {
    const { clock, timers } = heldClock();
    const { screen } = await toastsOn(clock, [{ id: 1, name: "fix/typo", reason: "git 没能删除这个 worktree" }]);
    const toast = screen.getByRole("alert");

    await expect.element(toast).toHaveTextContent("没能归档「fix/typo」：git 没能删除这个 worktree");
    expect(getComputedStyle(toast.element().querySelector("svg") as Element).color).toBe(colorOf("var(--danger)"));
    expect(getComputedStyle(toast.getByText("：git 没能删除这个 worktree").element()).color).toBe(
      colorOf("var(--text-muted)"),
    );
    expect(timers.map((timer) => timer.ms)).toStrictEqual([6000]);
  });

  it("holds its time while hovered, going on with what was left, at least 0.6 seconds", async () => {
    const { clock, timers, at } = heldClock();
    const { screen } = await toastsOn(clock, [{ id: 1, name: "fix/typo" }]);
    const toast = screen.getByRole("status");
    await expect.element(toast).toBeVisible();

    at(1000);
    await userEvent.hover(toast);
    await expect.poll(() => timers[0]?.cancelled).toBe(true);
    at(9000);
    await userEvent.unhover(toast);
    await expect.poll(() => timers.map((timer) => timer.ms)).toStrictEqual([3000, 2000]);

    at(10_900);
    await userEvent.hover(toast);
    await expect.poll(() => timers[1]?.cancelled).toBe(true);
    await userEvent.unhover(toast);
    await expect.poll(() => timers.map((timer) => timer.ms)).toStrictEqual([3000, 2000, 600]);
  });

  it("holds its time while its × has the keyboard's focus, showing it", async () => {
    const { clock, timers } = heldClock();
    const { screen } = await toastsOn(clock, [{ id: 1, name: "fix/typo" }]);
    const close = screen.getByRole("button", { name: "关闭提示" });
    await expect.element(close).toBeInTheDocument();

    await userEvent.tab();

    await expect.element(close).toHaveFocus();
    await expect.poll(() => timers[0]?.cancelled).toBe(true);
    await expect.poll(() => getComputedStyle(close.element()).opacity).toBe("1");
  });

  it("shows × while hovered, and leaves at once when it is pressed", async () => {
    const { clock, timers } = heldClock();
    const { screen, gone } = await toastsOn(clock, [{ id: 7, name: "fix/typo" }]);
    const close = screen.getByRole("button", { name: "关闭提示" });

    expect(getComputedStyle(close.element()).opacity).toBe("0");
    await userEvent.hover(screen.getByRole("status"));
    await expect.poll(() => getComputedStyle(close.element()).opacity).toBe("1");
    await close.click();

    await expect.element(screen.getByRole("status")).toHaveAttribute("data-leaving", "true");
    expect(timers.at(-1)?.ms).toBe(200);
    fire(timers, timers.length - 1);
    expect(gone).toStrictEqual([7]);
  });

  it("floats 34 px tall at the window's top right, 56 px down and 12 px in, stacked 8 px apart", async () => {
    const { clock } = heldClock();
    const { screen } = await toastsOn(clock, [
      { id: 2, name: "tidy-icons" },
      { id: 1, name: "fix/typo" },
    ]);
    const shown = screen.getByRole("status").elements();
    expect(shown).toHaveLength(2);
    await settled(shown);
    const [first, second] = shown as [HTMLElement, HTMLElement];
    const top = first.getBoundingClientRect();
    const below = second.getBoundingClientRect();

    expect([top.top, 1280 - top.right, top.height]).toStrictEqual([56, 12, 34]);
    expect([below.top - top.bottom, 1280 - below.right]).toStrictEqual([8, 12]);
    expect(first).toHaveTextContent("已归档「tidy-icons」");
    expect(getComputedStyle(first).backdropFilter).toContain("blur(28px)");
    expect(first.parentElement?.parentElement).toBe(document.body);
  });

  it("cuts a name past 180 px short", async () => {
    const { clock } = heldClock();
    const { screen } = await toastsOn(clock, [{ id: 1, name: "a-very-long-worktree-name-that-goes-on-and-on" }]);
    const name = screen.getByText("a-very-long-worktree-name-that-goes-on-and-on").element();
    await settled(screen.getByRole("status").elements());

    expect(name.getBoundingClientRect().width).toBe(180);
    expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
  });
});

describe("pushToast", () => {
  it("puts the newest first and keeps three", () => {
    const one = { id: 1, name: "a" };
    const two = { id: 2, name: "b" };
    const three = { id: 3, name: "c" };
    const four = { id: 4, name: "d" };

    expect(pushToast([], one)).toStrictEqual([one]);
    expect(pushToast([three, two, one], four)).toStrictEqual([four, three, two]);
  });
});
