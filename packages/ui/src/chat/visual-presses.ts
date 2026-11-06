/** How long a press counts as "just now", as long as a user activation lasts in Chromium. */
export const PRESS_MS = 5000;

/**
 * The window's latest mouse press, frames included, by what it landed on, each one spent by at
 * most one message.
 *
 * @remarks
 * SPEC-0007, MV1 details: the page alone cannot tell a click inside one visual from another visual
 * focusing itself and borrowing that click's activation, so the desktop shell reports every press,
 * the page notes what was on top where it landed at that moment, and a visual's message needs a
 * fresh, unspent press on its own frame. Bound when pressed, a press on the part of a tall visual
 * the message list clips (the input box is on top there) is not the visual's, and a scroll after it
 * hands it to no other visual (MV1 three-way review).
 *
 * @sideEffects none; the instance keeps the latest press.
 */
export class VisualPresses<Target> {
  #latest: { readonly target: Target | null; readonly at: number } | null = null;

  /**
   * Notes a press.
   *
   * @remarks
   * Only the latest counts.
   *
   * @sideEffects Replaces the latest press.
   * @param target - What was on top where it landed, or `null` for nothing.
   * @param at - When, by the UI's clock.
   */
  pressed(target: Target | null, at: number): void {
    this.#latest = { target, at };
  }

  /**
   * Whether the latest press landed on `target` within `PRESS_MS` of `now`, without spending it.
   *
   * @remarks
   * For checking before the message's other checks have passed.
   *
   * @sideEffects none
   * @param target - The frame.
   * @param now - The UI's time now.
   * @returns Whether it did.
   */
  has(target: Target, now: number): boolean {
    const press = this.#latest;
    return press !== null && press.target === target && now - press.at <= PRESS_MS;
  }

  /**
   * Spends the latest press if it landed on `target` within `PRESS_MS` of `now`.
   *
   * @remarks
   * One press sends at most one message.
   *
   * @sideEffects Forgets the press it spends.
   * @param target - The frame.
   * @param now - The UI's time now.
   * @returns Whether there was such a press.
   */
  spend(target: Target, now: number): boolean {
    if (!this.has(target, now)) return false;
    this.#latest = null;
    return true;
  }
}
