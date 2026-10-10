import { describe, expect, it } from "vitest";
import { terminalLines } from "./terminal-text";

describe("terminalLines", () => {
  it("drops colours and other escapes, and lets a carriage return write over its line", () => {
    const output = [
      "\u001b[1m\u001b[32m✓\u001b[0m node 22.19.0\n",
      "progress 10%\rprogress 80%\rdone\n",
      "abcdef\rxy\n",
      "crlf line\r\n",
      "\u001b]0;title\u0007titled\u001b[2K\n",
      "last without newline",
    ].join("");

    expect(terminalLines(output)).toStrictEqual([
      "✓ node 22.19.0",
      "doneress 80%",
      "xycdef",
      "crlf line",
      "titled",
      "last without newline",
    ]);
  });

  it("keeps empty lines in the middle, and shows nothing for no output", () => {
    expect([terminalLines("a\n\nb\n"), terminalLines("")]).toStrictEqual([["a", "", "b"], []]);
  });
});
