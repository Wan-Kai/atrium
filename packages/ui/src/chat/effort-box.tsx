import type { ThinkingLevel } from "@atrium/protocol";
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { dotSeed, paintDots, reducedMotion, sweepProgress } from "../design/dots";
import { useDarkMode } from "../design/use-dark-mode";
import { LEVEL_NAMES, levelHint } from "./model-choice";

/** Width of one level's cell (design-language, "推理强度框"). */
const CELL = 56;
/** The spring the edge snaps back with: response 0.38 s, damping 0.72 (design-language, "动效"). */
const OMEGA = (2 * Math.PI) / 0.38;
const ZETA = 0.72;
/** How far a press may move before it counts as a drag rather than a click. */
const CLICK_SLOP_PX = 3;
/** How hard an arrow key at either end pushes the edge. */
const END_PUSH = 1.2;

/** Props of {@link EffortBox}. */
export interface EffortBoxProps {
  /** The model's levels, lowest first. */
  readonly levels: readonly ThinkingLevel[];
  /** The level it thinks at now. */
  readonly level: ThinkingLevel;
  /** Called when you pick another level. */
  readonly onChange: (level: ThinkingLevel) => void;
  /** Takes the focus when it opens, as ⌘⇧E does. */
  readonly autoFocus?: boolean;
}

/**
 * Pulls a coverage past either end back, harder the further it goes.
 *
 * @remarks
 * The rubber band at the ends of a drag (design-language, "动效").
 *
 * @sideEffects none
 * @param value - The raw coverage.
 * @returns The damped coverage.
 */
function rubber(value: number): number {
  if (value < 0) return -(1 - 1 / (-value * 3 + 1)) / 3;
  if (value > 1) return 1 + (1 - 1 / ((value - 1) * 3 + 1)) / 3;
  return value;
}

/**
 * The level nearest to a coverage.
 *
 * @remarks
 * Level `i` covers `(i + 1) / count` of the box.
 *
 * @sideEffects none
 * @param coverage - The coverage, possibly past either end.
 * @param count - How many levels there are.
 * @returns The level's place, from 0.
 */
function nearestLevel(coverage: number, count: number): number {
  return Math.max(0, Math.round(Math.max(0, Math.min(1, coverage)) * count) - 1);
}

/** The box's edge and dots, moved and painted frame by frame. */
interface BoxMotion {
  /** Takes the box's size in CSS pixels. */
  resize(width: number, height: number): void;
  /** Where the edge is now. */
  position(): number;
  /** Puts the edge at once where it should rest. */
  place(target: number): void;
  /** Follows a drag. */
  drag(position: number): void;
  /** Springs the edge to where it should rest. */
  release(target: number): void;
  /** Gives the edge a push, as an arrow key at either end does. */
  push(velocity: number): void;
  /** Colours: full turns on the brand colours, twinkle and sweeps. */
  style(full: boolean, dark: boolean): void;
  /** Stops drawing. */
  stop(): void;
}

/**
 * Moves and paints the thinking level box's edge.
 *
 * @remarks
 * A drag moves the edge with the pointer; once let go it springs to rest (response 0.38 s, damping
 * 0.72). Frames are drawn only while something moves or the box is full; with reduced motion the
 * edge goes to rest at once and the dots stay still (design-language, "动效").
 *
 * @sideEffects Draws on the canvas and schedules animation frames until settled or stopped.
 * @param surface - The canvas.
 * @param seed - The pattern's seed.
 * @returns The motion.
 */
