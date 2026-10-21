import { describe, expect, it } from "vitest";
import {
  normalizeMathDelimiters,
  remarkHtmlAsText,
  remarkReplyImages,
  remarkReplyFiles,
  remarkReplyData,
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
