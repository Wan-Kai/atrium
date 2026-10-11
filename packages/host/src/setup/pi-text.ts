import { PI_TEXT_MAX } from "@atrium/protocol";

/**
 * Cuts pi's own words to what the protocol carries.
 *
 * @remarks
 * pi's error output and a login's notices can quote a whole page, such as a proxy's HTML error; a
 * message carrying more than the protocol allows would be dropped whole by every client
 * (SPEC-0001, "首次启动 · 接口").
 *
 * @sideEffects none
 * @param text - pi's words.
 * @returns At most {@link PI_TEXT_MAX} characters of them.
 */
export function cutPiText(text: string): string {
  return text.slice(0, PI_TEXT_MAX);
}
