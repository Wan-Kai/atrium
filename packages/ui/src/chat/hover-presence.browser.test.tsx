import { UNKNOWN_METRICS } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit/clock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { ClockContext, type UiClock } from "../state/clock";
import { FastToggle } from "./fast-toggle";
import { StatusBar } from "./status-bar";

beforeEach(() => page.viewport(1280, 820));
afterEach(() => vi.restoreAllMocks());

/**
 * One of the real hover cards, without unrelated running clocks.
 * @remarks Both cards preserve their original CSS visibility and animation rules.
 * @sideEffects Mounts floating consumers.
 * @param props - The card to render.
 * @returns The card's anchor and content.
 */
function Target({ kind }: { readonly kind: "fast" | "status" }) {
  return kind === "fast" ? (
    <FastToggle enabled={false} fast={{ speed: 2, moreUsage: true }} disabled={false} onToggle={() => undefined} />
  ) : (
    <StatusBar
      metrics={UNKNOWN_METRICS}
      plans={[]}
      provider={null}
      choices={{ session: true, tokens: false, context: false }}
      onChoose={() => undefined}
    />
  );
}

const CASES = [
  { kind: "fast", name: "Fast" },
  { kind: "status", name: /轮/ },
] as const;

describe("Hover card top-layer presence", () => {
  for (const testCase of CASES) {
    it(`keeps an idle ${testCase.kind} card out of the top layer without geometry observers`, async () => {
      const observe = vi.spyOn(ResizeObserver.prototype, "observe");
      const added = vi.spyOn(window, "addEventListener");
      const screen = await render(
        <div style={{ marginTop: 500, width: 500 }}>
          <Target kind={testCase.kind} />
        </div>,
      );
      const tooltip = screen.getByRole("tooltip", { includeHidden: true }).element();
      expect(tooltip.matches(":popover-open")).toBe(false);
      expect(observe).not.toHaveBeenCalled();
      expect(added.mock.calls.filter(([type]) => ["resize", "scroll"].includes(type))).toStrictEqual([]);
    });

    it(`keeps the ${testCase.kind} card shown while the pointer is on it, though the card is in the top layer, and hides it once the pointer leaves`, async () => {
      const screen = await render(
        <div style={{ marginTop: 500, width: 500 }}>
          <button type="button">外面</button>
          <Target kind={testCase.kind} />
        </div>,
      );
      await screen.getByRole("button", { name: testCase.name, exact: true }).hover();
      const card = screen.getByRole("tooltip");
      await expect.element(card).toBeVisible();
      const tooltip = card.element();
      await card.hover();
      // Wherever its fade is, its end: shown while the pointer stays on the card (SPEC-0001, "状态栏").
      for (const animation of tooltip.getAnimations()) animation.finish();
      const open = tooltip.matches(":popover-open");
      const shown = [getComputedStyle(tooltip).visibility, getComputedStyle(tooltip).opacity];
      await screen.getByRole("button", { name: "外面" }).hover();
      for (const animation of tooltip.getAnimations()) animation.finish();

      expect([open, ...shown, getComputedStyle(tooltip).visibility, getComputedStyle(tooltip).opacity]).toStrictEqual([
        true,
        "visible",
        "1",
        "hidden",
        "0",
      ]);
    });

    it(`keeps the ${testCase.kind} card fixed through its exit, cancels reentry, and releases its timer`, async () => {
      const time = new FakeClock();
      const clock: UiClock = {
        now: () => time.now(),
        after: (ms, run) => time.setTimeout(run, ms),
        every: () => () => undefined,
      };
      const screen = await render(
        <ClockContext value={clock}>
          <button type="button">外面</button>
          <div style={{ position: "fixed", top: 500, left: 0, width: 150 }}>
            <Target kind={testCase.kind} />
          </div>
        </ClockContext>,
      );
      const trigger = screen.getByRole("button", { name: testCase.name, exact: true });
      const outside = screen.getByRole("button", { name: "外面" });
      await trigger.hover();
      const tooltip = screen.getByRole("tooltip", { includeHidden: true }).element();
      await expect.poll(() => tooltip.matches(":popover-open")).toBe(true);
      // The entrance's timing as the stylesheet gives it; its animation may be over already when the machine is busy.
      const style = getComputedStyle(tooltip);
      expect([style.transitionDelay, style.transitionDuration]).toStrictEqual(["0.12s", "0.15s"]);
      const before = tooltip.getBoundingClientRect();
      await outside.hover();
      expect(tooltip.matches(":popover-open")).toBe(true);
      expect(tooltip.getBoundingClientRect().left).toBe(before.left);
      expect(tooltip.getBoundingClientRect().top).toBe(before.top);
      expect(time.pendingTimers()).toBe(1);
      time.advance(249);
      expect(time.pendingTimers()).toBe(1);
      expect(tooltip.matches(":popover-open")).toBe(true);
      await trigger.hover();
      expect(time.pendingTimers()).toBe(0);
      time.advance(1);
      expect(tooltip.matches(":popover-open")).toBe(true);
      await outside.hover();
      time.advance(250);
      await expect.poll(() => tooltip.matches(":popover-open")).toBe(false);
      expect(time.pendingTimers()).toBe(0);
      outside.element().focus();
      await userEvent.keyboard("{Tab}");
      expect(trigger.element().matches(":focus-visible")).toBe(true);
      await expect.poll(() => tooltip.matches(":popover-open")).toBe(true);
      outside.element().focus();
      expect(time.pendingTimers()).toBe(1);
      await screen.unmount();
      expect(time.pendingTimers()).toBe(0);
    });
  }
});
