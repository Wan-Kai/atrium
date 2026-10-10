import { describe, expect, it } from "vitest";
import {
  addedFileHunks,
  countLines,
  isLikelyBinary,
  parseHunks,
  parseNameStatus,
  parseNumstat,
  parseShortstat,
  splitPatch,
} from "./diff-text";

describe("parseShortstat", () => {
  it("reads what git's --shortstat says, either part missing", () => {
    expect(parseShortstat(" 3 files changed, 12 insertions(+), 4 deletions(-)\n")).toStrictEqual({
      added: 12,
      removed: 4,
    });
    expect(parseShortstat(" 1 file changed, 1 insertion(+)\n")).toStrictEqual({ added: 1, removed: 0 });
    expect(parseShortstat(" 1 file changed, 2 deletions(-)\n")).toStrictEqual({ added: 0, removed: 2 });
    expect(parseShortstat("")).toStrictEqual({ added: 0, removed: 0 });
  });
});

describe("parseNumstat", () => {
  it("reads -z numstat: counts, binary files, and renames with both paths", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\0-\t-\tlogo.png\x000\t0\t\0old name.ts\0new\tname.ts\0")).toStrictEqual([
      { path: "src/a.ts", oldPath: null, added: 3, removed: 1, binary: false },
      { path: "logo.png", oldPath: null, added: 0, removed: 0, binary: true },
      { path: "new\tname.ts", oldPath: "old name.ts", added: 0, removed: 0, binary: false },
    ]);
    expect(parseNumstat("")).toStrictEqual([]);
  });
});

describe("parseNameStatus", () => {
  it("reads -z name-status into each new path's status, renames and copies by their new path", () => {
    expect(parseNameStatus("M\0a.ts\0A\0b.ts\0D\0c.ts\0R087\0d.ts\0e.ts\0C100\0f.ts\0g.ts\0T\0h\0")).toStrictEqual(
      new Map([
        ["a.ts", "modified"],
        ["b.ts", "added"],
        ["c.ts", "deleted"],
        ["e.ts", "renamed"],
        ["g.ts", "added"],
        ["h", "modified"],
      ]),
    );
  });
});

describe("splitPatch", () => {
  it("splits a patch into one section a file", () => {
    const first = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n";
    const second = "diff --git a/b b/b\nBinary files a/b and b/b differ\n";

    expect(splitPatch(first + second)).toStrictEqual([first, second]);
    expect(splitPatch("")).toStrictEqual([]);
  });
});

describe("parseHunks", () => {
  it("numbers each line, old and new, through every hunk, skipping git's notes", () => {
    const section = [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@ function a()",
      " one",
      "-two",
      "+deux",
      " three",
      "@@ -10 +10,2 @@",
      " ten",
      "+eleven",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    expect(parseHunks(section)).toStrictEqual([
      {
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 3,
        lines: [
          { kind: "context", oldNumber: 1, newNumber: 1, text: "one" },
          { kind: "del", oldNumber: 2, newNumber: null, text: "two" },
          { kind: "add", oldNumber: null, newNumber: 2, text: "deux" },
          { kind: "context", oldNumber: 3, newNumber: 3, text: "three" },
        ],
      },
      {
        oldStart: 10,
        oldCount: 1,
        newStart: 10,
        newCount: 2,
        lines: [
          { kind: "context", oldNumber: 10, newNumber: 10, text: "ten" },
          { kind: "add", oldNumber: null, newNumber: 11, text: "eleven" },
        ],
      },
    ]);
  });

  it("takes a line that looks like a header inside a hunk as a line", () => {
    const section = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- not a header\n++++ nor this\n";

    expect(parseHunks(section)[0]?.lines).toStrictEqual([
      { kind: "del", oldNumber: 1, newNumber: null, text: "-- not a header" },
      { kind: "add", oldNumber: null, newNumber: 1, text: "+++ nor this" },
    ]);
  });

  it("finds no hunks in a binary file's section", () => {
    expect(parseHunks("diff --git a/b b/b\nBinary files a/b and b/b differ\n")).toStrictEqual([]);
  });
});

describe("isLikelyBinary", () => {
  it("calls text with a zero byte, or with more than 30% control bytes, binary", () => {
    expect(isLikelyBinary(Buffer.from("plain text\n\twith tabs\r\n"))).toBe(false);
    expect(isLikelyBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    expect(isLikelyBinary(Buffer.from([1, 2, 3, 0x61, 0x62, 0x63, 0x64]))).toBe(true);
    expect(isLikelyBinary(Buffer.from([1, 2, 0x61, 0x62, 0x63, 0x64, 0x65]))).toBe(false);
    expect(isLikelyBinary(Buffer.from([0x7f, 0x7f, 0x7f, 0x61]))).toBe(true);
    expect(isLikelyBinary(Buffer.from("中文也是文字"))).toBe(false);
    expect(isLikelyBinary(Buffer.alloc(0))).toBe(false);
  });
});

describe("countLines", () => {
  it("counts lines, a last line break making none, CRLF as one", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\r\nb")).toBe(2);
    expect(countLines("a")).toBe(1);
    expect(countLines("")).toBe(0);
  });
});

describe("addedFileHunks", () => {
  it("shows a new file as one hunk of added lines", () => {
    expect(addedFileHunks("a\nb\n")).toStrictEqual([
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: 2,
        lines: [
          { kind: "add", oldNumber: null, newNumber: 1, text: "a" },
          { kind: "add", oldNumber: null, newNumber: 2, text: "b" },
        ],
      },
    ]);
    expect(addedFileHunks("")).toStrictEqual([]);
  });
});
