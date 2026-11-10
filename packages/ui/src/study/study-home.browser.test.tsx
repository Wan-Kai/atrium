import { CommandError } from "@atrium/client";
import type { DirEntry, StudyAction, StudyProgress } from "@atrium/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { Workbench } from "../app/workbench";
import { direction, fakeClient, session } from "../test/fake-client";

const RUST = "lrn_rust";

/** Two levels: the first done with one lesson, the second current at its second lesson. */
const PROGRESS: StudyProgress = {
  profile: {},
  ladder: [
    { id: "l1", name: "语法", topics: "", pass: "", state: "done" },
    { id: "l2", name: "所有权", topics: "", pass: "", state: "current" },
  ],
  steps: {
    l1: [{ id: "s1", kind: "lesson", title: "变量", lesson: { by: "agent" }, quiz: null, done: { by: "agent" } }],
    l2: [
      {
        id: "s1",
        kind: "lesson",
        title: "借用规则",
        lesson: { by: "agent" },
        quiz: { by: "agent", score: 32, of: 50 },
        done: { by: "agent" },
      },
      { id: "s2", kind: "lesson", title: "生命周期", lesson: null, quiz: null, done: null },
      { id: "s3", kind: "sheet", done: null },
      { id: "s4", kind: "project", done: null },
      { id: "s5", kind: "exam", done: null },
      { id: "s6", kind: "up", done: null },
    ],
  },
  gaps: [],
  finishedAt: null,
};

/** The strip's start of the second lesson. */
const START: StudyAction = { type: "start", kind: "lesson", level: "l2", step: "s2", available: true };

/**
 * Renders the workbench over a fake client with the list given, on the learning home.
 *
 * @remarks
 * A wide window, so the home's two columns show.
 *
 * @sideEffects Renders; clears `localStorage` when the test ends.
 * @param initial - The list.
 * @param answers - How some commands answer.
 * @returns The screen, the fake, and the paths it asked the browser to open.
 */
async function learningHome(
  initial: Parameters<typeof fakeClient>[0] = {},
  answers: Parameters<typeof fakeClient>[1] = {},
) {
  await page.viewport(1280, 900);
  onTestFinished(() => localStorage.clear());
  const fake = fakeClient(initial, answers);
  const browsed: string[] = [];
  const screen = await render(
    <Workbench
      client={fake.client}
      status={<span>已连接宿主</span>}
      pickDirectory={async () => null}
      setNativeAppearance={undefined}
      openUrl={() => undefined}
      reveal={undefined}
      pathForFile={undefined}
      openInBrowser={(path) => browsed.push(path)}
    />,
  );
  await screen.getByTestId("learning-row").click();
  return { screen, browsed, ...fake };
}

/**
 * The Rust direction, learning `PROGRESS`, opened last.
 *
 * @remarks
 * Its next step is `next`.
 *
 * @sideEffects none
 * @param next - The strip's buttons.
 * @param more - What the test changes.
 * @returns The direction.
 */
function rust(next: Partial<{ primary: StudyAction | null; secondary: StudyAction | null }> = {}, more = {}) {
  return direction({
    id: RUST,
    name: "Rust",
    discussing: false,
    lastOpenedAt: 20,
    progress: PROGRESS,
    next: { primary: START, secondary: null, ...next },
    ...more,
  });
}

