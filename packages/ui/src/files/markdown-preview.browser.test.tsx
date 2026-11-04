import { CommandError } from "@atrium/client";
import type { CommandResult, DiffFile } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import { memoryStorage } from "../state/panes";
import { closeViewer, createWorkspaceViews, openFile, placeOf, viewOf } from "../state/workspace-views";
import { fakeClient, workspace } from "../test/fake-client";
import { FileViewer } from "./file-viewer";

const W = "wks_0000000000000001";

/** Renders a real file viewer backed by a controlled file protocol.
 * @remarks Only the host read is replaced; Markdown, layout and window-local state are real.
 * @sideEffects Renders the viewer and opens its tab in the views.
 * @param value - The file contents.
 * @param path - The file's workspace-relative path.
 * @param read - An optional controlled reading, for failures and reloads.
 * @returns The screen, client calls, views and remountable content.
 */
async function markdownViewer(
  value: string,
  path = "docs/README.md",
  read = async (): Promise<CommandResult<"read_file">> => ({
    size: new TextEncoder().encode(value).length,
    content: { kind: "text", text: value },
  }),
) {
  const { client, calls } = fakeClient(
    {},
    {
      readFile: read,
    },
  );
  const views = createWorkspaceViews(memoryStorage());
  openFile(views, W, path, true);
  const content = (
    <div style={{ display: "flex", width: 700, height: 350 }}>
      <FileViewer client={client} workspaceId={W} views={views} path={path} diff={null} onShowDiff={() => undefined} />
    </div>
  );
  const screen = await render(content);
  return { screen, calls, views, content, client };
}

