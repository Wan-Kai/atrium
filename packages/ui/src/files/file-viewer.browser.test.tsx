import { CommandError } from "@atrium/client";
import type { CommandResult, DiffFile } from "@atrium/protocol";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import { memoryStorage } from "../state/panes";
import { createWorkspaceViews, keepPlace, openFile, placeOf, viewOf } from "../state/workspace-views";
import { fakeClient, session } from "../test/fake-client";
import { FileViewer } from "./file-viewer";

const W = "wks_0000000000000001";
/** PNGs of 2×1 and 1000×1 pixels. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA8J8BAAf/Af8Bf4mnAAAAAElFTkSuQmCC";
const WIDE =
  "iVBORw0KGgoAAAANSUhEUgAAA+gAAAABCAIAAADCYhNkAAAAGklEQVR4nO3BIQEAAAACIKc73RsGIAUAAO4NDP/cTBaSBEIAAAAASUVORK5CYII=";

/** The diff of `src/a.ts`. */
const DIFF: DiffFile = {
  path: "src/a.ts",
  oldPath: null,
  status: "modified",
  added: 2,
  removed: 1,
  content: "text",
  hunks: [],
};

/**
 * A file tab on `src/a.ts` of workspace W, reading as told.
 *
 * @sideEffects Renders.
 * @param read - How the file reads.
 * @param diff - Its diff, if any.
 * @returns The screen, the client and its calls, the views, what "查看改动" was asked, and how to draw it
 * with another diff.
 */
async function viewer(read: () => Promise<CommandResult<"read_file">>, diff: DiffFile | null = null) {
  // A session running in the workspace, so a run can end.
  const { client, calls, index } = fakeClient(
    { sessions: [session({ sessionId: "s1", containerId: W, running: true })] },
    { readFile: read },
  );
  const onShowDiff = vi.fn<() => void>();
  const views = createWorkspaceViews(memoryStorage());
  openFile(views, W, "src/a.ts", true);
  const drawn = (shown: DiffFile | null) => (
    <div style={{ display: "flex", height: 300, width: 400 }}>
      <FileViewer client={client} workspaceId={W} views={views} path="src/a.ts" diff={shown} onShowDiff={onShowDiff} />
    </div>
  );
  const screen = await render(drawn(diff));
  return {
    screen,
    client,
    calls,
    index,
    views,
    onShowDiff,
    redraw: (shown: DiffFile | null) => screen.rerender(drawn(shown)),
  };
}

/**
 * A text file's reading.
 *
 * @sideEffects none
 * @param text - The text.
 * @returns The reading.
 */
function text(value: string): () => Promise<CommandResult<"read_file">> {
  return async () => ({ size: new TextEncoder().encode(value).length, content: { kind: "text", text: value } });
}

/**
 * The colour each token of a line shows in.
 *
 * @sideEffects none
 * @param line - The line's element.
 * @returns Each token's text and colour.
 */
function colours(line: Element): string[][] {
  return [...line.querySelectorAll("span[style]")].map((token) => [
    token.textContent ?? "",
    getComputedStyle(token).color,
  ]);
}

/** Checks a target row against the actual file viewport after layout settles.
 * @remarks Wrapped rows and skipped groups make estimated pixel offsets unreliable.
 * @sideEffects none
 * @param row - The target row.
 * @param viewport - Its scrolling viewport.
 * @returns Whether the entire row is visible.
 */
function rowInsideViewer(row: Element, viewport: Element): boolean {
  const target = row.getBoundingClientRect();
  const bounds = viewport.getBoundingClientRect();
  return target.top >= bounds.top && target.bottom <= bounds.bottom;
}

/**
 * A file tab on `path` of workspace W, reading as a page, with how it opens in the browser.
 *
 * @sideEffects Renders.
 * @param path - The file.
 * @param opens - Whether the desktop shell can open it in the browser.
 * @returns The screen, and what was asked to open it.
 */
