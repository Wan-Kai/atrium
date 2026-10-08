import { describe, expect, it } from "vitest";
import { contentText, countDiffLines, toolDetails } from "./tools";

describe("countDiffLines", () => {
  it("counts the lines pi's display diff marks as added and removed, and nothing else", () => {
    expect(countDiffLines(" 1 a-b\n-2 b\n+2 c+d\n+3 d\n    ...\n 9 z")).toStrictEqual({ added: 2, removed: 1 });
  });

  it("counts nothing in an empty diff", () => {
    expect(countDiffLines("")).toStrictEqual({ added: 0, removed: 0 });
  });
});

describe("toolDetails", () => {
  it("shows a bash call's command", () => {
    expect(toolDetails("bash", { command: "ls -la", timeout: 5 })).toStrictEqual({ tool: "bash", command: "ls -la" });
  });

  it("shows a read call's path and range, or no range when the model gave none or a fraction", () => {
    expect(toolDetails("read", { path: "a.ts", offset: 10, limit: 20 })).toStrictEqual({
      tool: "read",
      path: "a.ts",
      offset: 10,
      limit: 20,
    });
    expect(toolDetails("read", { path: "a.ts", offset: 1.5, limit: "20" })).toStrictEqual({
      tool: "read",
      path: "a.ts",
      offset: null,
      limit: null,
    });
  });

  it("reads the path under the older name `file_path` too, preferring `path`", () => {
    expect(toolDetails("read", { file_path: "old.ts" })).toStrictEqual({
      tool: "read",
      path: "old.ts",
      offset: null,
      limit: null,
    });
    expect(toolDetails("write", { path: "new.ts", file_path: "old.ts", content: "x" })).toStrictEqual({
      tool: "write",
      path: "new.ts",
      content: "x",
    });
  });

  it("shows an edit's display diff and its counts once the result has one", () => {
    expect(
      toolDetails("edit", { path: "notes.txt", edits: [] }, { diff: " 1 a\n-2 b\n+2 c\n+3 d", patch: "…" }),
    ).toStrictEqual({ tool: "edit", path: "notes.txt", diff: " 1 a\n-2 b\n+2 c\n+3 d", added: 2, removed: 1 });
  });

  it("shows an edit without a diff while it runs, or when the result's details hold none", () => {
    const empty = { tool: "edit", path: "notes.txt", diff: null, added: 0, removed: 0 };

    expect(toolDetails("edit", { path: "notes.txt" })).toStrictEqual(empty);
    expect(toolDetails("edit", { path: "notes.txt" }, null)).toStrictEqual(empty);
    expect(toolDetails("edit", { path: "notes.txt" }, { patch: "…" })).toStrictEqual(empty);
    expect(toolDetails("edit", { path: "notes.txt" }, { diff: 3 })).toStrictEqual(empty);
    expect(toolDetails("edit", { path: "notes.txt" }, "diff")).toStrictEqual(empty);
  });

  it("shows what a write call writes, which only its arguments hold", () => {
    expect(toolDetails("write", { path: "notes.txt", content: "a\nb\n" }, null)).toStrictEqual({
      tool: "write",
      path: "notes.txt",
      content: "a\nb\n",
    });
  });

  it("has no details for a call missing the fields its tool shows", () => {
    expect(toolDetails("bash", { cmd: "ls" })).toBeNull();
    expect(toolDetails("read", { path: 3 })).toBeNull();
    expect(toolDetails("edit", {}, { diff: "+1 a" })).toBeNull();
    expect(toolDetails("write", { path: "a.ts" })).toBeNull();
    expect(toolDetails("write", { content: "x" })).toBeNull();
  });

  it("has no details for a tool other than pi's built-in four", () => {
    expect(toolDetails("grep", { path: "a.ts", command: "x" })).toBeNull();
  });
});

describe("contentText", () => {
  it("takes a string as it is", () => {
    expect(contentText("hello")).toStrictEqual({ text: "hello", images: 0 });
  });

  it("joins text blocks with newlines and counts image blocks", () => {
    expect(
      contentText([
        { type: "text", text: "first" },
        { type: "image" },
        { type: "text" },
        { type: "text", text: "second" },
        { type: "image" },
        { type: "unknown", text: "skipped" },
      ]),
    ).toStrictEqual({ text: "first\nsecond", images: 2 });
  });

  it("gives empty text for no blocks", () => {
    expect(contentText([])).toStrictEqual({ text: "", images: 0 });
  });
});
