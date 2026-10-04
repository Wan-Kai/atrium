import { describe, expect, it } from "vitest";
import { createLineSplitter, serializeJsonLine } from "./jsonl";

/** Written as code points because the formatter turns escapes into invisible raw characters. */
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);

/** Feeds the chunks to a fresh splitter, ends it, and returns every line it emitted. */
function split(...chunks: (string | Uint8Array)[]): string[] {
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  for (const chunk of chunks) splitter.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  splitter.end();
  return lines;
}

describe("createLineSplitter", () => {
  it("splits on LF only, keeping U+2028, U+2029 and a CR inside a line", () => {
    const separators = `{"a":"x${LINE_SEPARATOR}y${PARAGRAPH_SEPARATOR}z"}`;

    expect(split(`${separators}\n{"b":"p\rq"}\n`)).toStrictEqual([separators, '{"b":"p\rq"}']);
  });

  it("drops exactly one trailing CR", () => {
    expect(split("one\r\ntwo\r\r\n")).toStrictEqual(["one", "two\r"]);
  });

  it("joins a line that arrives over several chunks", () => {
    expect(split('{"te', 'xt":', '"hi"}\n{"n":1}', "\n")).toStrictEqual(['{"text":"hi"}', '{"n":1}']);
  });

  it("emits every line of a chunk that holds several", () => {
    expect(split("a\nb\nc\nd")).toStrictEqual(["a", "b", "c", "d"]);
  });

  it("reassembles a multibyte character split between chunks", () => {
    const bytes = Buffer.from("中😀\n");

    expect(split(bytes.subarray(0, 1), bytes.subarray(1, 5), bytes.subarray(5))).toStrictEqual(["中😀"]);
  });

  it("passes empty lines on", () => {
    expect(split("\n\na\n")).toStrictEqual(["", "", "a"]);
  });

  it("emits an unterminated last line only when the stream ends", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));

    splitter.push(Buffer.from("done\npartial"));
    expect(lines).toStrictEqual(["done"]);
    splitter.end();
    expect(lines).toStrictEqual(["done", "partial"]);
  });

  it("emits nothing extra when the stream ends after a newline", () => {
    expect(split("a\n")).toStrictEqual(["a"]);
  });

  it("does not repeat the unfinished part after flushing it", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));

    splitter.push(Buffer.from("x"));
    splitter.end();
    splitter.end();
    expect(lines).toStrictEqual(["x"]);
  });
});

describe("serializeJsonLine", () => {
  it("writes one record with a single LF at the end, escaping LF inside strings", () => {
    expect(serializeJsonLine({ text: "a\nb" })).toBe('{"text":"a\\nb"}\n');
  });
});
