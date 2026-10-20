import { afterEach, describe, expect, it } from "vitest";
import { cdp } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { ClockContext, type UiClock } from "../state/clock";
import { RunningDots } from "./running-dots";

/** How long the arm takes to go round, as design-language "会话状态" says. */
const TURN_MS = 1650;

/**
 * A clock standing at `now`.
 *
 * @sideEffects none
 * @param now - The time it says.
 * @returns The clock.
 */
function standingAt(now: number): UiClock {
  return { now: () => now, every: () => () => {}, after: () => () => {} };
}

/**
 * Renders the mark with the clock at `now` and returns its dots.
 *
 * @sideEffects Renders.
 * @param now - When it appears.
 * @returns Its dots.
 */
async function dotsAt(now: number): Promise<SVGCircleElement[]> {
  const screen = await render(
    <ClockContext value={standingAt(now)}>
      <span style={{ color: "rgb(47, 111, 237)" }}>
        <RunningDots size={14} />
      </span>
    </ClockContext>,
  );
  return [...screen.container.querySelectorAll("circle")];
}

/**
 * Where a dot's animation is when its own clock starts, as a part of a turn.
 *
 * @sideEffects none
 * @param dot - The dot.
 * @param mountedAt - When it appeared.
 * @returns Its phase, 0 to 1, to three places.
 */
function phaseOf(dot: SVGCircleElement, mountedAt: number): number {
  const delay = Number.parseFloat(getComputedStyle(dot).animationDelay) * 1000;
  return Math.round((((((delay + mountedAt) % TURN_MS) + TURN_MS) % TURN_MS) / TURN_MS) * 1000) / 1000;
}

describe("RunningDots", () => {
  afterEach(async () => {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  });

  it("draws the 21 dots of a 5×5 grid cut round, in the text's colour, at the size asked", async () => {
    const dots = await dotsAt(0);
    const svg = dots[0]?.ownerSVGElement;

    expect([
      dots.map((dot) => [dot.getAttribute("cx"), dot.getAttribute("cy")].join(",")),
      dots.map((dot) => dot.getAttribute("r")),
      svg?.getAttribute("viewBox"),
      svg?.getBoundingClientRect().width,
      svg?.getAttribute("aria-hidden"),
      getComputedStyle(dots[0] as Element).fill,
    ]).toStrictEqual([
      ["1.5,0.5", "2.5,0.5", "3.5,0.5"]
        .concat([1.5, 2.5, 3.5].flatMap((y) => [0.5, 1.5, 2.5, 3.5, 4.5].map((x) => `${x},${y}`)))
        .concat(["1.5,4.5", "2.5,4.5", "3.5,4.5"]),
      Array.from({ length: 21 }, () => "0.38"),
      "0 0 5 5",
      14,
      "true",
      "rgb(47, 111, 237)",
    ]);
  });

  it("steps every dot through full, half and dim light once a turn, without fading between", async () => {
    const [dot] = await dotsAt(0);
    const animation = dot?.getAnimations()[0] as CSSAnimation;
    animation.pause();
    animation.effect?.updateTiming({ delay: 0 });
    /**
     * The dot's opacity this far through a turn.
     *
     * @sideEffects Moves the paused animation.
     * @param part - How far, 0 to 1.
     * @returns The opacity.
     */
    const at = (part: number): string => {
      animation.currentTime = part * TURN_MS;
      return getComputedStyle(dot as Element).opacity;
    };

    expect([
      animation.animationName,
      animation.effect?.getTiming().duration,
      animation.effect?.getTiming().iterations,
      [0, 0.147, 0.149, 0.249, 0.251, 0.5, 0.749, 0.751, 0.852, 0.853, 0.999].map(at),
    ]).toStrictEqual([
      "atrium-running-dot",
      TURN_MS,
      Infinity,
      ["1", "1", "0.55", "0.55", "0.2", "0.2", "0.2", "0.55", "0.55", "1", "1"],
    ]);
  });

  it("turns the arm across the grid, each dot later the further round and out it is", async () => {
    const dots = await dotsAt(0);

    expect(dots.map((dot) => phaseOf(dot, 0))).toStrictEqual([
      0.107, 0.95, 0.959, 0.209, 0.87, 0.6, 0.62, 0.857, 0.2, 0.85, 0, 0.35, 0.7, 0.357, 0.12, 0.1, 0.37, 0.709, 0.459,
      0.45, 0.607,
    ]);
  });

  it("keeps marks that appear at different times turning together", async () => {
    const early = await dotsAt(10_000);
    const late = await dotsAt(10_700);
    const delays = late.map((dot) => Number.parseFloat(getComputedStyle(dot).animationDelay) * 1000);

    expect(late.map((dot) => phaseOf(dot, 10_700))).toStrictEqual(early.map((dot) => phaseOf(dot, 10_000)));
    expect([Math.max(...delays) <= 0, Math.min(...delays) > -TURN_MS]).toStrictEqual([true, true]);
  });

  it("holds one frame of the arm when less motion is asked for", async () => {
    await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const dots = await dotsAt(0);

    expect([
      dots.map((dot) => getComputedStyle(dot).animationName),
      dots.map((dot) => getComputedStyle(dot).opacity),
    ]).toStrictEqual([
      Array.from({ length: 21 }, () => "none"),
      ["0.2", "0.2", "0.2"]
        .concat(["0.2", "0.55", "1", "1", "0.55"])
        .concat(["0.2", "0.55", "0.2", "0.2", "1"])
        .concat(["0.2", "0.2", "0.2", "0.2", "1"])
        .concat(["0.55", "0.55", "1"]),
    ]);
  });
});
