import { describe, expect, it } from "vitest";
import { terminalCommand } from "./hand-off";

describe("terminalCommand", () => {
  it("quotes the file for the shell, a quote in it too", () => {
    expect(terminalCommand("/pi/s1.jsonl")).toBe("pi --session '/pi/s1.jsonl'");
    expect(terminalCommand("/Users/x/it's $HOME/s 1.jsonl")).toBe("pi --session '/Users/x/it'\\''s $HOME/s 1.jsonl'");
  });
});
