import { CommandError } from "@atrium/client";
import type { FileCandidate, SlashCommand } from "@atrium/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import type { CatalogModel } from "@atrium/protocol";
import { pageDrafts } from "../state/use-draft";
import { Composer, type ComposerProps } from "./composer";
import { compressImage } from "./images";
import { ModelPicker } from "./model-picker";

const COMMANDS: SlashCommand[] = [
  { name: "mcp", description: "Manage MCP servers", source: "extension" },
  { name: "review", description: "Reviews the change", source: "prompt" },
  { name: "skill:tdd", description: "Test first", source: "skill" },
];

const FILES: FileCandidate[] = [
  { path: "src/", directory: true },
  { path: "src/session.ts", directory: false },
  { path: "My Notes.md", directory: false },
];

afterEach(() => {
  localStorage.clear();
  pageDrafts().drop(["s1"]);
});

/** A draft key of its own, so tests never share a draft. */
function freshKey(): string {
  return `test:${crypto.randomUUID()}`;
}

/**
 * Renders a composer at the bottom of a tall page, recording what it sends and asks for.
 *
 * @remarks
 * Lists open above the box, as they do above the input box in the window.
 *
 * @sideEffects Renders.
 * @param props - Props besides `onSend`.
 * @returns The screen, the box, what was sent, and the searches asked for.
 */
async function composer(props: Partial<ComposerProps> = {}) {
  const sent: string[] = [];
  const searched: string[] = [];
  const screen = await render(
    <div style={{ paddingTop: 480 }}>
      <Composer
        draftKey={freshKey()}
        onSend={(text) => sent.push(text)}
        onListCommands={async () => COMMANDS}
        onSearchFiles={async (query) => {
          searched.push(query);
          return FILES.filter((file) => file.path.toLowerCase().includes(query.toLowerCase()));
        }}
        {...props}
      />
    </div>,
  );
  return { screen, box: screen.getByRole("textbox", { name: "消息" }), sent, searched };
}

