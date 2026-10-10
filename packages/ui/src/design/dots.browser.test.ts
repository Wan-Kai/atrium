import { describe, expect, it } from "vitest";
import { type DotFrame, paintDots, sweepProgress } from "./dots";

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
