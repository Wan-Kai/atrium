/** Colours, cursor moves and window titles in a terminal's output. */
// oxlint-disable-next-line no-control-regex -- escape sequences are control characters.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/**
 * The lines an install job's output shows, as a terminal would.
 *
 * @remarks
 * The host sends the output raw; colours and `\r` are the UI's to handle (SPEC-0001, "首次启动 ·
 * 接口"). Escape sequences are dropped, and text after a `\r` writes over the start of its line, as
 * progress bars expect. A last empty line, after the final newline, is not a line.
 *
 * @sideEffects none
 * @param output - The output.
 * @returns Its lines.
 */
export function terminalLines(output: string): string[] {
  const lines = output
    .replace(ESCAPES, "")
    .split("\n")
    .map((line) => line.split("\r").reduce((shown, segment) => segment + shown.slice(segment.length), ""));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