async function browsable(
  path: string,
  opens = true,
  read: () => Promise<CommandResult<"read_file">> = text("<p>hi</p>\n"),
) {
  const { client } = fakeClient({}, { readFile: read });
  const onOpenInBrowser = vi.fn<() => void>();
  const views = createWorkspaceViews(memoryStorage());
  const screen = await render(
    <FileViewer
      client={client}
      workspaceId={W}
      views={views}
      path={path}
      diff={null}
      onShowDiff={() => undefined}
      onOpenInBrowser={opens ? onOpenInBrowser : undefined}
    />,
  );
  await expect.element(screen.getByRole("region", { name: path }).getByText(/行|读不了|符号链接/u)).toBeVisible();
  return { screen, onOpenInBrowser };
}

/**
 * Presses O on the window with the given modifiers held.
 *
 * @sideEffects Dispatches a key event.
 * @param held - The modifiers.
 * @returns Whether the page let the browser handle it.
 */
function pressO(held: KeyboardEventInit): boolean {
  return window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyO", key: "o", cancelable: true, ...held }));
}

describe("FileViewer", () => {
  it("shows a text file numbered under its name, directory, size and lines, coloured as the appearance is", async () => {
    const { screen } = await viewer(text("const a = 1;\nlet b;\n"));
    const lines = screen.getByTestId("code-lines");

    await expect
      .element(screen.getByRole("region", { name: "src/a.ts" }))
      .toHaveTextContent("a.tssrc/20 B · 2 行1const a = 1;2let b;");
    await expect.poll(() => colours(lines.element()).at(0)).toStrictEqual(["const", "rgb(215, 58, 73)"]);
    document.documentElement.classList.add("dark");
    onTestFinished(() => document.documentElement.classList.remove("dark"));

    expect(colours(lines.element()).at(0)).toStrictEqual(["const", "rgb(249, 117, 131)"]);
  });

  it("navigates to actual rows past skipped groups, repeats the same target, and highlights its range", async () => {
    const { screen, views } = await viewer(
      text(Array.from({ length: 260 }, (_item, index) => `const line${index + 1} = ${index + 1};`).join("\n")),
    );
    await expect.element(screen.getByTestId("code-lines")).toBeVisible();
    const body = screen.getByTestId("viewer-body").element();
    openFile(views, W, "src/a.ts", true, { start: 195, end: 198 });
    await expect.poll(() => viewOf(views.getState(), W).fileReveal?.done).toBe(true);
    const target = screen.container.querySelector('[data-line-number="195"]')!;
    expect(
      [...screen.container.querySelectorAll('[data-line-target="true"]')].map((row) =>
        row.getAttribute("data-line-number"),
      ),
    ).toStrictEqual(["195", "196", "197", "198"]);
    expect(getComputedStyle(target).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(body.getBoundingClientRect().top);
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(body.getBoundingClientRect().bottom);
    body.scrollTop = 0;
    openFile(views, W, "src/a.ts", true, { start: 195, end: 198 });
    await expect.poll(() => viewOf(views.getState(), W).fileReveal?.done).toBe(true);
    expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(body.getBoundingClientRect().top);
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(body.getBoundingClientRect().bottom);
  });

  it("uses the newest pending range after reading and targets wrapped rows across chunks", async () => {
    const pending = Promise.withResolvers<CommandResult<"read_file">>();
    const { screen, views } = await viewer(() => pending.promise);
    await screen.getByRole("button", { name: "换行" }).click();
    openFile(views, W, "src/a.ts", true, { start: 70, end: 72 });
    openFile(views, W, "src/a.ts", true, { start: 200, end: 201 });
    const value = [
      ...Array.from({ length: 195 }, () => "a long wrapped source comment ".repeat(20)),
      ...Array.from({ length: 65 }, (_item, index) => `line ${index + 196}`),
    ].join("\n");
    pending.resolve({ size: value.length, content: { kind: "text", text: value } });
    await expect.poll(() => viewOf(views.getState(), W).fileReveal?.done).toBe(true);
    const body = screen.getByTestId("viewer-body").element();
    const target = screen.container.querySelector('[data-line-number="200"]')!;
    await expect.poll(() => rowInsideViewer(target, body)).toBe(true);
    expect(
      [...screen.container.querySelectorAll('[data-line-target="true"]')].map((row) =>
        row.getAttribute("data-line-number"),
      ),
    ).toStrictEqual(["200", "201"]);
  });

  it.each([
    ["gone", "path_not_found", "文件已经不在了"],
    ["failed", "read_failed", "读不了这个文件"],
  ] as const)(
    "keeps a pending line request after a %s reading and reveals it once the file recovers",
    async (_kind, code, said) => {
      const initial = Promise.withResolvers<CommandResult<"read_file">>();
      let reading = initial.promise;
      const { screen, views, redraw } = await viewer(() => reading);
      openFile(views, W, "src/a.ts", true, { start: 195, end: 198 });
      initial.reject(new CommandError(code));
      await expect.element(screen.getByText(said)).toBeVisible();
      // Let any navigation frame run before the successful reread, not just the error render.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const consumedOnError = viewOf(views.getState(), W).fileReveal?.done;
      const body = screen.getByTestId("viewer-body").element();
      expect(body.scrollTop).toBe(0);
      expect(screen.container.querySelector('[data-line-number="195"]')).toBeNull();

      reading = text(Array.from({ length: 260 }, (_item, index) => `line ${index + 1}`).join("\n"))();
      await redraw(DIFF);
      await expect.element(screen.getByText("line 195", { exact: true })).toBeInTheDocument();
      const target = screen.container.querySelector('[data-line-number="195"]')!;
      await expect.poll(() => rowInsideViewer(target, body)).toBe(true);
      expect(body.scrollTop).toBeGreaterThan(0);
      expect(consumedOnError).toBe(false);
      await expect.poll(() => viewOf(views.getState(), W).fileReveal?.done).toBe(true);
      expect(
        [...screen.container.querySelectorAll('[data-line-target="true"]')].map((row) =>
          row.getAttribute("data-line-number"),
        ),
      ).toStrictEqual(["195", "196", "197", "198"]);

      body.scrollTop = 0;
      reading = text(Array.from({ length: 260 }, (_item, index) => `updated line ${index + 1}`).join("\n"))();
      await redraw({ ...DIFF, added: 3 });
      await expect.element(screen.getByText("updated line 195", { exact: true })).toBeInTheDocument();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      expect(body.scrollTop).toBe(0);
      expect(rowInsideViewer(target, body)).toBe(false);
      expect(viewOf(views.getState(), W).fileReveal?.done).toBe(true);
    },
  );

  it.each([
    ["empty text", { size: 0, content: { kind: "text", text: "" } }],
    ["an image", { size: 72, content: { kind: "image", mimeType: "image/png", data: PNG } }],
    ["a binary file", { size: 1536, content: { kind: "binary" } }],
    ["a large file", { size: 2 * 1024 * 1024, content: { kind: "too_large" } }],
    ["a link", { size: 0, content: { kind: "link" } }],
  ] as const)("finishes a successful line request for %s with no target row", async (_kind, result) => {
    const pending = Promise.withResolvers<CommandResult<"read_file">>();
    const { screen, views } = await viewer(() => pending.promise);
    openFile(views, W, "src/a.ts", true, { start: 195, end: 198 });
    pending.resolve(result);

    await expect.element(screen.getByRole("status")).toHaveTextContent("文件没有可定位的文本行");
    await expect.poll(() => viewOf(views.getState(), W).fileReveal?.done).toBe(true);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    expect(screen.container.querySelector("[data-line-number]")).toBeNull();
    expect(screen.getByTestId("viewer-body").element().scrollTop).toBe(0);
    expect(viewOf(views.getState(), W).fileReveal?.done).toBe(true);
  });

  it("cancels an unmounted navigation frame before it can scroll or consume the request", async () => {
    const { screen, views } = await viewer(text("one\ntwo\nthree"));
    await expect.element(screen.getByTestId("code-lines")).toBeVisible();
    const native = window.requestAnimationFrame.bind(window);
    const scheduled = Promise.withResolvers<number>();
    const callbacks = { ran: false };
    const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = native((time) => {
        callbacks.ran = true;
        callback(time);
      });
      scheduled.resolve(id);
      return id;
    });
    onTestFinished(() => frames.mockRestore());
    openFile(views, W, "src/a.ts", true, { start: 2, end: 2 });
    await scheduled.promise;
    await screen.unmount();
    await new Promise<void>((resolve) => native(() => resolve()));
    expect(callbacks.ran).toBe(false);
    expect(viewOf(views.getState(), W).fileReveal?.done).toBe(false);
  });

  it("clamps a line past the end and explains it rather than silently ignoring the request", async () => {
    const { screen, views } = await viewer(text("one\ntwo\nthree"));
    openFile(views, W, "src/a.ts", true, { start: 500, end: 501 });
    await expect.element(screen.getByRole("status")).toHaveTextContent("第 3 行（请求超出文件范围）");
    await expect.poll(() => viewOf(views.getState(), W).fileReveal?.done).toBe(true);
    expect(screen.container.querySelector('[data-line-target="true"]')?.getAttribute("data-line-number")).toBe("3");
  });

  it("draws the lines in groups of 64, laid out only near the view, 20px a line until drawn", async () => {
    const { screen } = await viewer(text(Array.from({ length: 130 }, (_, at) => `line ${at}`).join("\n")));
    const lines = screen.getByTestId("code-lines");
    await expect.element(screen.getByText("line 129")).toBeInTheDocument();

    expect(
      [...lines.element().children].map((group) => [
        group.childElementCount,
        getComputedStyle(group).contentVisibility,
        (group as HTMLElement).style.containIntrinsicHeight,
      ]),
    ).toStrictEqual([
      [64, "auto", "auto 1280px"],
      [64, "auto", "auto 1280px"],
      [2, "auto", "auto 40px"],
    ]);
  });

  it("wraps long lines only when asked", async () => {
    const { screen } = await viewer(text(`${"x".repeat(300)}\n`));
    const wrap = screen.getByRole("button", { name: "换行" });
    const body = screen.getByTestId("viewer-body").element();
    await expect.element(screen.getByTestId("code-lines")).toBeVisible();
    // A group is laid out once it shows, a frame after it is added.
    await expect.poll(() => body.scrollWidth > body.clientWidth).toBe(true);

    await wrap.click();

    await expect.element(wrap).toHaveAttribute("aria-pressed", "true");
    expect(body.scrollWidth > body.clientWidth).toBe(false);
  });

  it("keeps where it was left when it goes before the file reads", async () => {
    const { screen, views } = await viewer(async () => new Promise(() => undefined));
    keepPlace(views, W, "file:src/a.ts", { scrollTop: 300 });

    await screen.unmount();

    expect(placeOf(viewOf(views.getState(), W), "file:src/a.ts").scrollTop).toBe(300);
  });

  it.each([
    ["shrinks an image wider than the tab", WIDE, 352],
    ["shows a small image at its own size", PNG, 2],
  ])("%s", async (_case, data, width) => {
    const { screen } = await viewer(async () => ({
      size: 72,
      content: { kind: "image", mimeType: "image/png", data },
    }));

    const image = screen.getByRole("img", { name: "a.ts" });
    await expect.element(image).toHaveAttribute("src", `data:image/png;base64,${data}`);
    await expect.poll(() => image.element().getBoundingClientRect().width).toBe(width);
  });

  it.each([
    [
      "a binary file",
      async () => ({ size: 1536, content: { kind: "binary" as const } }),
      "二进制文件，不显示内容（1.5 KB）",
    ],
    [
      "a file too large",
      async () => ({ size: 1.5 * 1024 * 1024, content: { kind: "too_large" as const } }),
      "文件太大（1.5 MB），不在这里显示",
    ],
    ["a link", async () => ({ size: 0, content: { kind: "link" as const } }), "这是符号链接，不显示内容"],
    ["a file gone", async () => Promise.reject(new CommandError("path_not_found")), "文件已经不在了"],
    ["a file not read", async () => Promise.reject(new CommandError("read_failed")), "读不了这个文件"],
  ])("says so for %s", async (_case, read, said) => {
    const { screen } = await viewer(read);

    await expect.element(screen.getByText(said)).toBeVisible();
  });

  it("opens an HTML file in the browser from its button and ⌘O, until the tab goes", async () => {
    const { screen, onOpenInBrowser } = await browsable("site/index.html");
    const button = screen.getByRole("button", { name: "在浏览器打开" });

    await button.click();
    const handled = [
      pressO({ metaKey: true }),
      pressO({ metaKey: true, shiftKey: true }),
      pressO({ metaKey: true, altKey: true }),
      pressO({ metaKey: true, ctrlKey: true }),
      pressO({}),
    ];
    const whileShown = [button.element().getAttribute("title"), onOpenInBrowser.mock.calls.length];
    await screen.unmount();
    pressO({ metaKey: true });

    expect([handled, whileShown, onOpenInBrowser.mock.calls.length]).toStrictEqual([
      [false, true, true, true, true],
      ["在浏览器打开 (⌘O)", 2],
      2,
    ]);
  });

  it.each([
    ["an .htm file, in any case", "PAGE.HTM", true, 1],
    ["another file", "src/a.ts", true, 0],
    ["a file named html", "src/html", true, 0],
    ["a file with .html inside its name", "page.html.ts", true, 0],
    ["an HTML file without the desktop shell", "index.html", false, 0],
  ])("offers the browser for %s only where it opens", async (_what, path, opens, buttons) => {
    const { screen, onOpenInBrowser } = await browsable(path, opens);

    pressO({ metaKey: true });

    expect([
      screen.getByRole("button", { name: "在浏览器打开" }).elements().length,
      onOpenInBrowser.mock.calls.length,
    ]).toStrictEqual([buttons, buttons]);
  });

  it.each([
    [
      "the host refuses, as one reached through a linked folder",
      async () => Promise.reject(new CommandError("path_invalid")),
    ],
    ["that is a link", async () => ({ size: 10, content: { kind: "link" as const } })],
  ])("offers no browser for an HTML file %s", async (_what, read) => {
    const { screen, onOpenInBrowser } = await browsable("site/index.html", true, read);

    pressO({ metaKey: true });

    expect([
      screen.getByRole("button", { name: "在浏览器打开" }).elements().length,
      onOpenInBrowser.mock.calls.length,
    ]).toStrictEqual([0, 0]);
  });

  it("shows the file's changes with a way to them while it has a diff", async () => {
    const { screen, onShowDiff, redraw } = await viewer(text("a\n"), DIFF);
    const header = screen.getByRole("region", { name: "src/a.ts" }).element().querySelector("header");
    await expect.element(screen.getByTestId("code-lines")).toBeVisible();
    const shown = header?.textContent;

    await screen.getByRole("button", { name: "查看改动" }).click();
    await redraw(null);

    await expect.element(screen.getByRole("button", { name: "查看改动" })).not.toBeInTheDocument();
    expect([shown, onShowDiff.mock.calls.length]).toStrictEqual(["a.tssrc/2 B · 1 行+2−1查看改动", 1]);
  });

  it("reads again at a run's end and when its diff changes, keeping the scroll while it reads the same", async () => {
    let value = Array.from({ length: 100 }, (_, at) => `line ${at}`).join("\n");
    const { screen, calls, index, redraw } = await viewer(async () => text(value)());
    const body = screen.getByTestId("viewer-body").element();
    await expect.element(screen.getByText("line 99")).toBeInTheDocument();
    body.scrollTop = 400;
    const reads = () => calls.filter((call) => call.startsWith("readFile")).length;

    index.setState({ sessions: [session({ sessionId: "s1", containerId: W, running: false })] });
    await expect.poll(reads).toBe(2);
    await redraw(DIFF);
    await expect.poll(reads).toBe(3);
    const kept = body.scrollTop;
    value = "fresh";
    await redraw({ ...DIFF, added: 3 });

    await expect.element(screen.getByText("fresh")).toBeVisible();
    expect([kept, reads()]).toStrictEqual([400, 4]);
  });
});
