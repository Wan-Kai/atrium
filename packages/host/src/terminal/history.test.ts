import { describe, expect, it } from "vitest";
import { createHistory, withoutQueries } from "./history";

describe("withoutQueries", () => {
  it("drops the queries a replaying terminal would answer", () => {
    expect(withoutQueries("a\u001b[cb\u001b[>0cc\u001b[6nd")).toBe("abcd");
    expect(withoutQueries("x\u001b]11;?\u0007y")).toBe("xy");
  });

  it("keeps ordinary output, colours and links", () => {
    const text = "\u001b[31mred\u001b]8;;https://a\u001b\\link\u001b]8;;\u001b\\\u001b[0m";
    expect(withoutQueries(text)).toBe(text);
  });
});

describe("createHistory", () => {
  it("returns what was written, oldest first", () => {
    const history = createHistory();
    history.push("one\r\n");
    history.push("two\r\n");
    expect(history.text()).toBe("one\r\ntwo\r\n");
  });

  it("evicts whole chunks by lines, keeping the newest", () => {
    const history = createHistory({ lines: 2, bytes: 1024 });
    history.push("1\n");
    history.push("2\n");
    history.push("3\n");
    expect(history.text()).toBe("2\n3\n");
  });

  it("evicts by bytes so one long line cannot bypass the cap", () => {
    const history = createHistory({ lines: 100, bytes: 8 });
    history.push("abcd");
    history.push("efgh");
    history.push("ijkl");
    // The oldest chunk goes; what is left fits the byte cap exactly.
    expect(history.text()).toBe("efghijkl");
  });

  it("keeps a single chunk larger than the cap in full", () => {
    const history = createHistory({ lines: 1, bytes: 4 });
    history.push("0123456789");
    expect(history.text()).toBe("0123456789");
  });

  it("does not cut a code point when evicting", () => {
    const history = createHistory({ lines: 100, bytes: 5 });
    history.push("中文");
    history.push("abc");
    expect(history.text()).toBe("abc");
    expect(history.text()).not.toContain("\uFFFD");
  });

  it("forgets everything when cleared", () => {
    const history = createHistory();
    history.push("gone");
    history.clear();
    expect(history.text()).toBe("");
  });

  it("keeps what the terminal wrote, without its queries", () => {
    const history = createHistory();
    history.push("$ echo \u001b[6n hi\r\n");
    expect(history.text()).toBe("$ echo  hi\r\n");
  });
});
