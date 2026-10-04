// Framing rules follow pi's `src/modes/rpc/jsonl.ts` (MIT License, Copyright (c) 2025 Mario Zechner).
import { StringDecoder } from "node:string_decoder";

/** Splits a byte stream into lines; feed it chunks as they arrive. */
export interface LineSplitter {
  /** Adds a chunk; calls `onLine` for every line it completes. */
  push(chunk: Uint8Array): void;
  /** Flushes the last line if the stream ended without a newline. */
  end(): void;
}

/**
 * Creates a strict JSONL line splitter: lines end at LF and nowhere else.
 *
 * @remarks
 * pi frames RPC output with LF only, and JSON strings may legally contain U+2028 and U+2029, which
 * Node's `readline` treats as line breaks (pi-internals.md §3 "传输"). The semantics match pi's own
 * reader: one trailing CR is dropped, and data left at the end of the stream counts as a last
 * line. Unlike pi's reader, each chunk is scanned once and the unfinished line is only appended
 * to, so a multi-megabyte line (a large `get_entries` response) arriving in small chunks costs
 * linear time instead of rescanning the whole buffer on every chunk. A UTF-8 character split
 * across chunks is reassembled by the decoder. Empty lines are passed on; the caller decides what
 * to do with them.
 *
 * @sideEffects none
 * @param onLine - Called with each complete line, without its line ending.
 * @returns The splitter.
 */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  // UTF-8 is the default encoding.
  const decoder = new StringDecoder();
  let unfinished = "";

  /**
   * Emits a line without one trailing CR.
   *
   * @remarks
   * Matches pi's reader, which tolerates CRLF.
   *
   * @sideEffects Calls `onLine`.
   * @param line - The line without its LF.
   */
  function emit(line: string): void {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  return {
    push(chunk) {
      const text = decoder.write(chunk);
      let newline = text.indexOf("\n");
      if (newline === -1) {
        unfinished += text;
        return;
      }
      emit(unfinished + text.slice(0, newline));
      let start = newline + 1;
      for (newline = text.indexOf("\n", start); newline !== -1; newline = text.indexOf("\n", start)) {
        emit(text.slice(start, newline));
        start = newline + 1;
      }
      unfinished = text.slice(start);
    },
    end() {
      const rest = unfinished + decoder.end();
      unfinished = "";
      if (rest.length > 0) emit(rest);
    },
  };
}

/**
 * Serializes one value as a JSONL record.
 *
 * @remarks
 * `JSON.stringify` escapes LF inside strings, so the only LF in the result is the terminator,
 * which is what pi's reader splits on.
 *
 * @sideEffects none
 * @param value - A JSON-serializable value.
 * @returns The record with its trailing LF.
 */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
