import { describe, expect, it } from "vitest";
import { type DotFrame, easeBand, nextBandSweep, paintBand, paintDots, sweepProgress } from "./dots";

const WIDTH = 120;
const HEIGHT = 32;

/**
 * Paints one frame and returns its pixels.
 *
 * @remarks
 * A real canvas, as the button and the box use.
 *
 * @sideEffects Creates a canvas.
 * @param frame - What to paint, apart from the size.
 * @param seed - The pattern's seed.
 * @returns The RGBA pixels, row by row.
 */
function paint(frame: Partial<DotFrame>, seed = 7): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  paintDots(
    context,
    {
      width: WIDTH,
      height: HEIGHT,
      coverage: 0.5,
      full: false,
      dark: false,
      now: 0,
      sweep: null,
      variant: "chip",
      ...frame,
    },
    seed,
  );
  return context.getImageData(0, 0, WIDTH, HEIGHT).data;
}

/** The summed alpha of the pixels in columns `from` to `to`. */
function inkBetween(pixels: Uint8ClampedArray, from: number, to: number): number {
  let sum = 0;
  for (let y = 0; y < HEIGHT; y += 1) for (let x = from; x < to; x += 1) sum += pixels[(y * WIDTH + x) * 4 + 3] ?? 0;
  return sum;
}

/** Whether any painted pixel has a colour rather than a grey. */
function coloured(pixels: Uint8ClampedArray): boolean {
  for (let index = 0; index < pixels.length; index += 4) {
    const [r, g, b, a] = [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]];
    if ((a ?? 0) > 0 && (r !== g || g !== b)) return true;
  }
  return false;
}

/** The red of the first painted pixel; dots are grey, so it tells black from white. */
function firstRed(pixels: Uint8ClampedArray): number | undefined {
  for (let index = 0; index < pixels.length; index += 4) if ((pixels[index + 3] ?? 0) > 0) return pixels[index];
  return undefined;
}

describe("paintDots", () => {
  it("paints nothing at no coverage", () => {
    expect(inkBetween(paint({ coverage: 0 }), 0, WIDTH)).toBe(0);
  });

  it("fills from the left as far as the coverage goes", () => {
    const half = paint({ coverage: 0.5 });

    expect(inkBetween(half, 0, 40)).toBeGreaterThan(0);
    expect(inkBetween(half, 80, WIDTH)).toBe(0);
    expect(inkBetween(paint({ coverage: 1 }), 80, WIDTH)).toBeGreaterThan(0);
  });

  it("paints more ink the higher the level, on the button", () => {
    expect(inkBetween(paint({ coverage: 0.25 }), 0, 20)).toBeLessThan(inkBetween(paint({ coverage: 1 }), 0, 20));
  });

  it("paints grey normally and in brand colours when full", () => {
    expect(coloured(paint({ coverage: 1 }))).toBe(false);
    expect(coloured(paint({ coverage: 1, dark: true }))).toBe(false);
    expect(coloured(paint({ coverage: 1, full: true }))).toBe(true);
  });

  it("paints the same pattern for the same seed and another for another", () => {
    expect([...paint({ coverage: 1 }, 7)]).toStrictEqual([...paint({ coverage: 1 }, 7)]);
    expect([...paint({ coverage: 1 }, 7)]).not.toStrictEqual([...paint({ coverage: 1 }, 8)]);
  });

  it("lights the dots under a sweep when full", () => {
    const plain = inkBetween(paint({ coverage: 1, full: true, variant: "box" }), 0, WIDTH);
    const swept = inkBetween(paint({ coverage: 1, full: true, variant: "box", sweep: 0.5 }), 0, WIDTH);

    expect(swept).toBeGreaterThan(plain);
  });

  it("paints white dots in the dark and black ones in the light", () => {
    expect(firstRed(paint({ coverage: 1, variant: "box" }))).toBe(0);
    expect(firstRed(paint({ coverage: 1, variant: "box", dark: true }))).toBe(255);
  });
});

describe("sweepProgress", () => {
  it("runs a 0.9 s sweep every 3.6 s from its start, easing in and out", () => {
    expect(sweepProgress(100, 200)).toBeNull();
    expect(sweepProgress(200, 200)).toBe(0);
    expect(sweepProgress(650, 200)).toBe(0.5);
    expect(sweepProgress(200 + 225, 200)).toBe(0.125);
    expect(sweepProgress(200 + 900, 200)).toBeNull();
    expect(sweepProgress(200 + 3600 + 450, 200)).toBe(0.5);
  });
});

/**
 * Paints the start button's band at one place and returns its pixels.
 *
 * @remarks
 * On a real canvas the size of the button, as the welcome page uses.
 *
 * @sideEffects Creates a canvas.
 * @param progress - How far the band has gone.
 * @param seed - The pattern's seed.
 * @returns The RGBA pixels, row by row.
 */
function band(progress: number, seed = 7): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  context.fillStyle = "red";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  paintBand(context, { width: WIDTH, height: HEIGHT }, progress, seed);
  return context.getImageData(0, 0, WIDTH, HEIGHT).data;
}

