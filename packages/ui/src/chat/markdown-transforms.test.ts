import { describe, expect, it } from "vitest";
import {
  normalizeMathDelimiters,
  remarkHtmlAsText,
  remarkReplyImages,
  remarkReplyFiles,
  remarkReplyData,
  withoutUnfinishedTable,
} from "./markdown-transforms";

describe("reply file addresses", () => {
  it("preserves original local link addresses and only whole file-shaped inline code", () => {
    const tree = {
      type: "root",
      children: [
        { type: "link", url: "./src/a.ts#L7", children: [{ type: "text", value: "文件" }] },
        { type: "inlineCode", value: "src/a.ts:7-9" },
        { type: "inlineCode", value: "pnpm test" },
        { type: "link", url: "https://example.com", children: [{ type: "inlineCode", value: "src/a.ts:7" }] },
      ],
    };
    remarkReplyFiles()(tree);
    expect(tree).toStrictEqual({
      type: "root",
      children: [
        {
          type: "link",
          url: "./src/a.ts#L7",
          children: [{ type: "text", value: "文件" }],
          data: { hName: "atrium-file", hProperties: { source: "./src/a.ts#L7", inline: "false" } },
        },
        {
          type: "inlineCode",
          value: "src/a.ts:7-9",
          data: { hName: "atrium-file", hProperties: { source: "src/a.ts:7-9", inline: "true" } },
        },
        { type: "inlineCode", value: "pnpm test" },
        { type: "link", url: "https://example.com", children: [{ type: "inlineCode", value: "src/a.ts:7" }] },
      ],
    });
  });
});

describe("reference file addresses", () => {
  it("uses the first original definition for reference links without changing their labels", () => {
    const tree = {
      type: "root",
      children: [
        { type: "linkReference", identifier: "file", children: [{ type: "inlineCode", value: "src/a.ts:7" }] },
        { type: "definition", identifier: "file", url: "file:///work/src/a.ts#L7" },
        { type: "definition", identifier: "file", url: "./other.ts#L9" },
      ],
    };
    remarkReplyFiles()(tree);
    expect(tree.children[0]).toStrictEqual({
      type: "linkReference",
      identifier: "file",
      children: [{ type: "inlineCode", value: "src/a.ts:7" }],
      data: { hName: "atrium-file", hProperties: { source: "file:///work/src/a.ts#L7", inline: "false" } },
    });
  });
});

describe("combined reply reference transforms", () => {
  it("keeps reference images as images and resets definitions between processor uses", () => {
    const transform = remarkReplyFiles();
    const image = { type: "imageReference", identifier: "shared", alt: "图片" };
    const first = {
      type: "root",
      children: [
        image,
        { type: "linkReference", identifier: "shared", children: [{ type: "text", value: "链接" }] },
        { type: "definition", identifier: "shared", url: "./first.png" },
      ],
    };
    remarkReplyImages()(first);
    transform(first);
    expect(image).toStrictEqual({
      type: "imageReference",
      identifier: "shared",
      alt: "图片",
      data: { hName: "atrium-image", hProperties: { source: "./first.png", alt: "图片" } },
    });
    const second = {
      type: "root",
      children: [
        { type: "linkReference", identifier: "shared", children: [{ type: "text", value: "另一个链接" }] },
        { type: "definition", identifier: "shared", url: "./second.ts#L1" },
      ],
    };
    transform(second);
    expect(second.children[0]).toStrictEqual({
      type: "linkReference",
      identifier: "shared",
      children: [{ type: "text", value: "另一个链接" }],
      data: { hName: "atrium-file", hProperties: { source: "./second.ts#L1", inline: "false" } },
    });
  });

  it("keeps http, https, mail and heading links out of the workspace renderer", () => {
    const tree = {
      type: "root",
      children: ["http://example.com", "https://example.com", "mailto:a@example.com", "#section"].map((url) => ({
        type: "link",
        url,
        children: [{ type: "text", value: "label" }],
      })),
    };
    const original = structuredClone(tree);
    remarkReplyFiles()(tree);
    expect(tree).toStrictEqual(original);
  });
});

describe("data fence completion", () => {
  it.each([
    ["```csv\na,b\n1,2\n```", "a,b\n1,2", "atrium-data-closed"],
    ["```csv\na,b\n1,2", "a,b\n1,2", "atrium-data-open"],
    ["```csv\na,b\n1,2\n", "a,b\n1,2", "atrium-data-open"],
    ["```csv\na,b\n> ```", "a,b\n> ```", "atrium-data-open"],
    ["````csv\n```\n````", "```", "atrium-data-closed"],
    ["````csv\na,b\n```", "a,b\n```", "atrium-data-open"],
    ["~~~csv\na,b\n~~~", "a,b", "atrium-data-closed"],
    ["```csv\n```", "", "atrium-data-closed"],
    ["```csv\rh\r1```", "h\r1```", "atrium-data-open"],
    ["```csv\rh\r1\r```", "h\r1", "atrium-data-closed"],
    ["```csv\na,b\n1,2\n``` \t", "a,b\n1,2", "atrium-data-closed"],
  ])("marks the actual source extent %s", (source, value, expected) => {
    const node = {
      type: "code",
      lang: "csv",
      value,
      position: { start: { offset: 0 }, end: { offset: source.length } },
    };
    remarkReplyData()({ type: "root", children: [node] }, { value: source });
    expect(node).toStrictEqual({
      type: "code",
      lang: "csv",
      value,
      position: { start: { offset: 0 }, end: { offset: source.length } },
      data: { hProperties: { metastring: expected } },
    });
  });
});

