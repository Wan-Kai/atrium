import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { CommandError } from "@atrium/client";
import { fakeClient } from "../test/fake-client";
import { Markdown } from "./markdown";
import { ReplyImagesContext, replyImageFiles } from "./reply-images";
import { OpenFileContext } from "./file-opener";
import "../styles.css";

const DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const W = "wks_0000000000000001";

describe("reply images", () => {
  it.each([
    { destination: "https://example.com/docs", role: "link", href: "https://example.com/docs", openedAfter: [] },
    { destination: "./src/a.ts#L2", role: "button", href: null, openedAfter: ["./src/a.ts"] },
  ] as const)(
    "isolates a linked image's preview from $destination without losing its destination",
    async ({ destination, role, href, openedAfter }) => {
      const opened: string[] = [];
      const canvas = document.createElement("canvas");
      canvas.width = 80;
      canvas.height = 40;
      const source = canvas.toDataURL("image/png");
      const screen = await render(
        <OpenFileContext
          value={(path) => () => {
            opened.push(path);
          }}
        >
          <Markdown text={`[![徽章](${source})](${destination})`} streaming={false} />
        </OpenFileContext>,
      );
      expect(screen.container.querySelector("a button, button button")).toBeNull();
      await screen.getByRole("button", { name: "放大图片：徽章" }).click();
      const dialog = screen.getByRole("dialog", { name: "图片预览" });
      await expect.element(screen.getByText("80 × 40")).toBeVisible();
      expect(dialog.element().closest("a, button")).toBeNull();
      await screen.getByRole("region", { name: "图片画布" }).click();
      expect(opened).toStrictEqual([]);
      await userEvent.keyboard("{Escape}");
      await expect.element(screen.getByRole("button", { name: "放大图片：徽章" })).toHaveFocus();
      const control = screen.getByRole(role, { name: "徽章", exact: true });
      expect(control.element().getAttribute("href")).toBe(href);
      control.element().addEventListener("click", (event) => event.preventDefault());
      await control.click();
      expect(opened).toStrictEqual(openedAfter);
    },
  );

  it.each(["./images/a.png", "/work/images/a.png", "file:///work/images/a.png"])(
    "reads %s through the workspace reader, never the static server",
    async (source) => {
      const { client, calls } = fakeClient(
        {},
        { readFile: async () => ({ size: 68, content: { kind: "image", mimeType: "image/png", data: DATA } }) },
      );
      const screen = await render(
        <ReplyImagesContext value={replyImageFiles(client, W, "/work")}>
          <Markdown text={`![图](${source})`} streaming={false} />
        </ReplyImagesContext>,
      );
      await vi.waitFor(() => expect(screen.container.querySelector<HTMLImageElement>("img")?.naturalWidth).toBe(1));
      expect(calls).toStrictEqual([`readFile ${W} images/a.png`]);
      expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${DATA}`);
      await userEvent.click(screen.getByRole("button", { name: "放大图片：图" }));
      expect(document.querySelector('dialog[open][aria-label="图片预览"]')).not.toBeNull();
      await userEvent.keyboard("{Escape}");
      expect(document.querySelector("dialog[open]")).toBeNull();
    },
  );

  it("preserves a reference image's original relative path", async () => {
    const { client, calls } = fakeClient(
      {},
      { readFile: async () => ({ size: 68, content: { kind: "image", mimeType: "image/png", data: DATA } }) },
    );
    const screen = await render(
      <ReplyImagesContext value={replyImageFiles(client, W, "/work")}>
        <Markdown text={"![图][picture]\n\n[picture]: ./images/a.png"} streaming={false} />
      </ReplyImagesContext>,
    );
    await vi.waitFor(() => expect(screen.container.querySelector<HTMLImageElement>("img")?.naturalWidth).toBe(1));
    expect(calls).toStrictEqual([`readFile ${W} images/a.png`]);
  });

  it("never turns raw custom HTML into a workspace read", async () => {
    const { client, calls } = fakeClient();
    const screen = await render(
      <ReplyImagesContext value={replyImageFiles(client, W, "/work")}>
        <Markdown text={'<atrium-image source="secret.png" alt="图"></atrium-image>'} streaming={false} />
      </ReplyImagesContext>,
    );
    expect(screen.container.textContent).toContain('<atrium-image source="secret.png"');
    expect(screen.container.querySelector("img")).toBeNull();
    expect(calls).toStrictEqual([]);
  });

  it("never loads a relative image as an app asset without a workspace", async () => {
    const screen = await render(<Markdown text="![图](./secret.png)" streaming={false} />);
    expect(screen.container.querySelector("img")).toBeNull();
    expect(screen.container.textContent).toContain("不能显示这张图片");
  });

  it("keeps a retry after a failed read and refuses non-image content", async () => {
    const attempts = [
      () => Promise.reject(new CommandError("path_not_found")),
      () => Promise.resolve({ size: 7, content: { kind: "text" as const, text: "secret!" } }),
    ];
    const { client, calls } = fakeClient(
      {},
      {
        readFile: () => attempts.shift()!(),
      },
    );
    const screen = await render(
      <ReplyImagesContext value={replyImageFiles(client, W, "/work")}>
        <Markdown text="![图](a.svg)" streaming={false} />
      </ReplyImagesContext>,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("图片不在了重试");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await expect.element(screen.getByRole("status")).toHaveTextContent("不是可显示的图片重试");
    expect(screen.container.querySelector("img")).toBeNull();
    expect(screen.container.textContent).not.toContain("secret!");
    expect(calls).toStrictEqual([`readFile ${W} a.svg`, `readFile ${W} a.svg`]);
  });
});
