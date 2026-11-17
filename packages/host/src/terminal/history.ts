import { TERMINAL_HISTORY_BYTES, TERMINAL_HISTORY_LINES } from "@atrium/protocol";

/** What a terminal's retained output looks like as it grows. */
export interface TerminalHistory {
  /** Adds what the PTY wrote. */
  push(data: string): void;
  /** Everything still retained, oldest first, ready to replay into a new terminal. */
  text(): string;
  /** Forgets everything, as clearing the terminal does. */
  clear(): void;
}

/**
 * Terminal queries whose answers would be junk in a replayed screen.
 *
 * @remarks
 * A terminal answers `CSI c`, `CSI > c` and DSR `CSI 6n`; replaying a recorded query into a new
 * terminal makes it answer again, and that answer reaches the shell as typed characters
 * (SPEC-0009, "历史与重放"; T3 strips the same traffic).
 */
// oxlint-disable-next-line no-control-regex -- terminal escapes are control characters by definition.
const QUERY_SEQUENCES = /\u001b\[(?:>?[0-9;]*c|6n)|\u001b\](?:10|11|12|4);\?(?:\u0007|\u001b\\)/g;

/**
 * Drops terminal queries from output before it is retained.
 *
 * @remarks
 * Only queries are removed, not the answers: a program's own output may legitimately print `c`.
 *
 * @sideEffects none
 * @param data - What the PTY wrote.
 * @returns It without the query sequences.
 */
export function withoutQueries(data: string): string {
  return data.replace(QUERY_SEQUENCES, "");
}

/**
 * How many newlines a chunk holds.
 *
 * @remarks
 * Counted per chunk when it is added, so evicting one need not rescan the rest of the buffer.
 *
 * @sideEffects none
 * @param chunk - The output.
 * @returns Its number of line breaks.
 */
function lineBreaks(chunk: string): number {
  return chunk.split("\n").length - 1;
}

/**
 * Bounded output kept for one terminal, by lines and bytes.
 *
 * @remarks
 * Live output is never truncated; only what is already retained is evicted, oldest first, and
 * never inside a code point. The byte cap is checked with `Buffer.byteLength` so one long line
 * cannot bypass it.
 *
 * @sideEffects none
 * @param limits - The caps; defaults are the protocol's.
 * @returns The history.
 */
export function createHistory(limits: { lines?: number; bytes?: number } = {}): TerminalHistory {
  const maxLines = limits.lines ?? TERMINAL_HISTORY_LINES;
  const maxBytes = limits.bytes ?? TERMINAL_HISTORY_BYTES;
  let chunks: string[] = [];
  let lines = 0;
  let bytes = 0;

  return {
    push(data) {
      const clean = withoutQueries(data);
      if (clean === "") return;
      chunks.push(clean);
      lines += lineBreaks(clean);
      bytes += Buffer.byteLength(clean, "utf8");
      // Evict whole chunks while the caps are exceeded; the newest chunk is then trimmed from the
      // front, so one huge write cannot leave the history over its caps (SPEC-0009, "历史与重放").
      while (chunks.length > 1 && (lines > maxLines || bytes > maxBytes)) {
        const dropped = chunks.shift();
        if (dropped === undefined) break;
        lines -= lineBreaks(dropped);
        bytes -= Buffer.byteLength(dropped, "utf8");
      }
      if (chunks.length === 1 && (lines > maxLines || bytes > maxBytes)) {
        const whole = chunks[0] ?? "";
        let cut = 0;
        let keptLines = lines;
        let keptBytes = bytes;
        // Drop characters from the front, one code point at a time, until it fits.
        for (const character of whole) {
          if (keptLines <= maxLines && keptBytes <= maxBytes) break;
          cut += character.length;
          keptLines -= character === "\n" ? 1 : 0;
          keptBytes -= Buffer.byteLength(character, "utf8");
        }
        const kept = whole.slice(cut);
        chunks[0] = kept;
        lines = keptLines;
        bytes = keptBytes;
      }
    },
    text() {
      return chunks.join("");
    },
    clear() {
      chunks = [];
      lines = 0;
      bytes = 0;
    },
  };
}
