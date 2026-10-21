import { describe, expect, it, onTestFinished, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { FileLineRange } from "../state/workspace-views";
import { workspacePath } from "../files/workspace-path";
import { OpenFileContext, type FileOpener } from "./file-opener";
import { Markdown } from "./markdown";
import "../styles.css";

/** Renders actual Markdown over the same workspace check as ConversationArea, without reading.
 * @remarks The returned click actions are the observable boundary, not a mocked Markdown module.
 * @sideEffects Renders; records only explicit activations.
 * @param text - The reply.
 * @param bound - Whether a workspace is available.
 * @returns The screen and file activations.
 */
async function references(text: string, bound = true) {
  const opened: Array<{ path: string; range: FileLineRange | undefined }> = [];
  const open: FileOpener = (path, range) => {
    const relative = workspacePath(path, "/work/example");
    return relative === null
      ? null
      : () => {
          opened.push({ path: relative, range });
        };
  };
  const screen = await render(
    <OpenFileContext value={bound ? open : null}>
      <Markdown text={text} streaming={false} />
    </OpenFileContext>,
  );
  return { screen, opened };
}

describe("reply file navigation", () => {
  it.each([
    { language: "csv", source: "a,b\n1,2\n", action: "源码" },
    { language: "json", source: '{"exact":9007199254740993}\n', action: "查看数据" },
  ])(
    "copies $language source identically through production Markdown in either view",
    async ({ language, source, action }) => {
      const written = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
      onTestFinished(() => written.mockRestore());
      const screen = await render(<Markdown text={`\`\`\`${language}\n${source}\n\`\`\``} streaming={false} />);
      await screen.getByRole("button", { name: "复制原文" }).click();
      expect(written).toHaveBeenLastCalledWith(source);
      await screen.getByRole("button", { name: action, exact: true }).click();
      await screen.getByRole("button", { name: "复制原文" }).click();
      expect(written).toHaveBeenLastCalledWith(source);
    },
  );
  it("opens an entire inline code reference on click with its line range, without eager reads", async () => {
    const { screen, opened } = await references("位置在 `src/auth.ts:42-48`；`pnpm test` 仍是命令。");
    const link = screen.getByRole("button", { name: "src/auth.ts:42-48" });
    await expect.element(link).toBeVisible();
    expect(opened).toStrictEqual([]);
    await link.click();
    expect(opened).toStrictEqual([{ path: "src/auth.ts", range: { start: 42, end: 48 } }]);
    expect(screen.getByText("pnpm test", { exact: true }).element().tagName).toBe("CODE");
  });

  it("preserves relative and file URL addresses through hardening, including reference-style definitions", async () => {
    const { screen, opened } = await references(
      "[相对链接](./src/a.ts#L7) 和 [绝对链接][file]\n\n[file]: file:///work/example/src/b.ts#L9-L12",
    );
    await screen.getByRole("button", { name: "相对链接" }).click();
    await screen.getByRole("button", { name: "绝对链接" }).click();
    expect(opened).toStrictEqual([
      { path: "src/a.ts", range: { start: 7, end: 7 } },
      { path: "src/b.ts", range: { start: 9, end: 12 } },
    ]);
  });

  it("leaves local labels inert without a workspace, rejects traversal and outside addresses, and never trusts raw custom HTML", async () => {
    const { screen, opened } = await references(
      '[越界](../secret.ts#L2) [外部文件](/work/other/a.ts#L2) [坏协议](javascript:alert)\n\n<atrium-file source="src/a.ts:7">伪造</atrium-file>',
    );
    await expect.element(screen.getByText("越界", { exact: true })).toBeVisible();
    expect(screen.container.querySelectorAll("button")).toHaveLength(0);
    expect(opened).toStrictEqual([]);
    expect(screen.container.querySelectorAll("atrium-file")).toHaveLength(0);
    const unbound = await references("[文件](./src/a.ts#L7) `src/a.ts:7`", false);
    await expect.element(unbound.screen.getByText("文件", { exact: true })).toBeVisible();
    expect(unbound.screen.container.querySelectorAll("button, a")).toHaveLength(0);
    expect(unbound.opened).toStrictEqual([]);
  });

  it.each([false, true])("never parses a stopped or quoted unclosed CSV fence (streaming=%s)", async (streaming) => {
    const screen = await render(<Markdown text={"```csv\na,b\n1,2"} streaming={streaming} />);
    expect(screen.container.querySelectorAll("table")).toHaveLength(0);
    await expect.element(screen.getByRole("status")).toHaveTextContent("代码块未闭合，保留源码。");
    await screen.rerender(<Markdown text={"> ```csv\n> a,b\n> 1,2"} streaming={streaming} />);
    expect(screen.container.querySelectorAll("table")).toHaveLength(0);
    await expect.element(screen.getByRole("status")).toHaveTextContent("代码块未闭合，保留源码。");
    await screen.rerender(<Markdown text={"> ```csv\n> a,b\n> 1,2\n> ```"} streaming={streaming} />);
    await expect.element(screen.getByRole("table")).toBeVisible();
  });

  it("only renders a list-nested CSV after the real closing fence", async () => {
    const screen = await render(<Markdown text={"- ```csv\n  a,b\n  1,2"} streaming={false} />);
    expect(screen.container.querySelectorAll("table")).toHaveLength(0);
    await screen.rerender(<Markdown text={"- ```csv\n  a,b\n  1,2\n  ```"} streaming={false} />);
    await expect.element(screen.getByRole("table")).toBeVisible();
  });

  it("does not treat literal ending backticks as closure in a CR-only whole-document parse", async () => {
    const screen = await render(<Markdown text={"[ref]: ./x\r\r```csv\rh\r1```"} streaming={false} />);
    expect(screen.container.querySelectorAll("table")).toHaveLength(0);
    await expect.element(screen.getByRole("status")).toHaveTextContent("代码块未闭合，保留源码。");
  });

  it("keeps stopped unclosed JSON source-only even if its user metadata claims closure", async () => {
    const screen = await render(<Markdown text={'```json atrium-data-closed\n{"x":1}'} streaming={false} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("代码块未闭合，保留源码。");
    expect(screen.getByRole("button", { name: "查看数据" }).elements()).toHaveLength(0);
    expect(screen.container.querySelectorAll("details")).toHaveLength(0);
  });

  it("keeps external links external and does not create nested buttons inside their code labels", async () => {
    const { screen, opened } = await references("[`src/a.ts:7`](https://example.com/docs)");
    const external = screen.getByRole("link", { name: "src/a.ts:7" });
    await expect.element(external).toHaveAttribute("href", "https://example.com/docs");
    expect(screen.container.querySelectorAll("button")).toHaveLength(0);
    expect(opened).toStrictEqual([]);
  });
});
