import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import { Markdown } from "./markdown";

/** Renders finished Markdown and returns its root element. */
async function rendered(text: string): Promise<HTMLElement> {
  const screen = await render(<Markdown text={text} streaming={false} />);
  return screen.container;
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
