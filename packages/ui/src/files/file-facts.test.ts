import { describe, expect, it } from "vitest";
import { formatSize, highlightable, linesOf } from "./file-facts";

describe("formatSize", () => {
  it("writes bytes under a KB, then KB and MB by 1024 with one decimal", () => {
    expect([0, 1023, 1024, 1536, 1024 * 1024 - 1, 1024 * 1024, 10.25 * 1024 * 1024].map(formatSize)).toStrictEqual([
      "0 B",
      "1023 B",
      "1.0 KB",
      "1.5 KB",
      "1024.0 KB",
      "1.0 MB",
      "10.3 MB",
    ]);
  });
});

describe("linesOf", () => {
  it("counts no line for nothing, and none after a last line break", () => {
    expect(["", "a", "a\n", "a\nb", "a\n\n", "\n"].map(linesOf)).toStrictEqual([
      [],
      ["a"],
      ["a"],
      ["a", "b"],
      ["a", ""],
      [""],
    ]);
  });
});

describe("highlightable", () => {
  it("colours files up to 5000 lines and 200 KB", () => {
    expect([highlightable(5000, 200 * 1024), highlightable(5001, 10), highlightable(10, 200 * 1024 + 1)]).toStrictEqual(
      [true, false, false],
    );
  });
});
