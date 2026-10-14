import { CommandError } from "@atrium/client";
import type { CommandResult, DiffFile } from "@atrium/protocol";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
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
 * @returns The screen, the client and its calls, what "查看改动" was asked, and how to draw it with another diff.
 */
async function viewer(read: () => Promise<CommandResult<"read_file">>, diff: DiffFile | null = null) {
  // A session running in the workspace, so a run can end.
  const { client, calls, index } = fakeClient(
    { sessions: [session({ sessionId: "s1", containerId: W, running: true })] },
    { readFile: read },
  );
  const onShowDiff = vi.fn<() => void>();
  const drawn = (shown: DiffFile | null) => (
    <div style={{ display: "flex", height: 300, width: 400 }}>
      <FileViewer client={client} workspaceId={W} path="src/a.ts" diff={shown} onShowDiff={onShowDiff} />
    </div>
  );
  const screen = await render(drawn(diff));
  return {
    screen,
    client,
    calls,
    index,
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
