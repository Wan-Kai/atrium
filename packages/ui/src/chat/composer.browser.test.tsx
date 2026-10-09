import { CommandError } from "@atrium/client";
import type { FileCandidate, SlashCommand } from "@atrium/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { loadDraft } from "../state/drafts";
import { Composer, type ComposerProps } from "./composer";

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

afterEach(() => localStorage.clear());

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

describe("Composer's @ files", () => {
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
});

describe("Composer's draft", () => {
  it("keeps what is in the box under its key, and brings it back", async () => {
    const first = await composer({ draftKey: "s1" });
    await userEvent.type(first.box, "半句话@ses{Enter}");
    await vi.waitFor(() =>
      expect(loadDraft("s1")).toStrictEqual({ text: "半句话", pastes: [], files: ["src/session.ts"] }),
    );
    // A new composer for the same session, as when its tab shows again.
    await first.screen.rerender(<Composer key="again" onSend={() => undefined} draftKey="s1" />);

    await expect.element(first.screen.getByRole("textbox", { name: "消息" })).toHaveValue("半句话");
    await expect.element(first.screen.getByRole("button", { name: "移除 src/session.ts" })).toBeVisible();
  });

  it("forgets the draft once sent", async () => {
    const { box } = await composer({ draftKey: "s1" });

    await userEvent.type(box, "发出去{Enter}");

    await vi.waitFor(() => expect(loadDraft("s1")).toBeNull());
  });
});

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

  it("says what can be typed", async () => {
    const { box } = await composer();

    await expect.element(box).toHaveAttribute("placeholder", "发消息或描述任务，@ 引用文件，/ 使用命令");
  });
});
