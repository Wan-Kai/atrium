/** One frame of the 3900ms upstream-converge / downstream-fan-out cycle. */
export interface PacketFrame {
  readonly direction: "up" | "down" | null;
  /** Fraction along the relay-to-phone lane, or hidden. */
  readonly lane: number | null;
  /** Fraction along the Mac-to-relay trunk, or hidden. */
  readonly trunk: number | null;
  readonly lock: boolean;
}

/**
 * Eases a packet segment in and out with a cubic curve.
 * @remarks Each segment has its own easing, as in the approved link map.
 * @sideEffects none
 * @param value - Progress from zero to one.
 * @returns Eased progress.
 */
function ease(value: number): number {
  // Stryker disable next-line EqualityOperator: both cubic halves equal 0.5 at their shared boundary.
  return value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2;
}

/**
 * Places packets in the upstream/hold/downstream cycle.
 * @remarks The two 1300ms legs have a 300ms gap and 1000ms rest; traffic is text, not timing.
 * @sideEffects none
 * @param elapsed - Milliseconds since the animation began.
 * @returns The direction, packet positions and relay lock state.
 */
export function packetFrame(elapsed: number): PacketFrame {
  const time = elapsed % 3900;
  if (time < 640) return { direction: "up", lane: 1 - ease(time / 640), trunk: null, lock: time > 590 };
  if (time < 780) return { direction: "up", lane: null, trunk: null, lock: true };
  if (time < 1300) return { direction: "up", lane: null, trunk: 1 - ease((time - 780) / 520), lock: time < 820 };
  if (time < 1600) return { direction: null, lane: null, trunk: null, lock: false };
  if (time < 2120) return { direction: "down", lane: null, trunk: ease((time - 1600) / 520), lock: time > 2080 };
  if (time < 2260) return { direction: "down", lane: null, trunk: null, lock: true };
  if (time < 2900) return { direction: "down", lane: ease((time - 2260) / 640), trunk: null, lock: time < 2310 };
  return { direction: null, lane: null, trunk: null, lock: false };
}

/**
 * Locates a point on a symmetric cubic lane.
 * @remarks The geometry matches the prototype's 624×252 map, without DOM path measurements.
 * @sideEffects none
 * @param y - The phone's vertical position.
 * @param fraction - Progress along the lane.
 * @returns The point in map coordinates.
 */
export function lanePoint(y: number, fraction: number): { x: number; y: number } {
  const t = fraction;
  const u = 1 - t;
  return { x: u ** 3 * 268 + 3 * u * t * 352.5 + t ** 3 * 437, y: 112 + (y - 112) * (3 * t ** 2 - 2 * t ** 3) };
}

/**
 * Picks one of the five permanent device colours.
 * @remarks Identity alone determines colour, so renaming, sorting and reconnecting cannot change it.
 * @sideEffects none
 * @param id - The device id.
 * @returns A colour index from zero to four.
 */
export function deviceColor(id: string): number {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return hash % 5;
}
