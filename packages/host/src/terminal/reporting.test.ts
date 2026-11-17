import { describe, expect, it } from "vitest";
import { pasteAfter, reportedState, splitComplete } from "./reporting";

describe("reportedState", () => {
  it("reads the state and the program that reported it", () => {
    expect(reportedState("\u001b]7501;state=blocked:app=claude\u0007")).toStrictEqual({
      state: "blocked",
      app: "claude",
    });
  });

  it("reads a report without a program name", () => {
    expect(reportedState("\u001b]7501;state=working\u0007")).toStrictEqual({ state: "working", app: null });
  });

  it("takes the last report in a chunk", () => {
    const text = "\u001b]7501;state=working\u0007 noise \u001b]7501;state=done:app=pi\u0007";
    expect(reportedState(text)).toStrictEqual({ state: "done", app: "pi" });
  });

  it("ignores a report without a state, and anything else", () => {
    expect(reportedState("\u001b]7501;app=only\u0007")).toBeNull();
    expect(reportedState("plain output")).toBeNull();
  });

  it("accepts the string-terminated form as well", () => {
    expect(reportedState("\u001b]7501;state=idle\u001b\\")).toStrictEqual({ state: "idle", app: null });
  });
});

describe("pasteAfter", () => {
  it("follows the last mode change in a chunk", () => {
    expect(pasteAfter("\u001b[?2004h", false)).toBe(true);
    expect(pasteAfter("\u001b[?2004l", true)).toBe(false);
    expect(pasteAfter("\u001b[?2004h...\u001b[?2004l", true)).toBe(false);
    expect(pasteAfter("\u001b[?2004l...\u001b[?2004h", false)).toBe(true);
  });

  it("keeps the previous state when the chunk says nothing about it", () => {
    expect(pasteAfter("just output", true)).toBe(true);
    expect(pasteAfter("just output", false)).toBe(false);
  });
});

describe("splitComplete", () => {
  it("holds an escape sequence the PTY split, and joins it with the rest", () => {
    const first = splitComplete("\u001b[?20");
    expect(first.complete).toBe("");
    expect(first.rest).toBe("\u001b[?20");
    const second = splitComplete(first.rest + "04h");
    expect(second.complete).toBe("\u001b[?2004h");
    expect(second.rest).toBe("");
  });

  it("holds an unfinished OSC until its terminator arrives", () => {
    expect(splitComplete("\u001b]7501;state=blo").rest).toBe("\u001b]7501;state=blo");
    expect(splitComplete("\u001b]7501;state=blocked\u0007").complete).toBe("\u001b]7501;state=blocked\u0007");
  });

  it("lets ordinary text and finished sequences through at once", () => {
    expect(splitComplete("hello")).toStrictEqual({ complete: "hello", rest: "" });
    expect(splitComplete("\u001b[?2004h")).toStrictEqual({ complete: "\u001b[?2004h", rest: "" });
  });

  it("treats an over-long tail as text, so a lone ESC cannot stall the stream", () => {
    const long = `\u001b[${"1".repeat(80)}`;
    expect(splitComplete(long)).toStrictEqual({ complete: long, rest: "" });
  });
});
