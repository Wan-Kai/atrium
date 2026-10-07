import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters, remarkHtmlAsText } from "./markdown-transforms";

describe("normalizeMathDelimiters", () => {
  it("turns inline \\(…\\) into $$…$$, more than once per line", () => {
    expect(normalizeMathDelimiters(String.raw`面积 \(\pi r^2\)，周长 \(2\pi r\)。`)).toBe(
      String.raw`面积 $$\pi r^2$$，周长 $$2\pi r$$。`,
    );
  });

  it("leaves block math, single dollars and text without delimiters alone", () => {
    const text = "$$\nE = mc^2\n$$\n价格 $5 和 $HOME 不是公式";

    expect(normalizeMathDelimiters(text)).toBe(text);
  });

  it("leaves inline code and fenced code alone, including a fence still open", () => {
    const text = [
      String.raw`在代码里 \(x\) 不变：` + "`\\(x\\)`",
      "```",
      String.raw`echo \(y\)`,
      "```",
      String.raw`然后 \(z\)`,
      "~~~~",
      String.raw`\(open\)`,
      "~~~",
      String.raw`\(still code\)`,
    ].join("\n");

    expect(normalizeMathDelimiters(text)).toBe(
      [
        "在代码里 $$x$$ 不变：`\\(x\\)`",
        "```",
        String.raw`echo \(y\)`,
        "```",
        "然后 $$z$$",
        "~~~~",
        String.raw`\(open\)`,
        "~~~",
        String.raw`\(still code\)`,
      ].join("\n"),
    );
  });

  it("does not let a fence of the other kind or a shorter one close the code", () => {
    const text = ["````", "```", String.raw`\(a\)`, "~~~~", String.raw`\(b\)`, "````", String.raw`\(c\)`].join("\n");

    expect(normalizeMathDelimiters(text).split("\n")).toStrictEqual([
      "````",
      "```",
      String.raw`\(a\)`,
      "~~~~",
      String.raw`\(b\)`,
      "````",
      "$$c$$",
    ]);
  });

  it("starts a fence only at the beginning of a line, and leaves double-backtick code alone", () => {
    const text = ["用 ``` 包起来 \\(a\\)", "\\(b\\) 和 ``\\(c\\)``"].join("\n");

    expect(normalizeMathDelimiters(text).split("\n")).toStrictEqual(["用 ``` 包起来 $$a$$", "$$b$$ 和 ``\\(c\\)``"]);
  });

  it("treats a lone backtick as text, and needs a closing delimiter", () => {
    expect(normalizeMathDelimiters(String.raw`a \` b \(c\) and \(open`)).toBe(String.raw`a \` b $$c$$ and \(open`);
  });
});

describe("remarkHtmlAsText", () => {
  it("turns every HTML node, block or inline, into text with the same source", () => {
    const tree = {
      type: "root",
      children: [
        { type: "html", value: "<script>alert(1)</script>" },
        {
          type: "paragraph",
          children: [
            { type: "text", value: "a " },
            { type: "html", value: "<b>" },
          ],
        },
      ],
    };

    remarkHtmlAsText()(tree);

    expect(tree).toStrictEqual({
      type: "root",
      children: [
        { type: "text", value: "<script>alert(1)</script>" },
        {
          type: "paragraph",
          children: [
            { type: "text", value: "a " },
            { type: "text", value: "<b>" },
          ],
        },
      ],
    });
  });
});
