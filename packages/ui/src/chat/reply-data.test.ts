import { assert, describe, expect, it } from "vitest";
import { parseReplyCsv, parseReplyJson } from "./reply-data";

describe("reply CSV", () => {
  it("reads BOM, CRLF, quoted commas, line breaks and escaped quotes in original order", () => {
    expect(parseReplyCsv('\uFEFFname,note\r\na,"b,c"\r\nd,"two\r\nlines"\r\ne,"a""b"\r\n')).toStrictEqual({
      ok: true,
      value: {
        headers: ["name", "note"],
        rows: [
          ["a", "b,c"],
          ["d", "two\r\nlines"],
          ["e", 'a"b'],
        ],
      },
    });
  });
});

describe("reply CSV limits and strictness", () => {
  it.each(["", "\uFEFF"])("rejects empty CSV %j", (source) => {
    expect(parseReplyCsv(source)).toStrictEqual({ ok: false, reason: "empty" });
  });

  it.each([
    ['""', [""]],
    [",", ["", ""]],
    [",\n", ["", ""]],
    ["\n", [""]],
    ["a,b\r\n", ["a", "b"]],
    [" ", [" "]],
  ])("keeps empty cells and does not invent a row after a terminal newline %j", (source, headers) => {
    expect(parseReplyCsv(source)).toStrictEqual({ ok: true, value: { headers, rows: [] } });
  });

  it("keeps blank data rows, trailing empty cells and inert formula/HTML text", () => {
    expect(parseReplyCsv("x,y\n,\n=1+2,<img src=x>\nlast,")).toStrictEqual({
      ok: true,
      value: {
        headers: ["x", "y"],
        rows: [
          ["", ""],
          ["=1+2", "<img src=x>"],
          ["last", ""],
        ],
      },
    });
    expect(parseReplyCsv("h\n\n")).toStrictEqual({ ok: true, value: { headers: ["h"], rows: [[""]] } });
  });

  it.each(['h\n"unfinished', 'h\na"b', 'h\na"b"', 'h\n"a"b', 'h\n"a" ', "a,b\n1", "a\n1,2"])(
    "rejects malformed CSV without guessing or partial rows %j",
    (source) => {
      expect(parseReplyCsv(source)).toStrictEqual({ ok: false, reason: "invalid" });
    },
  );

  it("bounds CSV source bytes before parsing", () => {
    expect(parseReplyCsv("a".repeat(65536)).ok).toBe(true);
    expect(parseReplyCsv("a".repeat(65537))).toStrictEqual({ ok: false, reason: "size" });
    expect(parseReplyCsv("中".repeat(21846))).toStrictEqual({ ok: false, reason: "size" });
    expect(parseReplyCsv("\uFEFF" + "a".repeat(65534))).toStrictEqual({ ok: false, reason: "size" });
  });

  it("allows 200 data rows but not 201", () => {
    expect(parseReplyCsv("h\n" + "a\n".repeat(200)).ok).toBe(true);
    expect(parseReplyCsv("h\n" + "a\n".repeat(201))).toStrictEqual({ ok: false, reason: "rows" });
  });

  it("allows 50 columns but not 51, including an oversized header", () => {
    expect(parseReplyCsv(",".repeat(49)).ok).toBe(true);
    expect(parseReplyCsv(",".repeat(50))).toStrictEqual({ ok: false, reason: "columns" });
    expect(parseReplyCsv("h\n" + ",".repeat(50))).toStrictEqual({ ok: false, reason: "columns" });
  });

  it("does not skip the first cell character after a bare CR record separator", () => {
    expect(parseReplyCsv("name\rfirst\rsecond")).toStrictEqual({
      ok: true,
      value: { headers: ["name"], rows: [["first"], ["second"]] },
    });
  });

  it("rejects a 51-column record ending in a newline before exposing any table", () => {
    expect(parseReplyCsv(",".repeat(50) + "\n")).toStrictEqual({ ok: false, reason: "columns" });
  });

  it("checks the final CSV cell budget without a terminal newline", () => {
    const fullRecords = (",".repeat(49) + "\n").repeat(99);
    expect(parseReplyCsv(fullRecords + ",".repeat(49)).ok).toBe(true);
    // The 5001st cell is over budget even when the final record is also the wrong width.
    expect(parseReplyCsv(fullRecords + ",".repeat(49) + "\nx")).toStrictEqual({ ok: false, reason: "cells" });
  });

  it("checks the final CSV data-row budget without a terminal newline", () => {
    expect(parseReplyCsv("h\n" + "a\n".repeat(199) + "a").ok).toBe(true);
    expect(parseReplyCsv("h\n" + "a\n".repeat(200) + "a")).toStrictEqual({ ok: false, reason: "rows" });
  });

  it("counts header cells within the 5000-cell budget", () => {
    expect(parseReplyCsv((",".repeat(49) + "\n").repeat(100)).ok).toBe(true);
    expect(parseReplyCsv((",".repeat(49) + "\n").repeat(101))).toStrictEqual({ ok: false, reason: "cells" });
  });
});