describe("Composer's / commands", () => {
  it("lists pi's commands as / is typed at the start, narrowing as more is typed", async () => {
    const { screen, box } = await composer();

    await userEvent.type(box, "/");
    const list = screen.getByRole("listbox", { name: "命令" });
    await expect.element(list).toBeVisible();
    expect(
      screen
        .getByRole("option")
        .elements()
        .map((option) => option.textContent),
    ).toStrictEqual(["/mcp扩展Manage MCP servers", "/review模板Reviews the change", "/skill:tdd技能Test first"]);
    await userEvent.type(box, "rev");

    expect(
      screen
        .getByRole("option")
        .elements()
        .map((option) => option.textContent),
    ).toStrictEqual(["/review模板Reviews the change"]);
  });

  it("puts the chosen command in the box with Enter, without sending", async () => {
    const { screen, box, sent } = await composer();

    await userEvent.type(box, "/re{ArrowDown}{Enter}");

    await expect.element(box).toHaveValue("/review ");
    await expect.element(screen.getByRole("listbox")).not.toBeInTheDocument();
    expect(sent).toStrictEqual([]);
  });

  it("sends a command typed whole with Enter, the list open or not", async () => {
    const { box, sent } = await composer();

    await userEvent.type(box, "/review{Enter}");

    expect(sent).toStrictEqual(["/review"]);
  });

  it("sends with Enter while the list has nothing to choose yet", async () => {
    const { box, sent } = await composer({ onListCommands: () => new Promise(() => undefined) });

    await userEvent.type(box, "/faux-confirm{Enter}");

    expect(sent).toStrictEqual(["/faux-confirm"]);
  });

  it("moves through the list with ↑ ↓, chooses with Tab, and closes on Escape", async () => {
    const { screen, box } = await composer();

    await userEvent.type(box, "/{ArrowDown}{ArrowDown}{ArrowUp}");
    await expect.element(screen.getByRole("option", { name: /review/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Tab}");
    await expect.element(box).toHaveValue("/review ");

    await userEvent.clear(box);
    await userEvent.type(box, "/{Escape}");
    await expect.element(screen.getByRole("listbox")).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
  });

  it("does not list commands past the first word, nor without a / at the start", async () => {
    const { screen, box } = await composer();

    await userEvent.type(box, "a /rev");
    await expect.element(screen.getByRole("listbox")).not.toBeInTheDocument();
  });

  it("says when the commands cannot be read", async () => {
    const { screen, box } = await composer({ onListCommands: () => Promise.reject(new Error("gone")) });

    await userEvent.type(box, "/");

    await expect.element(screen.getByText("读不到命令列表")).toBeVisible();
  });
});

/** A search answering each query with its own promise. */
function answering(
  answers: Readonly<Record<string, Promise<readonly FileCandidate[]>>>,
): (query: string) => Promise<readonly FileCandidate[]> {
  return (query) => answers[query] ?? Promise.resolve([]);
}

describe("Composer's @ files", () => {
  it("chooses no file found for the query before, while the new one is on its way", async () => {
    const later = Promise.withResolvers<readonly FileCandidate[]>();
    const { screen, box } = await composer({
      onSearchFiles: answering({ a: Promise.resolve([{ path: "a.ts", directory: false }]), ab: later.promise }),
    });
    await userEvent.type(box, "@a");
    await expect.element(screen.getByRole("option", { name: "a.ts" })).toBeVisible();

    await userEvent.keyboard("b{Enter}");

    await expect.element(box).toHaveValue("@ab");
    await expect.element(screen.getByRole("button", { name: "移除 a.ts" })).not.toBeInTheDocument();
    later.resolve([{ path: "ab.ts", directory: false }]);
    await expect.element(screen.getByRole("option", { name: "ab.ts" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("button", { name: "移除 ab.ts" })).toBeVisible();
  });

  it("searches as @ is typed, and turns the chosen file into a capsule above the box", async () => {
    const { screen, box, searched, sent } = await composer();

    await userEvent.type(box, "看看 @ses");
    await expect.element(screen.getByRole("listbox", { name: "文件" })).toBeVisible();
    await expect
      .element(screen.getByRole("option", { name: "src/session.ts" }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");

    await expect.element(box).toHaveValue("看看 ");
    await expect.element(screen.getByRole("button", { name: "移除 src/session.ts" })).toBeVisible();
    expect(searched.at(-1)).toBe("ses");
    await userEvent.type(box, "{Enter}");
    expect(sent).toStrictEqual(["看看\n\n@src/session.ts"]);
  });

  it("goes into a directory with Tab, and references it with Enter", async () => {
    const { screen, box, sent } = await composer();

    await userEvent.type(box, "@sr");
    await expect.element(screen.getByRole("option", { name: "src/" })).toBeVisible();
    await userEvent.keyboard("{Tab}");
    await expect.element(box).toHaveValue("@src/");
    await userEvent.keyboard("{Escape}");
    await userEvent.clear(box);
    await userEvent.type(box, "@sr{Enter}");
    await userEvent.type(box, "这个目录{Enter}");

    expect(sent).toStrictEqual(["这个目录\n\n@src/"]);
  });

  it("quotes a path with spaces, and drops a capsule removed", async () => {
    const { screen, box, sent } = await composer();

    await userEvent.type(box, "@notes{Enter}@ses{Enter}");
    await screen.getByRole("button", { name: "移除 src/session.ts" }).click();
    await userEvent.type(box, "{Enter}");

    expect(sent).toStrictEqual(['@"My Notes.md"']);
  });

  it("explains a missing fd", async () => {
    const { screen, box } = await composer({ onSearchFiles: () => Promise.reject(new CommandError("fd_missing")) });

    await userEvent.type(box, "@x");

    await expect.element(screen.getByText(/没有找到 fd/)).toBeVisible();
  });

  it("does not search in a mail address", async () => {
    const { screen, box, searched } = await composer();

    await userEvent.type(box, "me@host");

    await expect.element(screen.getByRole("listbox")).not.toBeInTheDocument();
    expect(searched).toStrictEqual([]);
  });
});

/** Pastes `text` into the box as the clipboard would; whether the box let the paste through. */
function paste(box: Element, text: string): boolean {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  return box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

describe("Composer's pasted text", () => {
  it("collects a long paste into a capsule, sent after the text", async () => {
    const { screen, box, sent } = await composer();
    const long = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");

    await userEvent.type(box, "看这段");
    expect(paste(box.element(), long)).toBe(false);

    await expect.element(screen.getByRole("button", { name: "移除 粘贴内容 · 12 行" })).toBeVisible();
    await expect.element(box).toHaveValue("看这段");
    await userEvent.type(box, "{Enter}");
    expect(sent).toStrictEqual([`看这段\n\n${long}`]);
  });

  it("leaves a short paste to the box", async () => {
    const { screen, box } = await composer();

    expect(paste(box.element(), "short")).toBe(true);
    await expect.element(screen.getByRole("button", { name: /^移除 粘贴内容/ })).not.toBeInTheDocument();
  });
});

describe("Composer's history", () => {
  it("goes back through earlier messages with ↑ in an empty box, and forward with ↓", async () => {
    const older = vi.fn<() => void>();
    const { box } = await composer({ history: ["二", "一"], onOlderHistory: older });

    await userEvent.type(box, "{ArrowUp}");
    await expect.element(box).toHaveValue("二");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(box).toHaveValue("一");
    expect(older).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(box).toHaveValue("一");
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(box).toHaveValue("二");
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(box).toHaveValue("");
  });

  it("leaves ↑ alone once something is typed", async () => {
    const { box } = await composer({ history: ["二"] });

    await userEvent.type(box, "a{ArrowUp}");

    await expect.element(box).toHaveValue("a");
  });

  it("leaves ↑ alone while a capsule is above an empty box", async () => {
    const { screen, box } = await composer({ history: ["二"] });
    await userEvent.type(box, "@ses");
    await expect.element(screen.getByRole("option", { name: "src/session.ts" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("button", { name: "移除 src/session.ts" })).toBeVisible();

    await userEvent.keyboard("{ArrowUp}");

    await expect.element(box).toHaveValue("");
  });
});

describe("Composer's draft", () => {
  it("keeps what is in the box under its key, and brings it back", async () => {
    const first = await composer({ draftKey: "s1" });
    await userEvent.type(first.box, "半句话@ses{Enter}");
    await vi.waitFor(() =>
      expect(pageDrafts().read("s1")).toStrictEqual({
        text: "半句话",
        pastes: [],
        files: ["src/session.ts"],
        images: [],
      }),
    );
    // A new composer for the same session, as when its tab shows again.
    await first.screen.rerender(<Composer key="again" onSend={() => undefined} draftKey="s1" />);

    await expect.element(first.screen.getByRole("textbox", { name: "消息" })).toHaveValue("半句话");
    await expect.element(first.screen.getByRole("button", { name: "移除 src/session.ts" })).toBeVisible();
  });

  it("forgets the draft once sent", async () => {
    const { box } = await composer({ draftKey: "s1" });

    await userEvent.type(box, "发出去{Enter}");

    await vi.waitFor(() => expect(localStorage.getItem("atrium-draft:s1")).toBeNull());
  });
});

/**
 * A model button with nothing listed, as the composer shows it beside the send button.
 *
 * @remarks
 * For what the button looks like, not what it chooses.
 *
 * @sideEffects none
 * @param disabled - Whether the button cannot be pressed.
 * @returns The button.
 */
function emptyPicker(disabled: boolean) {
  return (
    <ModelPicker
      shown={null}
      list={{ status: "ready", models: [], defaultModel: null, error: null }}
      disabled={disabled}
      onOpen={() => undefined}
      onRefresh={() => undefined}
      onChooseModel={() => undefined}
      onChooseLevel={() => undefined}
    />
  );
}

describe("Composer's other controls", () => {
  it("opens the box tall and back", async () => {
    const { screen, box } = await composer();
    const short = box.element().getBoundingClientRect().height;

    await screen.getByRole("button", { name: "展开输入框" }).click();
    expect(box.element().getBoundingClientRect().height).toBeGreaterThan(short + 100);
    await screen.getByRole("button", { name: "收起输入框" }).click();

    expect(box.element().getBoundingClientRect().height).toBe(short);
  });

  it("offers @ and / from its + menu", async () => {
    const { screen, box } = await composer();

    await screen.getByRole("button", { name: "添加" }).click();
    await screen.getByRole("menuitem", { name: "引用文件或目录" }).click();
    await expect.element(box).toHaveValue("@");
    await expect.element(box).toHaveFocus();
    await expect.element(screen.getByRole("listbox", { name: "文件" })).toBeVisible();

    await userEvent.clear(box);
    await screen.getByRole("button", { name: "添加" }).click();
    await screen.getByRole("menuitem", { name: "命令" }).click();
    await expect.element(box).toHaveValue("/");
    await expect.element(screen.getByRole("listbox", { name: "命令" })).toBeVisible();
  });

  it("shows a pointing hand over its buttons while they can be pressed, and none while they cannot", async () => {
    const { screen, box } = await composer({ picker: emptyPicker(false) });
    const cursor = (name: string | RegExp): string =>
      getComputedStyle(screen.getByRole("button", { name }).element()).cursor;
    const names = ["添加", "展开输入框", /^模型与推理强度/, "发送"];
    const empty = names.map(cursor);
    await userEvent.type(box, "你好");
    const typed = names.map(cursor);

    await screen.rerender(
      <Composer
        draftKey={freshKey()}
        onSend={() => undefined}
        running
        picker={emptyPicker(true)}
        onStop={() => undefined}
      />,
    );
    const running = cursor("停止");
    await screen.rerender(
      <Composer draftKey={freshKey()} onSend={() => undefined} running stopping picker={emptyPicker(true)} />,
    );

    expect({ empty, typed, running, stopping: [cursor(/^模型与推理强度/), cursor("停止中")] }).toStrictEqual({
      empty: ["pointer", "pointer", "pointer", "default"],
      typed: ["pointer", "pointer", "pointer", "pointer"],
      running: "pointer",
      stopping: ["default", "default"],
    });
  });

  it("says what can be typed", async () => {
    const { box } = await composer();

    await expect.element(box).toHaveAttribute("placeholder", "发消息或描述任务，@ 引用文件，/ 使用命令");
  });
});

/** A small PNG, as a pasted screenshot. */
async function screenshot(name = "shot.png"): Promise<File> {
  const canvas = new OffscreenCanvas(40, 30);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  context.fillStyle = "#5e84ff";
  context.fillRect(0, 0, 40, 30);
  return new File([await canvas.convertToBlob({ type: "image/png" })], name, { type: "image/png" });
}

/** Pastes files into the box as the clipboard would; whether the box let the paste through. */
function pasteFiles(box: Element, files: readonly File[]): boolean {
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  return box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

/** Drops files on an element, as dragging them from the Finder would. */
function drop(target: Element, files: readonly File[]): void {
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  target.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
  target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
}

/** Where each dropped file is, by name, as the desktop shell would tell. */
function pathIn(paths: Readonly<Record<string, string>>): (file: File) => string | null {
  return (file) => paths[file.name] ?? null;
}

/** A composer whose uploads are answered a1, a2, …, recording what is sent with images. */
async function withUploads(props: Partial<ComposerProps> = {}) {
  const sent: [string, string[]][] = [];
  const uploads: string[] = [];
  let next = 0;
  const screen = await render(
    <div style={{ paddingTop: 480 }}>
      <Composer
        draftKey={freshKey()}
        onSend={(text, images) => sent.push([text, images.map((image) => image.attachmentId)])}
        onUpload={async (image) => {
          uploads.push(image.mimeType);
          return `a${++next}`;
        }}
        {...props}
      />
    </div>,
  );
  return { screen, box: screen.getByRole("textbox", { name: "消息" }), sent, uploads };
}

describe("Composer's images", () => {
  it("uploads a pasted screenshot at once and sends it with the message, even without text", async () => {
    const { screen, box, sent, uploads } = await withUploads();

    expect(pasteFiles(box.element(), [await screenshot()])).toBe(false);
    await expect.element(screen.getByRole("img", { name: "图片 1" })).toBeVisible();
    await vi.waitFor(() => expect(uploads).toStrictEqual(["image/webp"]));
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    await userEvent.type(box, "{Enter}");

    expect(sent).toStrictEqual([["", ["a1"]]]);
    await expect.element(screen.getByRole("img", { name: "图片 1" })).not.toBeInTheDocument();
  });

  it("waits for uploads before sending", async () => {
    const gate = Promise.withResolvers<string>();
    const { screen, box, sent } = await withUploads({ onUpload: () => gate.promise });

    pasteFiles(box.element(), [await screenshot()]);
    await userEvent.type(box, "看图{Enter}");
    expect(sent).toStrictEqual([]);
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    gate.resolve("a9");
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    await userEvent.type(box, "{Enter}");

    expect(sent).toStrictEqual([["看图", ["a9"]]]);
  });

  it("says when the model takes no images, adding none", async () => {
    const { screen, box, uploads } = await withUploads({ imagesAllowed: false });

    pasteFiles(box.element(), [await screenshot()]);

    await expect.element(screen.getByText("当前模型不支持图片")).toBeVisible();
    expect(uploads).toStrictEqual([]);
    await expect.element(screen.getByRole("img", { name: "图片 1" })).not.toBeInTheDocument();
  });

  it("warns, without blocking, when the model changes to one that takes no images after they were added", async () => {
    const { screen, box, sent } = await withUploads({ draftKey: "s1" });
    pasteFiles(box.element(), [await screenshot()]);
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeEnabled();

    await screen.rerender(
      <div style={{ paddingTop: 480 }}>
        <Composer
          draftKey="s1"
          onSend={(text, images) => sent.push([text, images.map((image) => image.attachmentId)])}
          onUpload={async () => "a1"}
          imagesAllowed={false}
        />
      </div>,
    );

    await expect.element(screen.getByText("当前模型不支持图片，发出后模型看不到它们")).toBeVisible();
    await userEvent.type(box, "{Enter}");
    expect(sent).toStrictEqual([["", ["a1"]]]);
  });

  it("says when an image cannot be uploaded, and drops it", async () => {
    const { screen, box } = await withUploads({
      onUpload: () => Promise.reject(new CommandError("attachment_limit")),
    });

    pasteFiles(box.element(), [await screenshot()]);

    await expect.element(screen.getByText("图片太多了：一次最多 20 张、共 32 MiB")).toBeVisible();
    await expect.element(screen.getByRole("img", { name: "图片 1" })).not.toBeInTheDocument();
  });

  it("removes an image", async () => {
    const { screen, box, sent } = await withUploads();
    pasteFiles(box.element(), [await screenshot()]);
    await expect.element(screen.getByRole("img", { name: "图片 1" })).toBeVisible();

    await screen.getByRole("button", { name: "移除 图片 1" }).click();
    await userEvent.type(box, "只有字{Enter}");

    expect(sent).toStrictEqual([["只有字", []]]);
  });

  it("adds images from the + menu", async () => {
    const { screen, uploads } = await withUploads();

    await screen.getByRole("button", { name: "添加" }).click();
    await userEvent.upload(screen.getByLabelText("选择图片"), [await screenshot("a.png"), await screenshot("b.png")]);

    await expect.element(screen.getByRole("img", { name: "图片 2" })).toBeVisible();
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
  });

  it("takes dropped images as images, and other files as references from the session's directory", async () => {
    const { screen, box, sent } = await withUploads({
      baseDir: "/work/app",
      pathForFile: pathIn({ "notes.md": "/work/app/docs/notes.md", "far.txt": "/elsewhere/far.txt" }),
    });
    const card = screen.getByTestId("composer-card");

    drop(card.element(), [await screenshot(), new File(["x"], "notes.md"), new File(["y"], "far.txt")]);

    await expect.element(screen.getByRole("img", { name: "图片 1" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "移除 docs/notes.md" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "移除 /elsewhere/far.txt" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    await userEvent.type(box, "{Enter}");
    expect(sent).toStrictEqual([["@docs/notes.md @/elsewhere/far.txt", ["a1"]]]);
  });

  it("outlines the box while files are dragged over it", async () => {
    const { screen } = await withUploads();
    const card = screen.getByTestId("composer-card");

    card
      .element()
      .dispatchEvent(new DragEvent("dragover", { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true }));

    await expect.element(card).toHaveAttribute("data-dragging");
    await expect.element(screen.getByText("松开以添加图片或引用文件")).toBeVisible();
  });

  it("keeps images while the session's tab is away, but not past a reload", async () => {
    const first = await withUploads({ draftKey: "s1" });
    pasteFiles(first.box.element(), [await screenshot()]);
    await vi.waitFor(() => expect(first.uploads).toHaveLength(1));

    await first.screen.rerender(<Composer key="again" onSend={() => undefined} draftKey="s1" />);

    await expect.element(first.screen.getByRole("img", { name: "图片 1" })).toBeVisible();
  });

  it("lands an upload that ends after the box went away, so the message goes once the box is back", async () => {
    const gate = Promise.withResolvers<string>();
    const first = await withUploads({ draftKey: "s1", onUpload: () => gate.promise });
    pasteFiles(first.box.element(), [await screenshot()]);
    await expect.element(first.screen.getByRole("img", { name: "图片 1" })).toBeVisible();

    await first.screen.rerender(<div />);
    gate.resolve("a7");
    await gate.promise;
    const sent: [string, string[]][] = [];
    await first.screen.rerender(
      <Composer
        draftKey="s1"
        onSend={(text, images) => sent.push([text, images.map((image) => image.attachmentId)])}
      />,
    );

    await expect.element(first.screen.getByRole("button", { name: "发送" })).toBeEnabled();
    await userEvent.type(first.screen.getByRole("textbox", { name: "消息" }), "{Enter}");
    expect(sent).toStrictEqual([["", ["a7"]]]);
  });

  it("sends nothing while a pasted image is still being compressed, showing where it will be", async () => {
    const compressing = Promise.withResolvers<void>();
    const { screen, box, sent } = await withUploads({
      compress: async (file) => {
        await compressing.promise;
        return compressImage(file);
      },
    });
    await userEvent.type(box, "看");

    pasteFiles(box.element(), [await screenshot()]);
    await expect.element(screen.getByRole("img", { name: "图片 1 正在处理" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(sent).toStrictEqual([]);
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    compressing.resolve();
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    await userEvent.keyboard("{Enter}");

    expect(sent).toStrictEqual([["看", ["a1"]]]);
  });
});

describe("Composer's keys beside the model panel", () => {
  const listed: CatalogModel = {
    providerId: "anthropic",
    modelId: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsImage: true,
    thinkingLevels: ["off", "low", "high"],
    fast: null,
  };

  it("closes the model panel opened with ⌘⇧I on Esc without stopping the run, and stops on the next", async () => {
    const onStop = vi.fn<() => void>();
    const { screen, box } = await composer({
      running: true,
      onStop,
      picker: (
        <ModelPicker
          shown={null}
          list={{ status: "ready", models: [listed], defaultModel: null, error: null }}
          disabled={false}
          onOpen={() => undefined}
          onRefresh={() => undefined}
          onChooseModel={() => undefined}
          onChooseLevel={() => undefined}
        />
      ),
    });
    await userEvent.click(box);

    await userEvent.keyboard("{Meta>}{Shift>}i{/Shift}{/Meta}");
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    expect(onStop).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
