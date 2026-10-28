import { createContext } from "react";

/**
 * The rounded square dots that are Atrium's mark (design-language, "点阵"): 3.6 px dots, 1 px
 * corners, 6 px apart, their shade from two layers of smooth noise seeded per install.
 */

/** Distance between dots. */
const PITCH = 6;
/** Side of a dot. */
const SIZE = 3.6;
/** Corner radius of a dot. */
const RADIUS = 1;
/** Brand colours across the width when full: blue → teal → peach. */
const BLUE = [94, 132, 255] as const;
const TEAL = [120, 214, 214] as const;
const PEACH = [255, 170, 120] as const;
/** How often a sweep crosses a full field, and how long it takes (design-language, "点阵"). */
const SWEEP_EVERY_MS = 3_600;
const SWEEP_MS = 900;

/** One frame of a dot field. */
export interface DotFrame {
  readonly width: number;
  readonly height: number;
  /** How far from the left the dots reach, 0 to 1; a dragged box may go slightly past either end. */
  readonly coverage: number;
  /** The top level: brand colours, twinkle and sweeps. */
  readonly full: boolean;
  readonly dark: boolean;
  /** Milliseconds, for the twinkle; a fixed value paints a still frame. */
  readonly now: number;
  /** Where a sweep is, 0 to 1, or `null` for none. */
  readonly sweep: number | null;
  /** The model button's faint dots, or the thinking level box's stronger ones. */
  readonly variant: "chip" | "box";
}

/**
 * The seed of this install's dot pattern, given by the workbench from the host's welcome.
 *
 * @remarks
 * The pattern differs from install to install and stays the same for each (design-language,
 * "点阵"); the host makes the seed from the install id in `~/.atrium` (SPEC-0001, "首次启动 · 接口").
 * Outside a workbench, as in a component's own tests, it is 1.
 */
export const DotSeedContext = createContext(1);

/**
 * Whether the user asked for less motion.
 *
 * @remarks
 * Dots then keep a still pattern and edges move at once (design-language, "动效").
 *
 * @sideEffects none
 * @returns Whether motion is reduced.
 */
export function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Where a sweep across a full field is.
 *
 * @remarks
 * A `\` sweep every 3.6 s, lasting 0.9 s, easing in and out (design-language, "点阵").
 *
 * @sideEffects none
 * @param now - The time, in milliseconds.
 * @param start - When the first sweep starts.
 * @returns Its progress from 0 to 1, or `null` between sweeps.
 */
export function sweepProgress(now: number, start: number): number | null {
  if (now < start) return null;
  const into = (now - start) % SWEEP_EVERY_MS;
  if (into >= SWEEP_MS) return null;
  const x = into / SWEEP_MS;
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

/**
 * Paints a frame of dots.
 *
 * @remarks
 * Prototyped in `app-prototype.html` (`dotField`, `effortBox`). Each dot's shade comes from two
 * layers of value noise, so the pattern has large patches and fine grain; the edge of the
 * coverage is feathered rather than cut. Normally the dots are black in the light and white in
 * the dark at low opacity, denser on the button as the level rises; full, they take the brand
 * colours by their horizontal place, twinkle with `now`, and brighten under a sweep.
 *
 * @sideEffects Clears and draws on `context`.
 * @param context - The canvas, already scaled to CSS pixels.
 * @param frame - What to paint.
 * @param seed - The pattern's seed.
 */
export function paintDots(context: CanvasRenderingContext2D, frame: DotFrame, seed: number): void {
  const { width, height, coverage, full, dark, now, sweep, variant } = frame;
  context.clearRect(0, 0, width, height);
  const box = variant === "box";
  const ink = dark ? 255 : 0;
  const cols = Math.ceil(width / PITCH);
  const rows = Math.ceil(height / PITCH);
  const left = (width - (cols - 1) * PITCH - SIZE) / 2;
  const top = (height - (rows - 1) * PITCH - SIZE) / 2;
  const feather = box ? 0.09 : 0.14;
  const hash = hasher(seed);
  const noise = valueNoise(hash);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = (col + 0.5) / cols;
      const reach = Math.max(0, Math.min(1, (coverage - x) / feather + 0.5));
      if (reach <= 0) continue;
      const tone =
        (box ? 0.5 : 0.45) +
        (box ? 0.5 : 0.55) * (0.6 * noise(col / 3, row / 3) + 0.4 * noise(col / 1.3 + 9, row / 1.3 + 4));
      let alpha: number;
      let rgb: readonly [number, number, number];
      if (full) {
        const twinkle = 0.8 + 0.2 * Math.sin(now / 280 + hash(col, row) * 6.28);
        let boost = 0;
        if (sweep !== null) {
          const centre = -0.4 + sweep * 1.8;
          const off = x - centre - (row / rows - 0.5) * 0.35;
          boost = Math.max(0, 1 - Math.abs(off) / (box ? 0.16 : 0.18));
        }
        const base = box ? (dark ? 0.4 : 0.32) : dark ? 0.34 : 0.26;
        alpha = Math.min(0.95, base * tone * twinkle * reach + boost * (box ? 0.6 : 0.65) * tone);
        rgb = tint(x);
      } else {
        alpha = box
          ? (dark ? 0.32 : 0.24) * tone * reach * (0.7 + 0.3 * coverage)
          : (dark ? 0.07 : 0.05) * (1 + 4 * coverage) * tone * reach;
        rgb = [ink, ink, ink];
      }
      if (alpha < 0.015) continue;
      context.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)})`;
      context.beginPath();
      context.roundRect(left + col * PITCH, top + row * PITCH, SIZE, SIZE, RADIUS);
      context.fill();
    }
  }
}