describe("data fence source provenance", () => {
  it("uses the JSON node's exact span inside a larger document without touching other code or text", () => {
    const source = 'before\n```json\n{"x":1}\n```\nafter';
    const json = {
      type: "code",
      lang: "json",
      value: '{"x":1}',
      position: { start: { offset: 7 }, end: { offset: 26 } },
    };
    const other = {
      type: "code",
      lang: "js",
      value: "const x = 1",
      data: { hProperties: { metastring: "title=example" } },
    };
    const tree = { type: "root", children: [json, other, { type: "text", value: "after" }] };
    const original = structuredClone(other);
    remarkReplyData()(tree, { value: source });
    expect(json).toStrictEqual({
      type: "code",
      lang: "json",
      value: '{"x":1}',
      position: { start: { offset: 7 }, end: { offset: 26 } },
      data: { hProperties: { metastring: "atrium-data-closed" } },
    });
    expect(other).toStrictEqual(original);
    expect(tree.children[2]).toStrictEqual({ type: "text", value: "after" });
  });

  it.each([undefined, {}, { value: new Uint8Array() }])(
    "fails closed when the original Markdown is unavailable: %j",
    (file) => {
      const node = { type: "code", lang: "csv", value: "a,b", position: { start: { offset: 0 }, end: { offset: 16 } } };
      remarkReplyData()({ type: "root", children: [node] }, file);
      expect(node).toStrictEqual({
        type: "code",
        lang: "csv",
        value: "a,b",
        position: { start: { offset: 0 }, end: { offset: 16 } },
        data: { hProperties: { metastring: "atrium-data-open" } },
      });
    },
  );

  it("fails closed for a code node without a position", () => {
    const node = { type: "code", lang: "csv", value: "a,b" };
    remarkReplyData()({ type: "root", children: [node] }, { value: "```csv\na,b\n```" });
    expect(node).toStrictEqual({
      type: "code",
      lang: "csv",
      value: "a,b",
      data: { hProperties: { metastring: "atrium-data-open" } },
    });
  });

  it.each([
    { start: {}, end: { offset: 16 } },
    { start: { offset: 0 }, end: {} },
  ])("fails closed when code offsets are missing: %j", (position) => {
    const node = { type: "code", lang: "csv", value: "a,b", position };
    remarkReplyData()({ type: "root", children: [node] }, { value: "```csv\na,b\n```" });
    expect(node).toStrictEqual({
      type: "code",
      lang: "csv",
      value: "a,b",
      position,
      data: { hProperties: { metastring: "atrium-data-open" } },
    });
  });
});

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