describe("reply JSON", () => {
  it("keeps ordered duplicate properties and exact numeric source without object projection", () => {
    const source = '{"id":9223372036854775807,"id":-0,"__proto__":{"safe":true},"text":"<b>hello</b>"}';
    const result = parseReplyJson(source);
    assert(result.ok);
    expect(result.value.type).toBe("object");
    expect(result.value.children?.map((property) => property.children?.[0]?.value)).toStrictEqual([
      "id",
      "id",
      "__proto__",
      "text",
    ]);
    const number = result.value.children?.[0]?.children?.[1];
    assert(number !== undefined);
    expect(source.slice(number.offset, number.offset + number.length)).toBe("9223372036854775807");
  });

  it.each(["false", "null", "0", "-0", "1e+30", '"hello"', "[]", "{}"])("accepts the top-level value %s", (source) => {
    const result = parseReplyJson(source);
    assert(result.ok);
    expect(source.slice(result.value.offset, result.value.offset + result.value.length)).toBe(source);
  });

  it.each([
    '{"a":1,}',
    "[1,]",
    '{/*comment*/"a":1}',
    '{"a":1}//comment',
    '{"a":}',
    "true false",
    '{"a":NaN}',
    "\uFEFF{}",
  ])("rejects invalid strict JSON %s without a partial tree", (source) => {
    expect(parseReplyJson(source)).toStrictEqual({ ok: false, reason: "invalid" });
  });

  it("bounds UTF-8 bytes, including multibyte text, and rejects empty input", () => {
    expect(parseReplyJson("")).toStrictEqual({ ok: false, reason: "empty" });
    expect(parseReplyJson(" \n\t")).toStrictEqual({ ok: false, reason: "empty" });
    expect(parseReplyJson('"' + "a".repeat(65534) + '"').ok).toBe(true);
    expect(parseReplyJson('"' + "a".repeat(65535) + '"')).toStrictEqual({ ok: false, reason: "size" });
    expect(parseReplyJson('"' + "中".repeat(21845) + '"')).toStrictEqual({ ok: false, reason: "size" });
  });

  it("prechecks nesting before recursive parsing, ignoring escaped strings", () => {
    expect(parseReplyJson("[".repeat(64) + "0" + "]".repeat(64)).ok).toBe(true);
    expect(parseReplyJson("[".repeat(65) + "0" + "]".repeat(65))).toStrictEqual({ ok: false, reason: "depth" });
    expect(parseReplyJson("[".repeat(20000))).toStrictEqual({ ok: false, reason: "depth" });
    expect(parseReplyJson(JSON.stringify("[".repeat(100) + '\\"' + "]".repeat(100))).ok).toBe(true);
    expect(parseReplyJson('{"a":"\\\\\\\"[[[", "b":[]}').ok).toBe(true);
  });

  it.each(['/* " */', '// "\n'])(
    "rejects comments before they can hide recursive nesting from the lexical precheck %j",
    (prefix) => {
      expect(parseReplyJson(prefix + "[".repeat(20000))).toStrictEqual({ ok: false, reason: "invalid" });
    },
  );

  it.each(["?", '"\\q"'])("rejects invalid lexical tokens before later nesting can mask the error %j", (prefix) => {
    expect(parseReplyJson(prefix + "[".repeat(65))).toStrictEqual({ ok: false, reason: "invalid" });
  });

  it.each(["{]", "["])("retains the invalid reason for mismatched or unfinished containers %j", (source) => {
    expect(parseReplyJson(source)).toStrictEqual({ ok: false, reason: "invalid" });
  });

  it("counts every AST node, including properties and keys, up to 2000", () => {
    expect(parseReplyJson("[" + Array.from({ length: 1999 }, () => "0").join(",") + "]").ok).toBe(true);
    expect(parseReplyJson("[" + Array.from({ length: 2000 }, () => "0").join(",") + "]")).toStrictEqual({
      ok: false,
      reason: "nodes",
    });
    expect(parseReplyJson("{" + Array.from({ length: 666 }, () => '"k":0').join(",") + "}").ok).toBe(true);
    expect(parseReplyJson("{" + Array.from({ length: 667 }, () => '"k":0').join(",") + "}")).toStrictEqual({
      ok: false,
      reason: "nodes",
    });
  });
});
