import { Terminal } from "@xterm/headless";

/** What a screen read gives back (SPEC-0009, "agent 操作终端"). */
export interface ScreenReading {
  /** The visible screen as plain text, trailing spaces cut, at most the line and byte caps. */
  readonly text: string;
  readonly cols: number;
  readonly rows: number;
  /** The cursor's position, zero-based, so a caller can tell a prompt from a running program's output. */
  readonly cursor: { readonly row: number; readonly col: number };
}

/** The most lines one read returns. */
const SCREEN_READ_LINES = 200;

/** The most bytes one read returns. */
const SCREEN_READ_BYTES = 32 * 1024;

/** A terminal's screen, kept in step with what its PTY writes. */
export interface TerminalScreen {
  /** Feeds bytes from the PTY. */
  write(data: string): void;
  /** Matches the PTY's size. */
  resize(cols: number, rows: number): void;
  /** The visible screen, oldest line first, once everything written so far has been processed. */
  read(lines?: number): Promise<ScreenReading>;
}

/**
 * Keeps a terminal's screen for reading, without drawing it.
 *
 * @remarks
 * An agent cannot read raw PTY output: it is escape sequences. `@xterm/headless` is the same
 * emulator the client uses, so what the agent reads is what a person would see (SPEC-0009, "agent
 * 操作终端"). It never participates in rendering, and a host that never reads a screen pays only
 * for keeping it current.
 *
 * @sideEffects Allocates a screen sized `cols` by `rows`.
 * @param cols - Columns the PTY was opened with.
 * @param rows - Rows the PTY was opened with.
 * @returns The screen.
 */
export function createScreen(cols: number, rows: number): TerminalScreen {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  /** Resolves once everything written has been processed; xterm's writes are queued, not applied. */
  let ready: Promise<void> = Promise.resolve();

  /**
   * One line of the screen as text.
   *
   * @remarks
   * `translateToString(true)` cuts the blank cells a terminal pads with, which is what a reader wants.
   *
   * @sideEffects none
   * @param line - Its row, zero-based.
   * @returns The line, or an empty string past the screen.
   */
  const text = (line: number): string => terminal.buffer.active.getLine(line)?.translateToString(true) ?? "";

  return {
    write(data) {
      ready = new Promise((resolve) => {
        terminal.write(data, resolve);
      });
    },
    resize(nextCols, nextRows) {
      terminal.resize(nextCols, nextRows);
    },
    async read(limit = SCREEN_READ_LINES) {
      await ready;
      const count = Math.min(Math.max(1, limit), SCREEN_READ_LINES, terminal.rows);
      const lines: string[] = [];
      let bytes = 0;
      // From the bottom up, so a cap keeps what is nearest the prompt; reversed before returning.
      // Blank rows below the last line are the empty part of the screen, not content to report.
      let content = false;
      for (let row = terminal.rows - 1; row >= 0 && lines.length < count; row -= 1) {
        const line = text(row);
        if (!content && line === "") continue;
        content = true;
        const size = Buffer.byteLength(line, "utf8") + 1;
        if (bytes + size > SCREEN_READ_BYTES) break;
        bytes += size;
        lines.push(line);
      }
      return {
        text: lines.toReversed().join("\n"),
        cols: terminal.cols,
        rows: terminal.rows,
        cursor: { row: terminal.buffer.active.cursorY, col: terminal.buffer.active.cursorX },
      };
    },
  };
}
