import { describe, expect, it } from "vitest";
import { terminalCommand } from "./hand-off";

describe("terminalCommand", () => {
  it("quotes the file for the shell, a quote in it too", () => {
    expect(terminalCommand("/pi/s1.jsonl")).toBe("pi --session '/pi/s1.jsonl'");
    expect(terminalCommand("/Users/x/it's $HOME/s 1.jsonl")).toBe("pi --session '/Users/x/it'\\''s $HOME/s 1.jsonl'");
  });

  it("adds the flags the host gave, quoting only those the shell would read otherwise", () => {
    expect(terminalCommand("/pi/s1.jsonl", ["--tools", "read,grep", "--atrium-x=a b", "it's"])).toBe(
      "pi --session '/pi/s1.jsonl' --tools read,grep '--atrium-x=a b' 'it'\\''s'",
    );
  });
});