describe("remarkReplyImages", () => {
  it("keeps the original URL and strings as inert image properties", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "image", url: "file:///work/图.png", alt: "图", title: "说明" },
            { type: "image", url: "./a.png" },
          ],
        },
      ],
    };
    remarkReplyImages()(tree);
    expect(tree).toStrictEqual({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "image",
              url: "file:///work/图.png",
              alt: "图",
              title: "说明",
              data: { hName: "atrium-image", hProperties: { source: "file:///work/图.png", alt: "图", title: "说明" } },
            },
            {
              type: "image",
              url: "./a.png",
              data: { hName: "atrium-image", hProperties: { source: "./a.png", alt: "" } },
            },
          ],
        },
      ],
    });
  });

  it("uses the first complete reference definition and leaves unresolved references and text alone", () => {
    const tree = {
      type: "root",
      children: [
        { type: "imageReference", identifier: "picture", alt: "引用" },
        { type: "definition", identifier: "picture", url: "./first.png" },
        { type: "definition", identifier: "picture", url: "./second.png" },
        { type: "definition", identifier: "missing" },
        { type: "imageReference", identifier: "missing" },
        { type: "text", value: "plain" },
      ],
    };
    remarkReplyImages()(tree);
    expect(tree).toStrictEqual({
      type: "root",
      children: [
        {
          type: "imageReference",
          identifier: "picture",
          alt: "引用",
          data: { hName: "atrium-image", hProperties: { source: "./first.png", alt: "引用" } },
        },
        { type: "definition", identifier: "picture", url: "./first.png" },
        { type: "definition", identifier: "picture", url: "./second.png" },
        { type: "definition", identifier: "missing" },
        { type: "imageReference", identifier: "missing" },
        { type: "text", value: "plain" },
      ],
    });
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

describe("withoutUnfinishedTable", () => {
  it.each([
    ["the header being written", "表格\n\n| 模块 | 职", "表格\n"],
    ["the header written", "表格\n\n| 模块 | 职责 | 行数 |", "表格\n"],
    ["the header and its line's end", "表格\n\n| 模块 | 职责 | 行数 |\n", "表格\n"],
    ["the header and half the delimiter row", "表格\n\n| 模块 | 职责 | 行数 |\n| -------- | -----", "表格\n"],
    ["a delimiter cell only begun", "| a | b |\n| --- | :", ""],
    ["a header without its closing pipe", "| a | b\n| --- |", ""],
    ["cells written without spaces", "| a | b | c |\n|---|-", ""],
    ["a delimiter row without its opening pipe", "| a | b | c |\n--- | -", ""],
    ["an indented delimiter row", "| a | b | c |\n   | --- | -", ""],
    ["a cell ending in other than dashes", "| a | b | c |\n| --x | -", "| a | b | c |"],
    ["a cell starting with other than dashes", "| a | b | c |\n| x-- | -", "| a | b | c |"],
    ["a second line starting with a pipe, after a pipe line that is only a paragraph", "| a |\n| b", "| a |"],
    ["a header after a paragraph line", "foo\n| a | b |", "foo"],
    [
      "a header after a heading that ended a table",
      "| a | b |\n| - | - |\n# h\n| x | y |",
      "| a | b |\n| - | - |\n# h",
    ],
    ["a header after code closed by a fence with spaces after it", "```\n```  \n| a | b |", "```\n```  "],
    ["a header after a blank line that ended a table", "| a |\n| - |\n\n| x |", "| a |\n| - |\n"],
    ["a header after a line of spaces that ended a table", "| a |\n| - |\n   \n| x |", "| a |\n| - |\n   "],
    [
      "a header after a level-two heading that ended a table",
      "| a | b |\n| - | - |\n## h\n| x |",
      "| a | b |\n| - | - |\n## h",
    ],
    ["a header after an empty heading that ended a table", "| a |\n| - |\n#\n| x |", "| a |\n| - |\n#"],
    ["a header after a delimiter row with a cell not dashes", "| a | b |\n| - | x |\n| y |", "| a | b |\n| - | x |"],
    ["a header after a line with a fence inside it, no fence", "a ```\n| a |", "a ```"],
    ["a header after a lone tilde, no fence", "~\n| a |", "~"],
    ["a header after code holding what looks like a table", "```\n| a |\n| - |\n```\n| x |", "```\n| a |\n| - |\n```"],
    ["a header after a delimiter row of the wrong width", "| a | b |\n| - |\n| x |", "| a | b |\n| - |"],
    ["a header after a line no fence, its info string holding a backtick", "```a`b\n| a |", "```a`b"],
  ])("holds back a table not yet a table: %s", (_case, text, shown) => {
    expect(withoutUnfinishedTable(text)).toBe(shown);
  });

  it.each([
    ["the delimiter row written", "| a | b |\n| --- | --- |"],
    ["the delimiter row as long as a header with an escaped pipe", "| a \\| b | c |\n| --- | --- |"],
    ["the delimiter row with all its columns, its end still coming", "| a | b |\n| :-- | -"],
    ["a body row being written", "| a | b |\n| - | - |\n| 1 | 2"],
    ["a table and a blank line after it", "| a |\n| - |\n| 1 |\n"],
    ["a row after a line that is not a delimiter", "| a |\nhello"],
    ["a pipe inside a line", "a | b"],
    ["an indented header and its delimiter row", "  | a |\n| --- |"],
    ["a lone pipe and its line's end", "|\n"],
    ["a header line inside code", "```\n| a | b |"],
    ["a header line in code a shorter fence does not close", "````\n```\n| a | b |"],
    ["a header line in code another kind of fence does not close", "~~~\n```\n| a | b |"],
    ["a header line in code a fence with more after it does not close", "```\n```not-a-close\n| a | b |"],
    ["a header line in code under a fence with an info string", "```ts\n| a | b |"],
    ["a header line in code under a tilde fence", "~~~\n| a |"],
    ["a body row after one holding a fence's backticks", "| a | b |\n| - | - |\nx ```\n| y |"],
    ["a body row after one starting with inline code", "| a |\n| - |\n`x`\n| y |"],
    ["a body row after one starting with a tilde", "| a |\n| - |\n~x\n| y |"],
    ["a header line in code a fence indented four spaces does not close", "```\n    ```\n| a |"],
    ["a body row after a delimiter row without its opening pipe", "| a | b |\n--- | ---\n| 1 | 2 |"],
    ["a body row of a table whose header has no opening pipe", "a | b\n--- | ---\n| 1 | 2 |"],
    ["a body row after one without pipes", "| a | b |\n| - | - |\n1 | 2\n| 3 | 4 |"],
    ["a body row after plain text the table took in", "| a | b |\n| - | - |\nplain\n| 3 | 4 |"],
    ["a pipe line a quote after a table takes in", "| a | b |\n| - | - |\n> q\n| x | y |"],
    ["nothing", ""],
  ])("shows the rest as it is: %s", (_case, text) => {
    expect(withoutUnfinishedTable(text)).toBe(text);
  });

  it("holds back a table after code that has closed", () => {
    expect(withoutUnfinishedTable("```\nx\n```\n| a |")).toBe("```\nx\n```");
  });
});