describe("the continue card (SPEC-0008, ML4, prototype 1C)", () => {
  it("names the next step with the strip's dots, starts it with one press, and says what was last", async () => {
    const quiz = session({
      sessionId: "quiz",
      containerId: RUST,
      study: { kind: "quiz", level: "l2", step: "s1" },
      updatedAt: Date.now() - 5 * 60_000,
    });
    const { screen, calls } = await learningHome({ directions: [rust()], sessions: [quiz] });
    const resume = screen.getByRole("region", { name: "继续" });

    await expect
      .element(resume)
      .toHaveTextContent("继续Rust · 第 2 级 · 第 2 步生命周期开始上课打开 Rust上次：5 分钟前 · 测验 · 借用规则 32/50");
    await expect.element(resume.getByRole("img", { name: "共 6 步" })).toBeVisible();
    await resume.getByRole("button", { name: "开始上课" }).click();

    await expect
      .poll(() => calls.filter((call) => /^(selectContainer|startStudySession)/.test(call)))
      .toStrictEqual([
        `startStudySession ${RUST} {"kind":"lesson","level":"l2","step":"s2"}`,
        `selectContainer ${RUST}`,
      ]);
    await expect.element(screen.getByTestId("learning-bar")).not.toBeInTheDocument();
  });

  it("goes back to the session open for the step, with its running dot", async () => {
    const lesson = session({ sessionId: "lesson", containerId: RUST, running: true });
    const { screen, calls } = await learningHome({
      directions: [rust({ primary: { type: "open", sessionId: "lesson" } })],
      sessions: [lesson],
    });
    const resume = screen.getByRole("region", { name: "继续" });

    await expect.element(resume.getByLabelText("在跑")).toBeVisible();
    await resume.getByRole("button", { name: /回到会话$/ }).click();

    await expect.poll(() => calls).toContain("openSession lesson");
  });

  it("opens the direction's home from the learning home over a viewer tab left open in it", async () => {
    const { screen } = await learningHome({ directions: [rust()] }, { listDir: listing, readFile: noteOrDemo });
    await openResources(screen);
    await screen.getByTestId("learning-row").click();

    await screen.getByRole("region", { name: "继续" }).getByRole("button", { name: "打开 Rust" }).click();

    await expect.element(screen.getByTestId("direction-home")).toBeVisible();
    await expect.element(screen.getByRole("region", { name: "resources.md" })).not.toBeInTheDocument();
  });

  it("goes back to the session already active in the direction over a viewer tab left open in it", async () => {
    const lesson = session({
      sessionId: "lesson",
      containerId: RUST,
      study: { kind: "lesson", level: "l2", step: "s2" },
    });
    const { screen, calls } = await learningHome(
      {
        directions: [rust({ primary: { type: "open", sessionId: "lesson" } })],
        sessions: [lesson],
        layout: { container: RUST, tabs: { [RUST]: { open: ["lesson"], active: "lesson" } } },
      },
      { listDir: listing, readFile: noteOrDemo },
    );
    await openResources(screen);
    await screen.getByTestId("learning-row").click();

    await screen
      .getByRole("region", { name: "继续" })
      .getByRole("button", { name: /回到会话$/ })
      .click();

    await expect.poll(() => calls).toContain("openSession lesson");
    await expect.element(screen.getByRole("region", { name: "resources.md" })).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("direction-home")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("tab", { name: /resources\.md/u })).toHaveAttribute("aria-selected", "false");
  });

  it("marks 进入下一步 from the home and stays there", async () => {
    const { screen, calls } = await learningHome({
      directions: [rust({ primary: { type: "mark", mark: "step", level: "l2", step: "s1" } })],
    });

    await screen.getByRole("region", { name: "继续" }).getByRole("button", { name: "进入下一步" }).click();

    await expect
      .poll(() => calls.filter((call) => call.startsWith("markStudyStep")))
      .toStrictEqual([`markStudyStep ${RUST} l2 s1 step true`]);
    expect(calls.filter((call) => call.startsWith("selectContainer"))).toStrictEqual([]);
    await expect.element(screen.getByRole("region", { name: "继续" })).toBeVisible();
  });

  it("asks to upgrade on the direction's home, the last level's as 学完", async () => {
    const { screen, calls } = await learningHome({
      directions: [rust({ primary: { type: "upgrade", level: "l2", available: true } })],
    });

    await screen.getByRole("region", { name: "继续" }).getByRole("button", { name: "学完" }).click();

    await expect.element(screen.getByTestId("direction-home")).toBeVisible();
    await expect.element(screen.getByRole("alertdialog")).toBeVisible();
    expect(calls.filter((call) => call.startsWith("upgradeStudy"))).toStrictEqual([]);
  });

  it("says why a press was refused, above the card, and lets it be pressed again", async () => {
    const { screen } = await learningHome(
      { directions: [rust()] },
      { directionCommand: async () => Promise.reject(new CommandError("session_busy")) },
    );
    const resume = screen.getByRole("region", { name: "继续" });

    await resume.getByRole("button", { name: "开始上课" }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("等上课这一轮结束");
    await expect.element(resume.getByRole("button", { name: "开始上课" })).toBeEnabled();
  });

  it("only opens a direction with nothing to start, drawn as the primary, and says a broken file's line", async () => {
    const { screen, calls } = await learningHome({
      directions: [direction({ id: RUST, name: "Rust", broken: true, lastOpenedAt: 3 })],
    });
    const resume = screen.getByRole("region", { name: "继续" });

    await expect
      .element(resume)
      .toHaveTextContent("继续Rust档案读不出来.atrium-study.json 不是能读的格式，文件没有被改动打开 Rust");
    await resume.getByRole("button", { name: "打开 Rust" }).click();

    await expect.element(screen.getByTestId("direction-home")).toBeVisible();
    expect(calls.filter((call) => call.startsWith("selectContainer"))).toStrictEqual([`selectContainer ${RUST}`]);
  });

  it("draws no continue card when no direction was ever opened", async () => {
    const { screen } = await learningHome({ directions: [rust({}, { lastOpenedAt: null })] });

    await expect.element(screen.getByRole("region", { name: "全部方向" })).toBeVisible();
    await expect.element(screen.getByRole("region", { name: "继续" })).not.toBeInTheDocument();
  });
});

