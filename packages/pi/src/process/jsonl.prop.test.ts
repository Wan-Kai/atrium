import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createLineSplitter, serializeJsonLine } from "./jsonl";

/** Strings rich in the characters that break naive framing: separators, CR, LF and multibyte. */
const awkwardString = fc.string({
  unit: fc.constantFrom(
    String.fromCodePoint(0x2028),
    String.fromCodePoint(0x2029),
    "\r",
    "\n",
    "中",
    "😀",
    "a",
    '"',
    "\\",
  ),
});

const record = fc.oneof(
  fc.jsonValue({ stringUnit: "binary" }),
  awkwardString,
  fc.dictionary(awkwardString, awkwardString),
);

/** Cuts `bytes` at the given positions (in any order, duplicates allowed). */
function cut(bytes: Buffer, positions: readonly number[]): Buffer[] {
  const points = [...new Set(positions.map((position) => position % (bytes.length + 1)))].toSorted((a, b) => a - b);
  return [0, ...points].map((start, index) => bytes.subarray(start, points[index] ?? bytes.length));
}

describe("JSONL framing", () => {
  it("reads back every record however the byte stream is chunked", () => {
    fc.assert(
      fc.property(fc.array(record, { maxLength: 20 }), fc.array(fc.nat(), { maxLength: 30 }), (values, positions) => {
        const bytes = Buffer.from(values.map(serializeJsonLine).join(""));
        const lines: string[] = [];
        const splitter = createLineSplitter((line) => lines.push(line));

        for (const chunk of cut(bytes, positions)) splitter.push(chunk);
        splitter.end();

        expect(lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual(
          values.map((value) => JSON.parse(JSON.stringify(value)) as unknown),
        );
      }),
    );
  });
});