/**
 * The rightmost painted column in rows `from` to `to`.
 *
 * @remarks
 * Tells which way the band leans.
 *
 * @sideEffects none
 * @param pixels - The RGBA pixels.
 * @param from - The first row.
 * @param to - The row after the last.
 * @returns The column, or -1 when nothing is painted there.
 */
function rightmost(pixels: Uint8ClampedArray, from: number, to: number): number {
  let right = -1;
  for (let y = from; y < to; y += 1)
    for (let x = 0; x < WIDTH; x += 1) if ((pixels[(y * WIDTH + x) * 4 + 3] ?? 0) > 0) right = Math.max(right, x);
  return right;
}

/**
 * The colour of the first painted pixel.
 *
 * @remarks
 * `getImageData` gives colours unpremultiplied, so a faint white dot still reads as white.
 *
 * @sideEffects none
 * @param pixels - The RGBA pixels.
 * @returns Its red, green and blue, or `undefined` when nothing is painted.
 */
function firstInk(pixels: Uint8ClampedArray): number[] | undefined {
  for (let index = 0; index < pixels.length; index += 4)
    if ((pixels[index + 3] ?? 0) > 0) return [...pixels.subarray(index, index + 3)];
  return undefined;
}

describe("paintBand", () => {
  it("clears the button and paints nothing before and after the sweep", () => {
    expect(inkBetween(band(-0.01), 0, WIDTH)).toBe(0);
    expect(inkBetween(band(1.01), 0, WIDTH)).toBe(0);
    expect(inkBetween(band(-0.5), 0, WIDTH)).toBe(0);
    expect(inkBetween(band(1.5), 0, WIDTH)).toBe(0);
  });

  it("comes in narrow at the left, covers the button midway and goes out narrow at the right", () => {
    const coming = band(0.2);
    const midway = band(0.5);
    const going = band(0.8);

    expect(inkBetween(coming, 0, 20)).toBeGreaterThan(0);
    expect(inkBetween(coming, 50, WIDTH)).toBe(0);
    expect(inkBetween(midway, 0, 12)).toBeGreaterThan(0);
    expect(inkBetween(midway, WIDTH - 12, WIDTH)).toBeGreaterThan(0);
    expect(inkBetween(going, 0, 70)).toBe(0);
    expect(inkBetween(going, 100, WIDTH)).toBeGreaterThan(0);
  });

  it("leans like a backslash: lower rows lit further right", () => {
    const pixels = band(0.2);

    expect(rightmost(pixels, HEIGHT - 8, HEIGHT)).toBeGreaterThan(rightmost(pixels, 0, 8));
  });

  it("paints white dots, in the same pattern for the same seed and another for another", () => {
    expect(firstInk(band(0.5))).toStrictEqual([255, 255, 255]);
    expect(band(0.5, 3)).toStrictEqual(band(0.5, 3));
    expect(band(0.5, 3)).not.toStrictEqual(band(0.5, 4));
  });
});

describe("easeBand", () => {
  it("gathers at the start, rushes across the middle and glides out, along cubic-bezier(.7, 0, .2, 1)", () => {
    expect(easeBand(-0.5)).toBe(0);
    expect(easeBand(0)).toBe(0);
    expect(easeBand(0.25)).toBeCloseTo(0.0658, 4);
    expect(easeBand(0.5)).toBeCloseTo(0.6358, 4);
    expect(easeBand(0.75)).toBeCloseTo(0.9544, 4);
    expect(easeBand(1)).toBe(1);
    expect(easeBand(1.5)).toBe(1);
  });
});

describe("nextBandSweep", () => {
  it("keeps a sweep not over yet, its end included", () => {
    expect(nextBandSweep(500, { start: 1_000, duration: 1_100 })).toStrictEqual({ start: 1_000, duration: 1_100 });
    expect(nextBandSweep(2_100, { start: 1_000, duration: 1_100 })).toStrictEqual({ start: 1_000, duration: 1_100 });
  });

  it("starts the next idle sweep 6 s after the last began, at the idle pace after a hover", () => {
    expect(nextBandSweep(2_101, { start: 1_000, duration: 1_100 })).toStrictEqual({ start: 7_000, duration: 1_100 });
    expect(nextBandSweep(1_900, { start: 1_000, duration: 850 })).toStrictEqual({ start: 7_000, duration: 1_100 });
  });

  it("skips the sweeps missed while away, keeping one under way", () => {
    expect(nextBandSweep(20_200, { start: 1_000, duration: 1_100 })).toStrictEqual({ start: 25_000, duration: 1_100 });
    expect(nextBandSweep(19_500, { start: 1_000, duration: 1_100 })).toStrictEqual({ start: 19_000, duration: 1_100 });
    expect(nextBandSweep(20_100, { start: 1_000, duration: 1_100 })).toStrictEqual({ start: 19_000, duration: 1_100 });
  });
});