describe("the direction cards and the archived list (SPEC-0008, ML4, prototypes 2A 3A)", () => {
  it("marks a direction with a session waiting for you or running, and draws the current level's dots", async () => {
    const { screen } = await learningHome({
      directions: [
        rust(),
        direction({ id: "lrn_go", name: "Go" }),
        direction({ id: "lrn_sql", name: "SQL", broken: true }),
      ],
      sessions: [
        session({ sessionId: "a", containerId: RUST, running: true }),
        session({ sessionId: "b", containerId: "lrn_go", running: true }),
        session({ sessionId: "c", containerId: "lrn_go", asking: 1 }),
      ],
    });
    const cards = screen.getByRole("region", { name: "全部方向" });

    await expect.element(cards.getByRole("group", { name: "Rust" }).getByRole("img", { name: "在跑" })).toBeVisible();
    await expect.element(cards.getByRole("group", { name: "Rust" })).toHaveTextContent("Rust共 2 级 · 第 2 级第 2 步");
    await expect
      .element(cards.getByRole("group", { name: "Rust" }).getByRole("img", { name: "共 6 步" }))
      .toBeVisible();
    await expect.element(cards.getByRole("group", { name: "Go" })).toHaveTextContent("Go待回答讨论中还没排出阶梯");
    await expect.element(cards.getByRole("group", { name: "Go" }).getByLabelText("在跑")).not.toBeInTheDocument();
    await expect.element(cards.getByRole("group", { name: "SQL" })).toHaveTextContent("SQL档案读不出来");
  });

  it("lists the archived directions with where they stopped, offering 恢复 on the row", async () => {
    const { screen, calls } = await learningHome({
      directions: [
        rust(),
        direction({ id: "lrn_go", name: "Go", archived: true, lastOpenedAt: 9 }),
        direction({
          id: "lrn_hs",
          name: "Haskell",
          archived: true,
          discussing: false,
          progress: PROGRESS,
          lastOpenedAt: 12,
        }),
      ],
    });

    await screen.getByRole("button", { name: "已归档的方向" }).click();
    const list = screen.getByRole("list", { name: "已归档的方向" });
    await expect.element(list).toHaveTextContent("Haskell停在第 2 级第 2 步恢复Go讨论中恢复");
    await list.getByRole("button", { name: "恢复 Go" }).click();

    await expect
      .poll(() => calls.filter((call) => call.startsWith("restoreDirection")))
      .toStrictEqual(["restoreDirection lrn_go"]);
  });
});

/**
 * Goes into the Rust direction and opens its `resources.md` from the archive, in a viewer tab.
 *
 * @remarks
 * The window is then in the direction with a viewer tab showing.
 *
 * @sideEffects Clicks through the page.
 * @param screen - The rendered workbench.
 */
async function openResources(screen: Awaited<ReturnType<typeof learningHome>>["screen"]): Promise<void> {
  await screen.getByRole("region", { name: "全部方向" }).getByRole("group", { name: "Rust" }).click();
  await screen.getByRole("region", { name: "档案" }).getByRole("button", { name: "resources.md" }).dblClick();
  await expect.element(screen.getByRole("region", { name: "resources.md" })).toBeVisible();
}

/**
 * The fake host's listing of the Rust direction: its root, `visuals/` and `notes/`.
 *
 * @remarks
 * As the host lists them: no dot file at the root.
 *
 * @sideEffects none
 * @param id - The direction or workspace.
 * @param path - The folder.
 * @returns Its entries.
 */
