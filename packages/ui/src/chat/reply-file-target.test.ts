import { describe, expect, it } from "vitest";
import { replyFileTarget } from "./reply-file-target";

describe("reply file references", () => {
  it("keeps a local path and its explicit line range independently", () => {
    expect(replyFileTarget("./src/auth.ts#L42-L48")).toStrictEqual({
      path: "./src/auth.ts",
      range: { start: 42, end: 48 },
    });
    expect(replyFileTarget("src/auth.ts:42", true)).toStrictEqual({
      path: "src/auth.ts",
      range: { start: 42, end: 42 },
    });
    expect(replyFileTarget("src/auth.ts:42-48", true)).toStrictEqual({
      path: "src/auth.ts",
      range: { start: 42, end: 48 },
    });
    expect(replyFileTarget("file:///work/src/a%20b.ts#L7")).toStrictEqual({
      path: "/work/src/a b.ts",
      range: { start: 7, end: 7 },
    });
    expect(replyFileTarget("README.md")).toStrictEqual({ path: "README.md" });
    expect(replyFileTarget("src/a%3A42")).toStrictEqual({ path: "src/a:42" });
  });

  it.each([
    "",
    "../a.ts:2",
    "src/../a.ts:2",
    "%2e%2e/a.ts:2",
    "a%2fb.ts:2",
    "https://example.com/a.ts:2",
    "javascript:alert(1)",
    "blob:https://example.com/x",
    "//server/a.ts:2",
    "file://remote/work/a.ts#L2",
    "file:///work/../a.ts#L2",
    "a%00.ts#L2",
    "a\\b.ts:2",
    "a\n.ts:2",
    "a.ts#heading",
    "#L2",
    "a.ts?raw=1",
    "bad%",
    "a.ts:0",
    "a.ts#L0",
    "a.ts:7-3",
    "a.ts:9007199254740992",
    "a.ts:1-9007199254740992",
    "file:file:///work/a.ts#L2",
    "~/a.ts:2",
    "src/auth.ts:42:3",
    "src/auth.ts:42:3-8",
    "src/auth.ts:42-48:3",
    "src/auth.ts:42-48:3-8",
  ])("rejects unsafe or unsupported local address %s", (source) => {
    expect(replyFileTarget(source)).toBeNull();
  });

  it("keeps valid first-line targets and literal colons, and enforces the path-length boundary", () => {
    expect(replyFileTarget("src/a.ts#L1")).toStrictEqual({ path: "src/a.ts", range: { start: 1, end: 1 } });
    expect(replyFileTarget("docs/file:example.ts")).toStrictEqual({ path: "docs/file:example.ts" });
    expect(replyFileTarget("docs/route:42.old.ts:7")).toStrictEqual({
      path: "docs/route:42.old.ts",
      range: { start: 7, end: 7 },
    });
    expect(replyFileTarget("a".repeat(4096))).toStrictEqual({ path: "a".repeat(4096) });
    expect(replyFileTarget("a".repeat(4097))).toBeNull();
    expect(replyFileTarget("src/a.ts:42junk", true)).toBeNull();
  });

  it.each([
    "pnpm test",
    "npm run ./a.ts:2",
    "src/auth.ts",
    "count:42",
    "https://example.com/a.ts:2",
    "127.0.0.1:8080",
    "api.example.com:443",
    "example.com:443",
    "[::ffff:127.0.0.1]:8080",
    "auth.ts:42",
  ])("does not turn arbitrary inline code into a file button: %s", (source) => {
    expect(replyFileTarget(source, true)).toBeNull();
  });

  it("keeps unambiguous root-file references without guessing a hostname's extension", () => {
    expect(replyFileTarget("./auth.ts:42", true)).toStrictEqual({ path: "./auth.ts", range: { start: 42, end: 42 } });
    expect(replyFileTarget("auth.ts#L42", true)).toStrictEqual({ path: "auth.ts", range: { start: 42, end: 42 } });
    expect(replyFileTarget("auth.ts:42")).toStrictEqual({ path: "auth.ts", range: { start: 42, end: 42 } });
    expect(replyFileTarget("src/auth%3A42-48:3", true)).toStrictEqual({
      path: "src/auth:42-48",
      range: { start: 3, end: 3 },
    });
  });
});
