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
 * pi frames RPC output with LF only; Node's `readline` also ends lines at a lone CR, and pi's docs
 * warn that it breaks at U+2028 and U+2029, which Node 22 no longer does (pi-internals.md §3
 * "传输"). The semantics match pi's own
 * reader: one trailing CR is dropped, and data left at the end of the stream counts as a last
 * line. Unlike pi's reader, each chunk is scanned once and the unfinished line is only appended
 * to, so a multi-megabyte line (a large `get_entries` response) arriving in small chunks costs
 * linear time instead of rescanning the whole buffer on every chunk. A UTF-8 character split
 * across chunks is reassembled by the decoder. Empty lines are passed on; the caller decides what
 * to do with them. With `maxLineLength`, an unfinished line that grows past it is passed on as it
 * is, so output without line breaks (a progress bar redrawn with CR) cannot grow memory without
 * bound; pi's stdout uses no limit, since one record may legitimately be megabytes.
 *
 * @sideEffects none
 * @param onLine - Called with each complete line, without its line ending.
 * @param options - The longest unfinished line kept, in UTF-16 units.
 * @returns The splitter.
 */
export function createLineSplitter(
  onLine: (line: string) => void,
  options: { readonly maxLineLength?: number } = {},
): LineSplitter {
  const maxLineLength = options.maxLineLength ?? Number.POSITIVE_INFINITY;
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

  /**
   * Keeps the unfinished end of the input, passing it on once it is too long.
   *
   * @remarks
   * See `maxLineLength`.
   *
   * @sideEffects May call `onLine`.
   * @param rest - The text after the last line break.
   */
  function keep(rest: string): void {
    if (rest.length >= maxLineLength) {
      unfinished = "";
      emit(rest);
    } else {
      unfinished = rest;
    }
  }

  return {
    push(chunk) {
      const text = decoder.write(chunk);
      let newline = text.indexOf("\n");
      if (newline === -1) {
        keep(unfinished + text);
        return;
      }
      emit(unfinished + text.slice(0, newline));
      let start = newline + 1;
      for (newline = text.indexOf("\n", start); newline !== -1; newline = text.indexOf("\n", start)) {
        emit(text.slice(start, newline));
        start = newline + 1;
      }
      keep(text.slice(start));
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