/** The start button's dots: larger, rounder and further lit than the model button's (SPEC-0001, "欢迎页"). */
const BAND_SIZE = 4.4;
const BAND_RADIUS = 1.3;
/** How far the band leans: each row down sits this many columns to the right, a `\`. */
const BAND_SLANT = 0.55;

/**
 * The start button's sweep timing: once every 6 s, taking 1.1 s, or 0.85 s at once on hover
 * (SPEC-0001, "欢迎页").
 */
const BAND_EVERY_MS = 6_000;
export const BAND_MS = 1_100;
export const BAND_HOVER_MS = 850;

/**
 * Eases the start button's band along `cubic-bezier(.7, 0, .2, 1)`.
 *
 * @remarks
 * SPEC-0001 ("欢迎页"): it gathers at the start, rushes across the button and glides out slowly.
 * The curve's `x` is solved for its parameter by Newton steps; its slope in `x` stays above zero
 * for these control points, so they always converge.
 *
 * @sideEffects none
 * @param x - Time into the sweep, 0 to 1.
 * @returns How far the band has gone, 0 to 1.
 */
export function easeBand(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = [0.7, 0, 0.2, 1];
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let t = x;
  for (let step = 0; step < 8; step += 1) {
    const slope = (3 * ax * t + 2 * bx) * t + cx;
    t -= (((ax * t + bx) * t + cx) * t - x) / slope;
  }
  return ((ay * t + by) * t + cy) * t;
}

/** A sweep of the start button's band: when it starts and how long it takes, in ms. */
export interface BandSweep {
  readonly start: number;
  readonly duration: number;
}

/**
 * The sweep of the start button's band that is under way or comes next at `now`.
 *
 * @remarks
 * SPEC-0001 ("欢迎页"): a sweep every 6 s; one started by hovering is quicker. Once a sweep is
 * over, the next starts 6 s after it began, at the idle pace; sweeps missed while the page was
 * away are skipped rather than played.
 *
 * @sideEffects none
 * @param now - The time.
 * @param sweep - The sweep last known.
 * @returns The sweep under way or the next.
 */
export function nextBandSweep(now: number, sweep: BandSweep): BandSweep {
  if (now - sweep.start <= sweep.duration) return sweep;
  const skipped = Math.ceil((now - sweep.start - BAND_MS) / BAND_EVERY_MS);
  return { start: sweep.start + Math.max(1, skipped) * BAND_EVERY_MS, duration: BAND_MS };
}