async function listing(id: string, path: string): Promise<{ entries: DirEntry[]; truncated: boolean }> {
  const folders: Record<string, DirEntry[]> = {
    "": [
      { name: "AGENTS.md", kind: "file" },
      { name: "lab", kind: "dir" },
      { name: "notes", kind: "dir" },
      { name: "resources.md", kind: "file" },
      { name: "visuals", kind: "dir" },
    ],
    visuals: [
      { name: "2-01-borrow.html", kind: "file" },
      { name: "stack.html", kind: "file" },
      { name: "1-01-vars.html", kind: "file" },
    ],
    notes: [{ name: "2-01.md", kind: "file" }],
  };
  return { entries: id === RUST ? (folders[path] ?? []) : [], truncated: false };
}

/**
 * The fake host's listing of the Rust direction with its `visuals/` failing or cut at the limit.
 *
 * @remarks
 * The rest lists as `listing` does.
 *
 * @sideEffects none
 * @param demos - How `visuals/` answers.
 * @returns The listing.
 */
function listingWithDemos(demos: "failed" | "cut") {
  return async (id: string, path: string): Promise<{ entries: DirEntry[]; truncated: boolean }> => {
    const listed = await listing(id, path);
    if (path !== "visuals") return listed;
    if (demos === "failed") throw new CommandError("read_failed");
    return { ...listed, truncated: true };
  };
}

/**
 * The fake host's reading that fails its first time, as during an archive's move, then reads.
 *
 * @remarks
 * Every file then reads as a short Markdown text.
 *
 * @sideEffects none
 * @returns The reading.
 */
function failingOnce() {
  let reads = 0;
  return async () => {
    reads += 1;
    if (reads === 1) throw new CommandError("read_failed");
    return { size: 5, content: { kind: "text" as const, text: "# 资料" } };
  };
}

/**
 * The fake host's reading of the Rust direction's note as `note`, and of any other file.
 *
 * @remarks
 * Any other file reads as a small page.
 *
 * @sideEffects none
 * @param note - What `notes/2-01.md` says.
 * @returns The reading.
 */
function noteSaying(note: string) {
  return async (_id: string, path: string) =>
    path === "notes/2-01.md"
      ? { size: 40, content: { kind: "text" as const, text: note } }
      : { size: 3, content: { kind: "text" as const, text: "<p>x</p>" } };
}

/**
 * The fake host's reading of the Rust direction's note, which links up to a demo and out of the
 * direction, and of any other file.
 *
 * @remarks
 * The note is in `notes/`, so its demo is `../visuals/…` (SPEC-0008, ML4).
 *
 * @sideEffects none
 * @param _id - The direction.
 * @param path - The file.
 * @returns What it holds.
 */
async function noteOrDemo(_id: string, path: string) {
  const note = "课上的演示：[借用](../visuals/2-01-borrow.html)，[外面](../../go/a.md)";
  return path === "notes/2-01.md"
    ? { size: 40, content: { kind: "text" as const, text: note } }
    : { size: 3, content: { kind: "text" as const, text: "<p>x</p>" } };
}