function createBoxMotion(surface: HTMLCanvasElement, seed: number): BoxMotion {
  let size = { width: 0, height: 0 };
  let pos = 0;
  let vel = 0;
  let target = 0;
  let dragging = false;
  let full = false;
  let dark = false;
  let sweepStart = 0;
  let frame = 0;
  let last = 0;

  /**
   * Moves the edge one frame and paints it, asking for the next while anything moves.
   *
   * @remarks
   * The spring is integrated with the frame's own time step, capped so a stalled tab does not
   * jump.
   *
   * @sideEffects Draws; may schedule a frame.
   * @param now - The frame's time.
   */
  function step(now: number): void {
    frame = 0;
    const context = surface.getContext("2d");
    if (context === null || size.width === 0) return;
    const reduced = reducedMotion();
    const dt = Math.min(0.032, (now - (last === 0 ? now : last)) / 1000);
    last = now;
    if (!dragging && reduced) {
      pos = target;
      vel = 0;
    } else if (!dragging) {
      vel += (-OMEGA * OMEGA * (pos - target) - 2 * ZETA * OMEGA * vel) * dt;
      pos += vel * dt;
      if (Math.abs(pos - target) < 0.0008 && Math.abs(vel) < 0.002) {
        pos = target;
        vel = 0;
      }
    }
    const sweeping = full && !dragging && !reduced;
    paintDots(
      context,
      {
        ...size,
        coverage: pos,
        full,
        dark,
        now: reduced ? 0 : now,
        sweep: sweeping ? sweepProgress(now, sweepStart) : null,
        variant: "box",
      },
      seed,
    );
    if (dragging || pos !== target || sweeping) frame = requestAnimationFrame(step);
  }

  /**
   * Starts drawing unless a frame is already asked for.
   *
   * @remarks
   * The loop stops by itself once settled.
   *
   * @sideEffects Schedules a frame.
   */
  function kick(): void {
    if (frame !== 0) return;
    last = 0;
    frame = requestAnimationFrame(step);
  }

  return {
    resize(width, height) {
      const ratio = devicePixelRatio || 1;
      size = { width, height };
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
      surface.getContext("2d")?.setTransform(ratio, 0, 0, ratio, 0, 0);
      kick();
    },
    position: () => pos,
    place(rest) {
      pos = rest;
      target = rest;
      vel = 0;
      kick();
    },
    drag(position) {
      dragging = true;
      vel = 0;
      pos = position;
      kick();
    },
    release(rest) {
      dragging = false;
      target = rest;
      kick();
    },
    push(velocity) {
      vel += velocity;
      kick();
    },
    style(isFull, isDark) {
      if (isFull && !full) sweepStart = performance.now() + 250;
      full = isFull;
      dark = isDark;
      kick();
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

/**
 * The thinking level box: the dots' coverage is the level.
 *
 * @remarks
 * SPEC-0001 ("输入框") and design-language ("推理强度框"): a 38 px high box, 56 px per level, its
 * background dots covering as many cells as the level; thin lines divide the levels; the level's
 * name on the left and "3 / 4" on the right; what the level suits below. Drag it and the edge
 * follows the pointer, with a rubber band past either end; let go and it springs to the nearest
 * level; a click jumps to that cell; ← → move one level, and at either end give a small push. The
 * new name slides in from the side moved to. The top level turns the dots into brand colours with
 * a sweep and a pale blue glow. A level set from outside, as when pi keeps it within what the
 * model supports, moves the box too.
 *
 * @sideEffects Draws on a canvas while moving or full; listens for pointer moves on the window
 * while dragged; calls `onChange`.
 * @param props - The levels, the level, what to do on a change, and whether to take the focus.
 * @returns The box and its hint.
 */
export function EffortBox({ levels, level, onChange, autoFocus = false }: EffortBoxProps) {
  const count = levels.length;
  const committed = Math.max(0, levels.indexOf(level));
  const [shown, setShown] = useState(committed);
  const [direction, setDirection] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const motion = useRef<BoxMotion | null>(null);
  /** Ends the drag under way, removing its window listeners; `null` when there is none. */
  const endDrag = useRef<(() => void) | null>(null);
  /** Whether the edge has been put at its first level, which it is at once rather than by a spring. */
  const placed = useRef(false);
  const dark = useDarkMode();
  const full = shown === count - 1;

  useEffect(() => {
    const element = box.current;
    const surface = canvas.current;
    if (element === null || surface === null) return undefined;
    const created = createBoxMotion(surface, dotSeed());
    motion.current = created;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      created.resize(rect.width, rect.height);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      created.stop();
      endDrag.current?.();
      motion.current = null;
    };
  }, []);

  useEffect(() => {
    // A level set from outside; the first one puts the edge in place at once.
    const rest = (committed + 1) / count;
    if (endDrag.current !== null) return;
    if (placed.current) {
      motion.current?.release(rest);
    } else {
      placed.current = true;
      motion.current?.place(rest);
    }
    // oxlint-disable-next-line react/set-state-in-effect -- the level comes from the session, outside React.
    setShown(committed);
  }, [committed, count]);

  useEffect(() => {
    motion.current?.style(full, dark);
  }, [full, dark]);

  useEffect(() => {
    if (autoFocus) box.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  /**
   * Shows a level, and picks it unless only passing over it in a drag.
   *
   * @remarks
   * The name slides in from the side moved to.
   *
   * @sideEffects Updates what is shown; may call `onChange`.
   * @param index - The level's place.
   * @param commit - Whether to pick it.
   */
  const show = (index: number, commit: boolean): void => {
    const clamped = Math.max(0, Math.min(count - 1, index));
    if (clamped !== shown) setDirection(clamped > shown ? 1 : -1);
    setShown(clamped);
    const picked = levels[clamped];
    if (commit && picked !== undefined && picked !== level) onChange(picked);
  };

  /**
   * Starts a drag or a click.
   *
   * @remarks
   * Moves are followed on the window, so the drag goes on outside the box.
   *
   * @sideEffects Listens for pointer moves on the window until let go.
   * @param event - The press.
   */
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const element = event.currentTarget;
    element.focus({ preventScroll: true });
    const startX = event.clientX;
    const startPos = motion.current?.position() ?? (shown + 1) / count;
    let moved = false;
    motion.current?.drag(startPos);

    /**
     * Follows the pointer.
     *
     * @remarks
     * A move past the slop makes the press a drag.
     *
     * @sideEffects Moves the edge; shows the level passed over.
     * @param moving - The move.
     */
    const move = (moving: PointerEvent): void => {
      const width = element.getBoundingClientRect().width;
      if (Math.abs(moving.clientX - startX) > CLICK_SLOP_PX) moved = true;
      const position = rubber(startPos + (moving.clientX - startX) / width);
      motion.current?.drag(position);
      show(nearestLevel(position, count), false);
    };

    /**
     * Lets go: a drag rests on the nearest level, a click on the cell clicked.
     *
     * @remarks
     * See `EffortBox`.
     *
     * @sideEffects Removes the listeners; springs the edge; may call `onChange`.
     * @param ending - The release.
     */
    const end = (ending: PointerEvent): void => {
      endDrag.current?.();
      const rect = element.getBoundingClientRect();
      const index = moved
        ? nearestLevel(motion.current?.position() ?? startPos, count)
        : Math.ceil(((ending.clientX - rect.left) / rect.width) * count) - 1;
      const clamped = Math.max(0, Math.min(count - 1, index));
      motion.current?.release((clamped + 1) / count);
      show(clamped, true);
    };

    endDrag.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      endDrag.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  /**
   * Moves one level per arrow key.
   *
   * @remarks
   * At either end the edge only gets a small push.
   *
   * @sideEffects May call `onChange`; animates.
   * @param event - The key.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -1
          : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = shown + delta;
    if (next < 0 || next >= count) {
      motion.current?.push(delta * END_PUSH);
      return;
    }
    motion.current?.release((next + 1) / count);
    show(next, true);
  };

  const shownLevel = levels[shown] ?? level;
  return (
    <div className="flex flex-col items-center">
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label="推理强度"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={shown + 1}
        aria-valuetext={LEVEL_NAMES[shownLevel]}
        data-full={full ? "" : undefined}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        style={{ width: count * CELL }}
        className="atrium-effort-box relative isolate h-[38px] max-w-full cursor-grab touch-none overflow-hidden rounded-[12px] bg-[var(--surface-2)] outline-none select-none"
      >
        <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 -z-10 size-full" />
        {Array.from({ length: count - 1 }, (_, index) => (
          <span
            key={index}
            data-divider=""
            aria-hidden="true"
            style={{ left: `${((index + 1) / count) * 100}%` }}
            className="absolute top-[10px] bottom-[10px] w-px -translate-x-1/2 bg-[var(--line-strong)] opacity-70"
          />
        ))}
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center overflow-hidden">
          <span
            key={shownLevel}
            data-direction={direction > 0 ? "up" : "down"}
            className="atrium-effort-name text-[length:var(--fs-meta)] font-semibold text-[var(--text)]"
          >
            {LEVEL_NAMES[shownLevel]}
          </span>
        </span>
        <span className="atrium-effort-count pointer-events-none absolute inset-y-0 right-3 flex items-center text-[length:var(--fs-xs)] text-[var(--text-dim)] tabular-nums">
          {shown + 1} / {count}
        </span>
      </div>
      <p className="min-h-[1.5em] px-2.5 pt-2 pb-1 text-center text-[length:var(--fs-xs)] text-[var(--text-dim)]">
        {levelHint(shownLevel, levels)}
      </p>
    </div>
  );
}