/**
 * Paints the start button's band of dots at one place of its sweep.
 *
 * @remarks
 * SPEC-0001 ("欢迎页"), prototyped as `dotCta` in `onboarding-prototype.html`: a `\` band of white
 * dots crosses the button once, narrow coming in, covering the whole button midway and narrow
 * going out. Every dot inside is lit; only their shades, from the install's noise, make the
 * pattern, which travels with the band. The band's edges are feathered.
 *
 * @sideEffects Clears and draws on `context`.
 * @param context - The canvas, already scaled to CSS pixels.
 * @param size - The button's size in CSS pixels.
 * @param progress - How far the band has gone, 0 to 1; outside that nothing is painted.
 * @param seed - The pattern's seed.
 */
export function paintBand(
  context: CanvasRenderingContext2D,
  size: { readonly width: number; readonly height: number },
  progress: number,
  seed: number,
): void {
  const { width, height } = size;
  context.clearRect(0, 0, width, height);
  if (progress < 0 || progress > 1) return;
  const cols = Math.ceil(width / PITCH);
  const rows = Math.ceil(height / PITCH);
  const left = (width - (cols - 1) * PITCH - BAND_SIZE) / 2;
  const top = (height - (rows - 1) * PITCH - BAND_SIZE) / 2;
  const middle = (rows - 1) / 2;
  const widest = cols + rows * BAND_SLANT;
  const band = widest * (0.45 + 0.55 * Math.sin(Math.PI * progress));
  const centre = -widest / 2 + progress * (cols + widest);
  const noise = valueNoise(hasher(seed));
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const local = col - centre - (row - middle) * BAND_SLANT;
      const edge = Math.abs(local) / (band / 2);
      if (edge >= 1) continue;
      const envelope = edge < 0.7 ? 1 : 1 - smooth((edge - 0.7) / 0.3);
      const pattern =
        0.62 * noise((local + 50) / 3.2, row / 3.2) + 0.38 * noise((local + 50) / 1.4 + 17, row / 1.4 + 5);
      const shade = Math.min(1, Math.max(0, (pattern - 0.28) / 0.44));
      context.fillStyle = `rgba(255,255,255,${(envelope * (0.26 + 0.74 * shade)).toFixed(3)})`;
      context.beginPath();
      context.roundRect(left + col * PITCH, top + row * PITCH, BAND_SIZE, BAND_SIZE, BAND_RADIUS);
      context.fill();
    }
  }
}

/**
 * A hash of a grid point, 0 to 1, fixed by the seed.
 *
 * @remarks
 * Integer mixing, so the same seed gives the same pattern on every machine.
 *
 * @sideEffects none
 * @param seed - The seed.
 * @returns The hash function.
 */
function hasher(seed: number): (x: number, y: number) => number {
  return (x, y) => {
    let h = (x * 374_761_393 + y * 668_265_263 + seed * 2_147_483_647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_295;
  };
}

/**
 * Eases 0 to 1 with zero slope at both ends.
 *
 * @remarks
 * Smoothstep, so the noise has no creases at grid lines.
 *
 * @sideEffects none
 * @param t - From 0 to 1.
 * @returns The eased value.
 */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Smooth value noise over a hash.
 *
 * @remarks
 * Bilinear between grid points with smoothstep, which is enough for the patches the dots need.
 *
 * @sideEffects none
 * @param hash - The grid's hash.
 * @returns The noise function, 0 to 1.
 */
function valueNoise(hash: (x: number, y: number) => number): (x: number, y: number) => number {
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = smooth(x - xi);
    const yf = smooth(y - yi);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}

/**
 * The brand colour at a horizontal place.
 *
 * @remarks
 * Blue at the left, teal in the middle, peach at the right.
 *
 * @sideEffects none
 * @param x - The place, 0 to 1.
 * @returns The colour.
 */
function tint(x: number): readonly [number, number, number] {
  const k = Math.min(2, Math.max(0, x) * 2);
  const [from, to] = k < 1 ? [BLUE, TEAL] : [TEAL, PEACH];
  const f = k < 1 ? k : k - 1;
  return [
    Math.round(from[0] + (to[0] - from[0]) * f),
    Math.round(from[1] + (to[1] - from[1]) * f),
    Math.round(from[2] + (to[2] - from[2]) * f),
  ];
}
