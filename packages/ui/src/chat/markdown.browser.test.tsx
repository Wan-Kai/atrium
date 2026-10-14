import { describe, expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { Markdown } from "./markdown";

/** Renders finished Markdown and returns its root element. */
async function rendered(text: string): Promise<HTMLElement> {
  const screen = await render(<Markdown text={text} streaming={false} />);
  return screen.container;
}

/**
 * How far apart the first two paragraphs are, in pixels.
 *
 * @sideEffects none
 * @param root - What the Markdown is rendered in.
 * @returns The space between the first's bottom and the second's top.
 * @throws {Error} When there are not two paragraphs.
 */
function paragraphGap(root: HTMLElement): number {
  const [first, second] = root.querySelectorAll("p");
  if (first === undefined || second === undefined) throw new Error("not two paragraphs");
  return second.getBoundingClientRect().top - first.getBoundingClientRect().bottom;
}

/**
 * The one element of a Streamdown part in what was rendered.
 *
 * @sideEffects none
 * @param root - What the Markdown is rendered in.
 * @param name - The part's `data-streamdown` name.
 * @returns The element.
 * @throws {Error} When there is no such part.
 */
function part(root: ParentNode, name: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(`[data-streamdown="${name}"]`);
  if (found === null) throw new Error(`no ${name}`);
  return found;
}

/**
 * The names of the buttons in an element, in order.
 *
 * @sideEffects none
 * @param element - The element.
 * @returns Each button's name: its label, or else its title.
 */
function buttonNames(element: Element): (string | null)[] {
  return [...element.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? button.getAttribute("title"),
  );
}

/**
 * The element holding a block's buttons.
 *
 * @sideEffects none
 * @param block - The block.
 * @returns The element the buttons fade in with.
 * @throws {Error} When the block has no buttons.
 */
function buttonsOf(block: Element): HTMLElement {
  const button = block.querySelector("button");
  const group = button?.parentElement;
  if (group === null || group === undefined) throw new Error("no buttons");
  return group;
}

/**
 * The computed style of an element.
 *
 * @sideEffects none
 * @param element - The element, which the test knows is there.
 * @returns Its style.
 */
function styleOf(element: Element | undefined): CSSStyleDeclaration {
  return getComputedStyle(element as Element);
}

/**
 * Puts the page in dark mode until the test finishes.
 *
 * @sideEffects Adds `.dark` to `<html>`, removed as the test finishes.
 */
function darkUntilDone(): void {
  document.documentElement.classList.add("dark");
  onTestFinished(() => document.documentElement.classList.remove("dark"));
}

/**
 * Waits for a rendered Mermaid diagram.
 *
 * @sideEffects none
 * @param root - What the Markdown is rendered in.
 * @returns The diagram's first node shape.
 */
async function mermaidNode(root: HTMLElement): Promise<SVGElement> {
  return vi.waitFor(
    () => {
      const shape = root.querySelector<SVGElement>("svg[id^='mermaid'] .node rect, svg[id^='mermaid'] .node path");
      if (shape === null) throw new Error("no diagram yet");
      return shape;
    },
    { timeout: 15_000 },
  );
}

describe("Markdown", () => {
  it("renders GFM: tables, nested and task lists, strikethrough", async () => {
    const root = await rendered(
      ["| 名称 | 值 |", "|---|---|", "| a | 1 |", "", "- 一", "  - 二", "- [x] 完成", "", "~~删掉~~"].join("\n"),
    );

    expect([...root.querySelectorAll("th")].map((cell) => cell.textContent)).toStrictEqual(["名称", "值"]);
    expect(root.querySelector("li li")?.textContent).toBe("二");
    expect(root.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    expect(root.querySelector("del")?.textContent).toBe("删掉");
  });

  it("hangs a small dot close before a bullet's text, wraps under the text, leaves numbers be, and gives a task its checkbox alone", async () => {
    const screen = await render(
      <div style={{ width: 240 }}>
        <Markdown
          text={"- 很长的一项，很长的一项，很长的一项，很长的一项，很长的一项\n\n1. 第一\n\n- [ ] 待办"}
          streaming={false}
        />
      </div>,
    );
    const items = screen.getByRole("listitem");
    const bullet = items.nth(0).element();
    const numbered = items.nth(1).element();
    const task = items.nth(2).element();
    const words = document.createRange();
    words.selectNodeContents(bullet);
    const left = bullet.getBoundingClientRect().left;
    const dot = getComputedStyle(bullet, "::before");

    expect({
      lines: [...new Set([...words.getClientRects()].map((line) => line.left - left))],
      wrapped: words.getClientRects().length > 1,
      marker: getComputedStyle(bullet).listStyleType,
      dot: [dot.content, dot.left, dot.width, dot.height, dot.borderRadius],
      numbered: [getComputedStyle(numbered).listStyleType, getComputedStyle(numbered, "::before").content],
      task: [getComputedStyle(task).listStyleType, getComputedStyle(task, "::before").content],
    }).toStrictEqual({
      lines: [18.125],
      wrapped: true,
      marker: "none",
      dot: ['""', "6.525px", "5px", "5px", "50%"],
      numbered: ["decimal", "none"],
      task: ["none", "none"],
    });
  });

  it("sets a reply close: 1.55 lines, 12px between blocks, 2px around list items, the dot on the first line's middle", async () => {
    const screen = await render(<Markdown text={"一段话\n\n另一段话\n\n- 一项\n- 两项"} streaming={false} />);
    const item = screen.getByRole("listitem").first().element();
    const dot = getComputedStyle(item, "::before");
    const line = parseFloat(getComputedStyle(item).paddingTop) + parseFloat(getComputedStyle(item).lineHeight) / 2;

    expect({
      lineHeight: getComputedStyle(item).lineHeight,
      gap: paragraphGap(screen.container),
      item: [getComputedStyle(item).paddingTop, getComputedStyle(item).paddingBottom],
      dotOffLine: Math.abs(parseFloat(dot.top) - line),
    }).toStrictEqual({ lineHeight: "22.475px", gap: 12, item: ["2px", "2px"], dotOffLine: 0 });
  });

  it("makes bold work right next to Chinese punctuation", async () => {
    const root = await rendered("**注意：**后面的文字");

    expect(root.querySelector('[data-streamdown="strong"]')?.textContent).toBe("注意：");
  });

  it("shows raw HTML as text and never creates its elements", async () => {
    const root = await rendered(
      '前 <b>粗</b> 后\n\n<script>window.injected = true</script>\n\n<img src="https://example.com/x.png">',
    );

    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<b>粗</b>");
    expect(root.textContent).toContain("<script>window.injected = true</script>");
    expect((window as unknown as { injected?: boolean }).injected).toBeUndefined();
  });

  it("renders $$ block math and \\( \\) inline math, but not single dollars", async () => {
    const root = await rendered(String.raw`面积 \(\pi r^2\)，价格 $5 和 $6。` + "\n\n$$\nE = mc^2\n$$");

    await vi.waitFor(() => expect(root.querySelectorAll(".katex")).toHaveLength(2), { timeout: 10_000 });
    expect(root.querySelector(".katex-display")).not.toBeNull();
    expect(root.textContent).toContain("价格 $5 和 $6。");
  });

  it("opens links in a new window, which the desktop shell sends to the system browser", async () => {
    const root = await rendered("[文档](https://example.com/docs)");
    const link = root.querySelector("a");

    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("lets a click go straight to the link, without a confirmation dialog of its own", async () => {
    const root = await rendered("[文档](https://example.com/docs)");
    const followed: string[] = [];
    // Stands in for the desktop shell: records the click and keeps the test page where it is.
    const intercept = (event: MouseEvent): void => {
      followed.push(String((event.target as Element).closest("a")?.href));
      event.preventDefault();
    };
    document.addEventListener("click", intercept, { capture: true });

    root.querySelector("a")?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.removeEventListener("click", intercept, { capture: true });

    expect(followed).toStrictEqual(["https://example.com/docs"]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows https images directly and turns an http image into a link", async () => {
    const root = await rendered(
      "![图](https://example.com/a.png)\n\n![旧图](http://example.com/b.png)\n\n![](http://example.com/c.png)",
    );

    expect([...root.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toStrictEqual([
      "https://example.com/a.png",
    ]);
    expect([...root.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")])).toStrictEqual([
      ["旧图", "http://example.com/b.png"],
      ["http://example.com/c.png", "http://example.com/c.png"],
    ]);
  });

  it("highlights code blocks and colors diff lines", async () => {
    const root = await rendered("```ts\nconst a = 1;\n```\n\n```diff\n- old\n+ new\n```");

    await vi.waitFor(() => expect(root.querySelectorAll("pre span[style]").length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    expect(root.textContent).toContain("const a = 1;");
    expect(root.textContent).toContain("+ new");
  });

  it("draws a Mermaid diagram once the diagram plugin has loaded", async () => {
    const root = await rendered("```mermaid\ngraph TD\n  A --> B\n```");

    await vi.waitFor(() => expect(root.querySelector("svg[id^='mermaid']")).not.toBeNull(), { timeout: 15_000 });
  });
  it("lays a code block flat on the code colour, no lines, numbers or download, its language in the corner", async () => {
    const root = await rendered("```ts\nconst a = 1;\n```");
    await vi.waitFor(() => expect(root.querySelectorAll("pre span[style]").length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    const block = part(root, "code-block");
    const body = part(root, "code-block-body");
    const label = part(root, "code-block-header");
    const pre = body.querySelector("pre") as HTMLElement;
    const line = body.querySelector("code > span") as HTMLElement;

    expect({
      block: [
        styleOf(block).backgroundColor,
        styleOf(block).borderTopWidth,
        styleOf(block).borderRadius,
        styleOf(block).padding,
      ],
      body: [styleOf(body).backgroundColor, styleOf(body).borderTopWidth, styleOf(body).padding],
      pre: styleOf(pre).backgroundColor,
      code: [styleOf(pre).fontSize, styleOf(pre).lineHeight],
      number: getComputedStyle(line, "::before").content,
      label: [label.textContent, styleOf(label).fontSize, styleOf(label).color, styleOf(label).backgroundColor],
      buttons: buttonNames(block),
      icon: block.querySelector("button path")?.getAttribute("d")?.slice(0, 9),
    }).toStrictEqual({
      block: ["rgb(246, 246, 248)", "0px", "10px", "0px"],
      body: ["rgba(0, 0, 0, 0)", "0px", "12px 14px"],
      pre: "rgba(0, 0, 0, 0)",
      code: ["12.5px", "20px"],
      number: "none",
      label: ["ts", "11px", "rgb(161, 161, 167)", "rgb(246, 246, 248)"],
      buttons: ["复制"],
      icon: "M7.5 14.5",
    });
  });

  it("shows a block's buttons in place of its language while hovered or focused inside", async () => {
    const root = await rendered("```ts\nconst a = 1;\n```");
    const block = part(root, "code-block");
    const label = part(root, "code-block-header");
    const buttons = buttonsOf(block);
    const shown = () => [getComputedStyle(label).opacity, getComputedStyle(buttons).opacity];
    const resting = shown();

    await userEvent.hover(block);
    await expect.poll(shown).toStrictEqual(["0", "1"]);
    await userEvent.unhover(block);
    await expect.poll(shown).toStrictEqual(["1", "0"]);
    block.querySelector("button")?.focus();

    await expect.poll(shown).toStrictEqual(["0", "1"]);
    expect(resting).toStrictEqual(["1", "0"]);
  });

  it("grounds a code block on the dark code colour in dark mode", async () => {
    darkUntilDone();
    const root = await rendered("```ts\nconst a = 1;\n```");
    await vi.waitFor(() => expect(root.querySelectorAll("pre span[style]").length).toBeGreaterThan(0), {
      timeout: 10_000,
    });

    expect([
      getComputedStyle(part(root, "code-block")).backgroundColor,
      getComputedStyle(part(root, "code-block-body").querySelector("pre") as Element).backgroundColor,
    ]).toStrictEqual(["rgb(25, 25, 27)", "rgba(0, 0, 0, 0)"]);
  });

  it("sets a table without a frame: a muted header over a strong line, soft lines between rows, none under the last", async () => {
    const root = await rendered("| 名称 | 值 |\n|---|---|\n| a | 1 |\n| b | 2 |");
    const wrapper = part(root, "table-wrapper");
    const [head] = root.querySelectorAll("th");
    const cells = root.querySelectorAll("td");
    const buttons = wrapper.firstElementChild as HTMLElement;
    const hidden = styleOf(buttons).opacity;

    await userEvent.hover(wrapper);

    await expect.poll(() => styleOf(buttons).opacity).toBe("1");
    expect({
      wrapper: [styleOf(wrapper).borderTopWidth, styleOf(wrapper).backgroundColor, styleOf(wrapper).padding],
      width: part(root, "table").getBoundingClientRect().width === wrapper.getBoundingClientRect().width,
      head: [styleOf(head).color, styleOf(head).fontSize, styleOf(head).fontWeight, styleOf(head).borderBottom],
      cell: [styleOf(cells[0]).borderBottom, styleOf(cells[0]).padding, styleOf(cells[3]).borderBottomWidth],
      buttons: [hidden, buttonNames(buttons)],
    }).toStrictEqual({
      wrapper: ["0px", "rgba(0, 0, 0, 0)", "0px"],
      width: true,
      head: ["rgb(110, 110, 116)", "13px", "600", "1px solid rgba(0, 0, 0, 0.14)"],
      cell: ["1px solid rgba(0, 0, 0, 0.05)", "8px 20px 8px 0px", "0px"],
      buttons: ["0", ["复制表格", "放大"]],
    });
  });

  it("keeps 12px under a code block, a table and a diagram, as under any block", async () => {
    const root = await rendered(
      "```ts\nconst a = 1;\n```\n\n后\n\n| a |\n|---|\n| 1 |\n\n后\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n后",
    );
    await mermaidNode(root);
    // The reply's own paragraphs; Mermaid writes its labels in paragraphs too.
    const after = [...(root.firstElementChild as Element).children].filter((child) => child.tagName === "P");
    const blocks = [part(root, "code-block"), part(root, "table-wrapper"), part(root, "mermaid-block")];

    expect(
      blocks.map(
        (block, index) => (after[index] as Element).getBoundingClientRect().top - block.getBoundingClientRect().bottom,
      ),
    ).toStrictEqual([12, 12, 12]);
  });

  it("draws a table seen larger in the design's lines, not black ones", async () => {
    const root = await rendered("| 名称 | 值 |\n|---|---|\n| a | 1 |");
    await userEvent.click(root.querySelector('button[title="放大"]') as Element);
    const larger = part(document, "table-fullscreen");

    expect(getComputedStyle(part(larger, "table")).borderTopColor).toBe("rgba(0, 0, 0, 0.08)");
  });

  it("gives inline code the soft surface and the small corners", async () => {
    const root = await rendered("运行 `pnpm check`");
    const code = part(root, "inline-code");

    expect([getComputedStyle(code).backgroundColor, getComputedStyle(code).borderRadius]).toStrictEqual([
      "rgb(242, 242, 244)",
      "6px",
    ]);
  });

  it("draws Mermaid flat in neutral colours, and switches to its source and back", async () => {
    const root = await rendered("```mermaid\ngraph TD\n  A --> B\n```");
    const node = await mermaidNode(root);
    const block = part(root, "mermaid-block");
    const drawn = [
      getComputedStyle(node).fill,
      getComputedStyle(block).backgroundColor,
      getComputedStyle(block).borderTopWidth,
      buttonNames(root),
    ];

    await userEvent.click(root.querySelector('button[aria-label="看源码"]') as Element);
    const source = [root.querySelector("svg[id^='mermaid']"), part(root, "code-block").textContent];
    await userEvent.click(root.querySelector('button[aria-label="看图"]') as Element);

    await mermaidNode(root);
    expect(drawn).toStrictEqual(["rgb(255, 255, 255)", "rgb(246, 246, 248)", "0px", ["看源码", "复制", "放大"]]);
    expect(source).toStrictEqual([null, expect.stringContaining("A --> B")]);
  });

  it("draws Mermaid in dark colours in dark mode", async () => {
    darkUntilDone();
    const root = await rendered("```mermaid\ngraph TD\n  A --> B\n```");

    expect(getComputedStyle(await mermaidNode(root)).fill).toBe("rgb(21, 21, 23)");
  });

  it("shows a Mermaid block still being written as its source, with nothing to switch, though the plugin has loaded", async () => {
    await mermaidNode(await rendered("```mermaid\ngraph TD\n  C --> D\n```"));
    const screen = await render(<Markdown text={"```mermaid\ngraph TD\n  A --> B"} streaming />);
    await vi.waitFor(() => expect(part(screen.container, "code-block").textContent).toContain("A --> B"));

    expect([
      screen.container.querySelector("[data-streamdown='mermaid-block']"),
      screen.container.querySelector('button[aria-label="看图"], button[aria-label="看源码"]'),
    ]).toStrictEqual([null, null]);
  });
});
