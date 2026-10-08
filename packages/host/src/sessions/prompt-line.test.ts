import { describe, expect, it } from "vitest";
import { PROMPT_LINE_LIMIT, promptLine } from "./prompt-line";

describe("promptLine", () => {
  it.each([
    ["the first line of several", "fix the build\nit fails on CI", "fix the build"],
    ["after blank lines and spaces", "\n\n   重构宿主进程管理  \nmore", "重构宿主进程管理"],
    ["a heading", "## Plan the sidebar", "Plan the sidebar"],
    ["a quote", "> why does this fail", "why does this fail"],
    ["a list item", "- add tests", "add tests"],
    ["a numbered item", "1. first step", "first step"],
    ["a task item", "- [x] done thing", "done thing"],
    ["a quoted list item", "> - nested", "nested"],
    ["emphasis", "make **this** and __that__ ~~not~~ *soft* _too_", "make this and that not soft too"],
    ["code", "run `pnpm check` now", "run pnpm check now"],
    ["a link", "see [the docs](https://example.com) first", "see the docs first"],
    ["an image", "![screenshot](a.png) looks off", "screenshot looks off"],
    ["a snake_case name", "rename foo_bar_baz", "rename foo_bar_baz"],
    ["an arithmetic star", "2 * 3 * 4", "2 * 3 * 4"],
  ])("takes %s", (_case, prompt, line) => {
    expect(promptLine(prompt)).toBe(line);
  });

  it("has no line for no prompt or nothing left", () => {
    expect(promptLine(null)).toBeNull();
    expect(promptLine("   \n  ")).toBeNull();
    expect(promptLine("# ")).toBeNull();
    expect(promptLine("**")).toBeNull();
  });

  it(`cuts at ${PROMPT_LINE_LIMIT} characters, never inside one`, () => {
    expect(promptLine("x".repeat(PROMPT_LINE_LIMIT + 5))).toBe("x".repeat(PROMPT_LINE_LIMIT));
    expect(promptLine("😀".repeat(PROMPT_LINE_LIMIT + 1))).toBe("😀".repeat(PROMPT_LINE_LIMIT));
  });
});
