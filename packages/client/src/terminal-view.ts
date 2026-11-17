import type { Terminal } from "@atrium/protocol";

/** Terminals open on this connection, in the order they were opened, for the tab bar (SPEC-0009). */
export interface TerminalsView {
  /** `idle` until the host says something about a terminal; the list is empty then. */
  readonly status: "idle" | "ready";
  /** Open terminals; the tab bar follows this order. */
  readonly terminals: readonly Terminal[];
  /** Goes up on every connection, so a pane knows to attach again (SPEC-0009, "生命周期"). */
  readonly generation: number;
}

/** The terminal list before the host has said anything. */
export const NO_TERMINALS: TerminalsView = { status: "idle", terminals: [], generation: 0 };

/**
 * The list with one terminal added or replaced, keeping its position.
 *
 * @remarks
 * `terminal_opened` can arrive for a terminal this client just opened through its own answer; in
 * that case the terminal is already in the list and only its fields are replaced, so the tab does
 * not jump to the end.
 *
 * @sideEffects none
 * @param terminals - The list as it was.
 * @param terminal - The terminal to add or replace.
 * @returns A new list.
 */
export function withTerminal(terminals: readonly Terminal[], terminal: Terminal): readonly Terminal[] {
  return terminals.some((open) => open.id === terminal.id)
    ? terminals.map((open) => (open.id === terminal.id ? terminal : open))
    : [...terminals, terminal];
}

/**
 * The list with one terminal marked as ended.
 *
 * @remarks
 * The tab stays so the output can still be read and the terminal can be started again; only the
 * process is gone. A terminal this client does not know is ignored.
 *
 * @sideEffects none
 * @param terminals - The list as it was.
 * @param terminalId - The terminal that ended.
 * @param exitCode - What its process returned.
 * @returns A new list.
 */
export function withExit(terminals: readonly Terminal[], terminalId: string, exitCode: number): readonly Terminal[] {
  return terminals.map((open) => (open.id === terminalId ? { ...open, state: "exited" as const, exitCode } : open));
}