describe("a direction's archive and viewer tab (SPEC-0008, ML4, prototypes 4A 5A 6A)", () => {
  it("lists the demos by level with their lessons and the files in order, and opens a demo rendered with no way back", async () => {
    const { screen, calls } = await learningHome(
      { directions: [rust()] },
      {
        listDir: listing,
        resolveVisual: async () => ({ url: `atrium-visual://${"a".repeat(32)}/2-01-borrow.html`, size: 3, mtime: 1 }),
        readFile: async () => ({ size: 3, content: { kind: "text", text: "<p>x</p>" } }),
      },
    );
    await screen.getByRole("region", { name: "全部方向" }).getByRole("group", { name: "Rust" }).click();
    const archive = screen.getByRole("region", { name: "档案" });

    await expect
      .element(archive)
      .toHaveTextContent(
        "档案演示3 个第 2 级第 1 步 · 借用规则2-01-borrow.html第 1 级第 1 步 · 变量1-01-vars.html没对上课的stack.html文件resources.mdnotes/lab/AGENTS.md",
      );
    await archive.getByRole("button", { name: /2-01-borrow\.html/ }).click();

    const viewer = screen.getByRole("region", { name: "visuals/2-01-borrow.html" });
    await expect.element(viewer.getByText("在这里点的不会发到对话")).toBeVisible();
    await expect.element(viewer.getByRole("button", { name: "查看源码" })).toHaveAttribute("aria-pressed", "true");
    await expect.element(viewer.getByRole("button", { name: "在浏览器打开" })).not.toBeInTheDocument();
    // The sandbox's own scheme does not load in a test page: the card is there, without its title row.
    await expect.element(viewer.getByTestId("visual-card")).toBeVisible();
    await expect.element(viewer.getByTestId("visual-path")).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("step-strip")).toBeVisible();
    const tabs = screen.getByRole("tablist", { name: "打开的会话" });
    await expect
      .element(tabs.getByRole("tab", { name: "Rust", exact: true }))
      .toHaveAttribute("aria-selected", "false");
    expect(calls).toContain(`resolveVisual ${RUST} visuals/2-01-borrow.html`);

    await viewer.getByRole("button", { name: "查看源码" }).click();
    await expect.element(viewer.getByRole("button", { name: "预览" })).toHaveAttribute("aria-pressed", "false");
    await expect.element(viewer.getByTestId("viewer-body").getByText("<p>x</p>")).toBeVisible();
    await expect.element(viewer.getByText("在这里点的不会发到对话")).toBeVisible();

    await userEvent.keyboard("{Meta>}w{/Meta}");
    await expect.element(screen.getByRole("region", { name: "visuals/2-01-borrow.html" })).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("direction-home")).toBeVisible();
  });

  it("says the demos could not be listed, which is not having none", async () => {
    const { screen } = await learningHome(
      { directions: [rust()] },
      {
        listDir: listingWithDemos("failed"),
      },
    );
    await screen.getByRole("region", { name: "全部方向" }).getByRole("group", { name: "Rust" }).click();

    await expect
      .element(screen.getByRole("region", { name: "档案" }))
      .toHaveTextContent("档案演示读不了演示目录文件resources.mdnotes/lab/AGENTS.md");
  });

  it("says when the demos were cut at the listing's limit", async () => {
    const { screen } = await learningHome(
      { directions: [rust()] },
      {
        listDir: listingWithDemos("cut"),
      },
    );
    await screen.getByRole("region", { name: "全部方向" }).getByRole("group", { name: "Rust" }).click();

    await expect
      .element(screen.getByRole("region", { name: "档案" }))
      .toHaveTextContent(
        "档案演示3 个第 2 级第 1 步 · 借用规则2-01-borrow.html第 1 级第 1 步 · 变量1-01-vars.html没对上课的stack.html还有更多，没有列出文件resources.mdnotes/lab/AGENTS.md",
      );
  });

  it("opens a note in preview, and its link up to a demo in the viewer tab, never sending ..", async () => {
    const { screen, calls } = await learningHome(
      { directions: [rust()] },
      {
        listDir: listing,
        resolveVisual: async () => ({ url: `atrium-visual://${"a".repeat(32)}/2-01-borrow.html`, size: 3, mtime: 1 }),
        readFile: noteOrDemo,
      },
    );
    await screen.getByRole("region", { name: "全部方向" }).getByRole("group", { name: "Rust" }).click();
    const archive = screen.getByRole("region", { name: "档案" });
    await archive.getByRole("button", { name: "notes/" }).click();
    await archive.getByRole("button", { name: "2-01.md" }).click();

    const note = screen.getByTestId("markdown-preview");
    await expect.element(note).toHaveTextContent("课上的演示：借用，外面");
    await expect.element(note.getByRole("button", { name: "外面" })).not.toBeInTheDocument();
    await note.getByRole("button", { name: "借用" }).click();

    await expect.element(screen.getByRole("region", { name: "visuals/2-01-borrow.html" })).toBeVisible();
    expect(calls.filter((call) => call.includes(".."))).toStrictEqual([]);
  });

  it("reads a file again once the direction is where the list says now, after a read failed while it moved", async () => {
    const { screen, index } = await learningHome(
      { directions: [rust()] },
      { listDir: listing, readFile: failingOnce() },
    );
    await screen.getByRole("region", { name: "全部方向" }).getByRole("group", { name: "Rust" }).click();
    await screen.getByRole("region", { name: "档案" }).getByRole("button", { name: "resources.md" }).dblClick();
    const viewer = screen.getByRole("region", { name: "resources.md" });
    await expect.element(viewer.getByText("读不了这个文件")).toBeVisible();

    index.setState({ directions: [rust({}, { dir: "/home/Atrium/Learning/Archive/rust", archived: true })] });

    await expect.element(viewer.getByText("读不了这个文件")).not.toBeInTheDocument();
    await expect.element(viewer.getByTestId("markdown-preview")).toHaveTextContent("资料");
  });

  it("renders a demo a note names in another case, and never gives it to the browser, as it does lab/'s page", async () => {
    const note = "[借用](../Visuals/2-01-borrow.HTML)，[起始](../lab/index.html)";
    const { screen, browsed } = await learningHome(
      { directions: [rust()] },
      {
        listDir: listing,
        resolveVisual: async () => ({ url: `atrium-visual://${"a".repeat(32)}/2-01-borrow.HTML`, size: 3, mtime: 1 }),
        readFile: noteSaying(note),
      },
    );
    await screen.getByRole("region", { name: "全部方向" }).getByRole("group", { name: "Rust" }).click();
    const archive = screen.getByRole("region", { name: "档案" });
    await archive.getByRole("button", { name: "notes/" }).click();
    await archive.getByRole("button", { name: "2-01.md" }).click();
    await screen.getByTestId("markdown-preview").getByRole("button", { name: "借用" }).click();

    const demo = screen.getByRole("region", { name: "Visuals/2-01-borrow.HTML" });
    await expect.element(demo.getByTestId("visual-card")).toBeVisible();
    await expect.element(demo.getByText("在这里点的不会发到对话")).toBeVisible();
    await demo.getByRole("button", { name: "查看源码" }).click();
    await expect.element(demo.getByTestId("viewer-body").getByText("<p>x</p>")).toBeVisible();
    await expect.element(demo.getByRole("button", { name: "在浏览器打开" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Meta>}o{/Meta}");
    expect(browsed).toStrictEqual([]);

    await screen.getByRole("tab", { name: /2-01\.md/u }).click();
    await screen.getByTestId("markdown-preview").getByRole("button", { name: "起始" }).click();
    const lab = screen.getByRole("region", { name: "lab/index.html" });
    await lab.getByRole("button", { name: "在浏览器打开" }).click();
    expect(browsed).toStrictEqual(["/home/Atrium/Learning/rust/lab/index.html"]);
  });
});

