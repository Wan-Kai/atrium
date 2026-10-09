import type { ThinkingLevel } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { EffortBox } from "./effort-box";

const FOUR: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh"];

/** Renders a box at `level` that records what it was changed to. */
async function box(level: ThinkingLevel, levels: readonly ThinkingLevel[] = FOUR, autoFocus = false) {
  const changes: ThinkingLevel[] = [];
  const screen = await render(
    <div style={{ width: 400, padding: 8 }}>
      <EffortBox levels={levels} level={level} onChange={(next) => changes.push(next)} autoFocus={autoFocus} />
    </div>,
  );
  const slider = screen.getByRole("slider", { name: "推理强度" });
  return { screen, slider, changes };
}

/**
 * Sends pointer events to the box, as a drag from one place to another would.
 *
 * @remarks
 * Places are fractions of the box's width.
 *
 * @sideEffects Dispatches events.
 * @param element - The box.
 * @param from - Where the press starts.
 * @param to - Where it is let go, after moving through the middle.
 */
function drag(element: Element, from: number, to: number): void {
  const rect = element.getBoundingClientRect();
  const at = (fraction: number) => ({
    clientX: rect.left + rect.width * fraction,
    clientY: rect.top + rect.height / 2,
    bubbles: true,
    pointerId: 1,
    isPrimary: true,
  });
  element.dispatchEvent(new PointerEvent("pointerdown", at(from)));
  window.dispatchEvent(new PointerEvent("pointermove", at((from + to) / 2)));
  window.dispatchEvent(new PointerEvent("pointermove", at(to)));
  window.dispatchEvent(new PointerEvent("pointerup", at(to)));
}

describe("EffortBox", () => {
  it("shows the level's name, its place among the levels and what it suits", async () => {
    const { screen, slider } = await box("medium");

    await expect.element(slider).toHaveAttribute("aria-valuenow", "2");
    await expect.element(slider).toHaveAttribute("aria-valuemax", "4");
    await expect.element(slider).toHaveAttribute("aria-valuetext", "中");
    await expect.element(slider).toHaveTextContent("中2 / 4");
    await expect.element(screen.getByText("默认，兼顾速度和质量")).toBeVisible();
    await expect.element(slider).not.toHaveAttribute("data-full");
  });

  it("is 56 px wide per level, with a divider between each two", async () => {
    const { slider } = await box("low", ["off", "minimal", "low", "medium", "high", "xhigh"]);

    expect(slider.element().getBoundingClientRect().width).toBe(6 * 56);
    expect(slider.element().querySelectorAll("[data-divider]")).toHaveLength(5);
  });

  it("marks the top level full", async () => {
    const { slider } = await box("xhigh");

    await expect.element(slider).toHaveAttribute("data-full");
  });

  it("moves one level per arrow key, and stays put at either end", async () => {
    const { slider, changes } = await box("xhigh");

    // Focus without a press, which would pick the cell under the pointer.
    (slider.element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.keyboard("{ArrowDown}");

    expect(changes).toStrictEqual(["high", "medium"]);
    await expect.element(slider).toHaveAttribute("aria-valuetext", "中");
  });

  it("jumps to the cell clicked", async () => {
    const { slider, changes } = await box("low");

    drag(slider.element(), 0.6, 0.6);

    expect(changes).toStrictEqual(["high"]);
    await expect.element(slider).toHaveAttribute("aria-valuenow", "3");
  });

  it("follows a drag and settles on the nearest level when let go", async () => {
    const { slider, changes } = await box("low");

    drag(slider.element(), 0.2, 0.95);

    expect(changes).toStrictEqual(["xhigh"]);
    await expect.element(slider).toHaveAttribute("data-full");
  });

  it("changes nothing when dragged back to where it was", async () => {
    const { slider, changes } = await box("medium");

    drag(slider.element(), 0.45, 0.48);

    expect(changes).toStrictEqual([]);
  });

  it("can take the focus when it opens", async () => {
    const { slider } = await box("medium", FOUR, true);

    await expect.element(slider).toHaveFocus();
  });

  it("follows a level set from outside", async () => {
    const { screen, slider } = await box("low");

    await screen.rerender(
      <div style={{ width: 340, padding: 8 }}>
        <EffortBox levels={FOUR} level="high" onChange={() => undefined} />
      </div>,
    );

    await expect.element(slider).toHaveAttribute("aria-valuetext", "高");
  });
});
