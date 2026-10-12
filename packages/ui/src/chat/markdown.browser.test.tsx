import { describe, expect, it, vi } from "vitest";
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
});