describe("a direction session's links into its viewer tab (SPEC-0008, ML4)", () => {
  it("offers 在查看标签里打开 on a demo card of a direction's session, and opens its reply's file links there", async () => {
    await page.viewport(1280, 900);
    onTestFinished(() => localStorage.clear());
    const fake = fakeClient(
      {
        directions: [rust({}, { dir: "/home/Atrium/Learning/Archive/rust", archived: true })],
        sessions: [
          session({ sessionId: "lesson", containerId: RUST, study: { kind: "lesson", level: "l2", step: "s2" } }),
        ],
        layout: { container: RUST, tabs: { [RUST]: { open: ["lesson"], active: "lesson" } } },
      },
      {
        resolveVisual: async () => ({ url: `atrium-visual://${"a".repeat(32)}/2-01-borrow.html`, size: 3, mtime: 1 }),
        readFile: noteOrDemo,
      },
    );
    const screen = await render(
      <Workbench
        client={fake.client}
        status={<span>已连接宿主</span>}
        pickDirectory={async () => null}
        setNativeAppearance={undefined}
        openUrl={() => undefined}
        reveal={undefined}
        pathForFile={undefined}
      />,
    );
    await expect.poll(() => fake.views.has("lesson")).toBe(true);
    // A reply written before the direction was archived names the old place of its demo.
    const text =
      '看演示：\n\n```visual\n{"path":"/home/Atrium/Learning/rust/visuals/2-01-borrow.html"}\n```\n\n笔记在 [notes/2-01.md](notes/2-01.md)。';
    fake.views.get("lesson")?.setState({
      items: [
        {
          kind: "turn",
          id: "t1",
          source: null,
          user: { text: "讲吧", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
          steps: [{ kind: "text", id: "0", text }],
          outcome: "done",
          error: null,
          startedAt: 0,
          durationMs: 1000,
          usage: null,
          changes: [],
        },
      ],
    });

    await screen.getByRole("button", { name: "在查看标签里打开" }).click();
    await expect.element(screen.getByRole("region", { name: "visuals/2-01-borrow.html" })).toBeVisible();
    await screen
      .getByRole("tablist", { name: "打开的会话" })
      .getByRole("tab", { name: /讲吧|上课/u })
      .click();
    await screen.getByRole("button", { name: "notes/2-01.md" }).click();

    await expect.element(screen.getByRole("region", { name: "notes/2-01.md" })).toBeVisible();
    expect(fake.calls).toContain(`readFile ${RUST} notes/2-01.md`);
  });
});