describe("Markdown file preview", () => {
  it.each(["README.md", "README.MD", "docs/guide.markdown", "docs/guide.MARKDOWN"])(
    "previews an empty Markdown text file %s",
    async (path) => {
      const { screen } = await markdownViewer("", path);
      await screen.getByRole("button", { name: "预览", exact: true }).click();
      await expect.element(screen.getByTestId("markdown-preview")).toBeVisible();
      expect(screen.getByTestId("markdown-preview").element().textContent).toBe("");
    },
  );

  it.each(["a.ts", "README.md.txt", "markdown", "guide.mdx"])(
    "does not offer Markdown preview for %s",
    async (path) => {
      const { screen } = await markdownViewer("# Not Markdown", path);
      await expect.element(screen.getByTestId("code-lines")).toBeVisible();
      await expect.element(screen.getByRole("button", { name: "预览", exact: true })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["binary", "二进制文件，不显示内容"],
    ["too_large", "文件太大"],
    ["link", "这是符号链接，不显示内容"],
  ] as const)("does not offer preview when a Markdown path reads as %s", async (kind, label) => {
    const { screen } = await markdownViewer("", "README.md", async () => ({ size: 2_000_000, content: { kind } }));
    await expect.element(screen.getByText(label, { exact: false })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "预览", exact: true })).not.toBeInTheDocument();
  });

  it.each([
    ["path_not_found", "文件已经不在了"],
    ["read_failed", "读不了这个文件"],
  ] as const)("hides preview while loading and after %s", async (code, label) => {
    const pending = Promise.withResolvers<CommandResult<"read_file">>();
    const { screen } = await markdownViewer("", "README.md", () => pending.promise);
    await expect.element(screen.getByRole("button", { name: "换行", exact: true })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "预览", exact: true })).not.toBeInTheDocument();
    pending.reject(new CommandError(code));
    await expect.element(screen.getByText(label)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "预览", exact: true })).not.toBeInTheDocument();
  });

  it("refreshes rendered content and shows read failures instead of stale preview", async () => {
    let reading: CommandResult<"read_file"> = { size: 5, content: { kind: "text", text: "# Old" } };
    const { screen, client, views } = await markdownViewer("", "README.md", async () => reading);
    await screen.getByRole("button", { name: "预览", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: "Old" })).toBeVisible();
    const diff: DiffFile = {
      path: "README.md",
      oldPath: null,
      status: "modified",
      added: 1,
      removed: 1,
      content: "text",
      hunks: [],
    };
    reading = { size: 5, content: { kind: "text", text: "# New" } };
    await screen.rerender(
      <div style={{ display: "flex", width: 700, height: 350 }}>
        <FileViewer
          client={client}
          workspaceId={W}
          views={views}
          path="README.md"
          diff={diff}
          onShowDiff={() => undefined}
        />
      </div>,
    );
    await expect.element(screen.getByRole("heading", { name: "New" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Old" })).not.toBeInTheDocument();
    reading = { size: 0, content: { kind: "link" } };
    await screen.rerender(
      <div style={{ display: "flex", width: 700, height: 350 }}>
        <FileViewer
          client={client}
          workspaceId={W}
          views={views}
          path="README.md"
          diff={{ ...diff, added: 2 }}
          onShowDiff={() => undefined}
        />
      </div>,
    );
    await expect.element(screen.getByText("这是符号链接，不显示内容")).toBeVisible();
    await expect.element(screen.getByTestId("markdown-preview")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "查看源码" })).not.toBeInTheDocument();
  });

  it("reads local images relative to the document and opens file links only on click within the workspace", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA8J8BAAf/Af8Bf4mnAAAAAElFTkSuQmCC";
    const value =
      "# Guide\n\n![Local](images/a.png)\n\n![Absolute](/work/assets/b.png)\n\n[Related](guide.md#L3-L4)\n\n[Root](/work/root.md)\n\n[Outside](/outside/secret.md)\n\n[Traversal](../secret.md)\n\n![Blocked](../secret.png)";
    const readings: Record<string, CommandResult<"read_file">> = {
      "docs/README.md": { size: value.length, content: { kind: "text", text: value } },
      "docs/images/a.png": { size: 69, content: { kind: "image", mimeType: "image/png", data: png } },
      "assets/b.png": { size: 69, content: { kind: "image", mimeType: "image/png", data: png } },
    };
    const { client, calls } = fakeClient(
      { workspaces: [workspace({ id: W, dir: "/work" })] },
      { readFile: async (_workspace, path) => readings[path]! },
    );
    const views = createWorkspaceViews(memoryStorage());
    openFile(views, W, "docs/README.md", true);
    const screen = await render(
      <div style={{ display: "flex", height: 600, width: 700 }}>
        <FileViewer
          client={client}
          workspaceId={W}
          views={views}
          path="docs/README.md"
          diff={null}
          onShowDiff={() => undefined}
        />
      </div>,
    );
    await screen.getByRole("button", { name: "预览", exact: true }).click();
    await expect.element(screen.getByRole("img", { name: "Local", exact: true })).toBeVisible();
    await expect.element(screen.getByRole("img", { name: "Absolute", exact: true })).toBeVisible();
    expect(calls).toStrictEqual([
      `readFile ${W} docs/README.md`,
      `readFile ${W} docs/images/a.png`,
      `readFile ${W} assets/b.png`,
    ]);
    expect(viewOf(views.getState(), W).tabs).toHaveLength(1);
    await expect.element(screen.getByRole("button", { name: "Outside" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Traversal" })).not.toBeInTheDocument();
    expect(screen.container.querySelector('a[href="/outside/secret.md"]')).toBeNull();
    await screen.getByRole("button", { name: "Related", exact: true }).click();
    expect(viewOf(views.getState(), W).active).toBe("file:docs/guide.md");
    expect(viewOf(views.getState(), W).fileReveal).toStrictEqual({
      path: "docs/guide.md",
      range: { start: 3, end: 4 },
      count: 1,
      done: false,
    });
    await screen.getByRole("button", { name: "Root", exact: true }).click();
    expect(viewOf(views.getState(), W).active).toBe("file:root.md");
    expect(calls).toHaveLength(3);
  });

  it("keeps mode and independent scroll positions across tab switches, but forgets a closed tab", async () => {
    const { screen, views, content } = await markdownViewer(
      Array.from({ length: 80 }, (_, index) => `## Section ${index}\n\nParagraph ${index}.`).join("\n\n"),
    );
    await expect.element(screen.getByTestId("code-lines")).toBeVisible();
    const source = screen.getByTestId("viewer-body").element();
    source.scrollTop = 240;
    await screen.getByRole("button", { name: "换行", exact: true }).click();
    await screen.getByRole("button", { name: "预览", exact: true }).click();
    const preview = screen.getByTestId("markdown-preview").element();
    preview.scrollTop = 400;
    await screen.getByRole("button", { name: "查看源码" }).click();
    expect(source.scrollTop).toBe(240);
    await expect
      .element(screen.getByRole("button", { name: "换行", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("button", { name: "预览", exact: true }).click();
    expect(screen.getByTestId("markdown-preview").element().scrollTop).toBe(400);
    await screen.rerender(<div />);
    await screen.rerender(content);
    await expect.element(screen.getByRole("button", { name: "查看源码" })).toBeVisible();
    expect(screen.getByTestId("markdown-preview").element().scrollTop).toBe(400);
    await screen.getByRole("button", { name: "查看源码" }).click();
    expect(screen.getByTestId("viewer-body").element().scrollTop).toBe(240);
    await screen.rerender(<div />);
    closeViewer(views, W, "file:docs/README.md", []);
    openFile(views, W, "docs/README.md", true);
    await screen.rerender(content);
    await expect.element(screen.getByRole("button", { name: "预览", exact: true })).toBeVisible();
    expect(screen.getByTestId("viewer-body").element().scrollTop).toBe(0);
    expect(placeOf(viewOf(views.getState(), W), "file:docs/README.md").wrap).toBe(false);
  });

  it("returns to source for an explicit file-line request while previewing", async () => {
    const { screen, views } = await markdownViewer("# Document\n\nline three\nline four");
    await screen.getByRole("button", { name: "预览", exact: true }).click();
    openFile(views, W, "docs/README.md", true, { start: 3, end: 4 });
    await expect.element(screen.getByTestId("code-lines")).toBeVisible();
    await expect.poll(() => viewOf(views.getState(), W).fileReveal?.done).toBe(true);
    expect(
      [...screen.container.querySelectorAll('[data-line-target="true"]')].map((row) =>
        row.getAttribute("data-line-number"),
      ),
    ).toStrictEqual(["3", "4"]);
  });

  it("toggles the same read-only tab between source and rendered Markdown without rereading", async () => {
    const { screen, calls } = await markdownViewer(
      "# Document\n\n**Strong** text.\n\n| Key | Value |\n| --- | --- |\n| A | B |\n\n<script>throw 1</script>",
    );
    await expect.element(screen.getByTestId("code-lines")).toBeVisible();
    await screen.getByRole("button", { name: "预览", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: "Document" })).toBeVisible();
    await expect.element(screen.getByRole("table")).toBeVisible();
    expect(screen.container.querySelector('[data-streamdown="strong"]')?.textContent).toBe("Strong");
    expect(screen.container.querySelector("script")).toBeNull();
    await expect.element(screen.getByTestId("code-lines")).not.toBeVisible();
    await expect.element(screen.getByRole("button", { name: "换行", exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "查看源码" })).toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("button", { name: "查看源码" }).click();
    await expect.element(screen.getByTestId("code-lines")).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Document" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "换行", exact: true })).toBeVisible();
    expect(calls).toStrictEqual([`readFile ${W} docs/README.md`]);
  });
});
