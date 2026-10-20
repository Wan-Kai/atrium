import { useState } from "react";
import { useClock } from "../state/clock";

/** How long the arm takes to go round, in milliseconds (design-language, "会话状态"). */
const TURN_MS = 1650;
/** The moment held when motion is reduced: the arm hooked round the right side. */
const STILL_AT_MS = 1150;
/** The grid's side, in dots. */
const SIDE = 5;
/** A dot's radius, in cells. */
const RADIUS = 0.38;

/** A dot of the mark. */
interface Dot {
  readonly x: number;
  readonly y: number;
  /** How far behind the arm's start it lights up, as a part of a turn. */
  readonly phase: number;
}

/**
 * The 5×5 grid cut round, each dot with its place on the arm.
 *
 * @remarks
 * The circle is counted in cells (half the side plus 0.3), not as a part of the side: so cut, five
 * dots a side keep 21 and read as round; cut at the same part as a larger grid they would keep 13,
 * a diamond (design-language, "会话状态"). A dot's phase is cos(4.4·r/2 − θ)'s, turned into a part
 * of a turn: further out and further round, later.
 *
 * @sideEffects none
 * @returns The dots, row by row.
 */
function gridDots(): Dot[] {
  const half = (SIDE - 1) / 2;
  const dots: Dot[] = [];
  for (let row = 0; row < SIDE; row++) {
    for (let column = 0; column < SIDE; column++) {
      const dx = column - half;
      const dy = row - half;
      const out = Math.hypot(dx, dy);
      if (out > half + 0.3) continue;
      const angle = ((out / half) * 4.4 - Math.atan2(dy, dx)) / (2 * Math.PI);
      dots.push({ x: column + 0.5, y: row + 0.5, phase: angle - Math.floor(angle) });
    }
  }
  return dots;
}

const DOTS = gridDots();

/**
 * How lit a dot is this far through a turn past its phase.
 *
 * @remarks
 * Three levels, as the keyframes in styles.css step through: full where the arm is (cosine above
 * 0.6), half on either side of it (above 0), dim elsewhere. Used for the frame held when motion is
 * reduced.
 *
 * @sideEffects none
 * @param part - How far through the turn, past the dot's phase.
 * @returns The opacity.
 */
function lightAt(part: number): number {
  const wave = Math.cos(2 * Math.PI * part);
  return wave > 0.6 ? 1 : wave > 0 ? 0.55 : 0.2;
}

/**
 * How far into a turn `ms` is, counting turns from 0.
 *
 * @remarks
 * A remainder that stays positive for negative times.
 *
 * @sideEffects none
 * @param ms - The time.
 * @returns The time into the turn, 0 up to a turn.
 */
function intoTurn(ms: number): number {
  return ((ms % TURN_MS) + TURN_MS) % TURN_MS;
}

/**
 * The running mark: a round dot matrix with a spiral arm turning across it.
 *
 * @remarks
 * A session (or child) going on, in the sidebar, the tab bar and a child's row (design-language,
 * "会话状态"). Each dot plays the same three-level keyframes, delayed by its phase; the delay also
 * takes off when the mark appeared, on the injected clock, so every mark on screen shows the arm
 * at the same angle however late it came. Under reduced motion the stylesheet stops the keyframes
 * and the inline opacity holds one frame. Coloured by the text's colour.
 *
 * @sideEffects Reads the clock once, when mounted.
 * @param props - The side, in pixels.
 * @returns The mark, hidden from assistive technology.
 */
export function RunningDots({ size }: { readonly size: number }) {
  const clock = useClock();
  const [appeared] = useState(() => clock.now());
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${SIDE} ${SIDE}`}
      width={size}
      height={size}
      fill="currentColor"
      className="shrink-0"
      data-testid="running-dots"
    >
      {DOTS.map((dot) => (
        <circle
          key={`${dot.x},${dot.y}`}
          className="atrium-running-dot"
          cx={dot.x}
          cy={dot.y}
          r={RADIUS}
          style={{
            opacity: lightAt(STILL_AT_MS / TURN_MS - dot.phase),
            animationDelay: `${-intoTurn(appeared - dot.phase * TURN_MS)}ms`,
          }}
        />
      ))}
    </svg>
  );
}
