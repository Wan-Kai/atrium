/** What a program said about itself, as OSC 7501 reports it (herdr's Program Status Protocol). */
export interface Reported {
  /** The state the program reports: `working`, `blocked`, `idle`, `done`, `error`, or its own word. */
  readonly state: string;
  /** Which program said so, when it names itself. */
  readonly app: string | null;
}

/** `ESC ] 7501 ; key=value:key=value ...` */
// oxlint-disable-next-line no-control-regex -- OSC sequences are terminated by control characters.
const OSC_7501 = /\u001b\]7501;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;

/**
 * The last state a program reported, if any.
 *
 * @remarks
 * Herdr's open protocol: a program says whether it is working, blocked or done, and a caller may
 * trust that over guessing from output (SPEC-0009, "agent 操作终端"; research/agent-terminal-tools).
 *
 * @sideEffects none
 * @param data - What the PTY wrote.
 * @returns The last report in it, or `null`.
 */
export function reportedState(data: string): Reported | null {
  let last: Reported | null = null;
  for (const match of data.matchAll(OSC_7501)) {
    const body = match[1] ?? "";
    const fields = new Map(
      body
        .split(":")
        .filter((pair) => pair.includes("="))
        .map((pair) => {
          const at = pair.indexOf("=");
          return [pair.slice(0, at), pair.slice(at + 1)] as const;
        }),
    );
    const state = fields.get("state");
    if (state === undefined || state === "") continue;
    last = { state, app: fields.get("app") ?? null };
  }
  return last;
}

/**
 * Whether a program turned bracketed paste on (`DECSET 2004`), as of the last thing it did.
 *
 * @remarks
 * Read from what the program printed, so text can be sent as one paste only where it means that.
 *
 * @sideEffects none
 * @param data - What the PTY wrote.
 * @param enabled - Whether it was on before.
 * @returns Whether it is on now.
 */
export function pasteAfter(data: string, enabled: boolean): boolean {
  // The last mode change in this chunk wins, so a program that turned it on and off ends up off.
  const on = data.lastIndexOf("\u001b[?2004h");
  const off = data.lastIndexOf("\u001b[?2004l");
  if (on === -1 && off === -1) return enabled;
  return on > off;
}

/** The most of an unfinished escape sequence that is held back, so a broken stream cannot grow. */
const MAX_CARRY = 64;

/**
 * Splits off a trailing escape sequence that is not finished yet.
 *
 * @remarks
 * PTY reads split wherever they like: `\u001b[?20` and `04h` arrive separately, and scanning each
 * read on its own misses the mode change entirely (SPEC-0009, "历史与重放"). What is not finished
 * is held back and joined to the next read; past {@link MAX_CARRY} it is treated as ordinary text
 * so a program that prints a lone ESC cannot stall the stream.
 *
 * @sideEffects none
 * @param text - The bytes to examine, already joined with what was held back.
 * @returns What can be scanned now, and what to hold for the next read.
 */
export function splitComplete(text: string): { complete: string; rest: string } {
  const start = text.lastIndexOf("\u001b");
  if (start === -1) return { complete: text, rest: "" };
  const tail = text.slice(start);
  if (tail.length > MAX_CARRY) return { complete: text, rest: "" };
  if (tail.startsWith("\u001b]")) {
    // OSC ends with BEL or ST; anything else is unfinished (or, past the cap, plain text).
    return tail.includes("\u0007") || tail.includes("\u001b\\")
      ? { complete: text, rest: "" }
      : { complete: text.slice(0, start), rest: tail };
  }
  if (tail.startsWith("\u001b[")) {
    // CSI ends with a byte in 0x40–0x7e after the parameters.
    const final = /[\u0040-\u007e]/.test(tail.slice(2));
    return final ? { complete: text, rest: "" } : { complete: text.slice(0, start), rest: tail };
  }
  // ESC and one character, or a lone ESC that may be the start of one.
  return tail.length >= 2 ? { complete: text, rest: "" } : { complete: text.slice(0, start), rest: tail };
}
