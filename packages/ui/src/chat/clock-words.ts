/**
 * The time something happened, as the transcript shows it: hours and minutes.
 *
 * @remarks
 * In the user's time zone and in 24 hours, as the conversation's own times are. Shared by the review card and the
 * task conversation's rail, so the generic card does not depend on the tasks' code (T8 review fix 17).
 *
 * @sideEffects none
 * @param at - Epoch milliseconds.
 * @returns "10:44".
 */
export function clockWords(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
