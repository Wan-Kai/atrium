import type { StudyNext, StudyProgress, Turn } from "@atrium/protocol";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { Workbench } from "../app/workbench";
import { direction, fakeClient, session } from "../test/fake-client";

const GO = "lrn_go";

/** Three levels; the second current, its first lesson done with a gap, its second taught by hand. */
const PROGRESS: StudyProgress = {
  profile: { goal: "写爬虫", language: "Go", weeklyHours: "4" },
  ladder: [
    { id: "l1", name: "语法", topics: "类型、函数", pass: "一个小工具", state: "skipped" },
    { id: "l2", name: "并发", topics: "goroutine、channel", pass: "一个爬虫", state: "current" },
    { id: "l3", name: "上线", topics: "部署", pass: "VPS", state: "todo" },
  ],
  steps: {
    l2: [
      {
        id: "s1",
        kind: "lesson",
        title: "goroutine",
        lesson: { by: "agent" },
        quiz: { by: "agent", score: 3, of: 5 },
        done: { by: "manual" },
      },
      { id: "s2", kind: "lesson", title: "channel", lesson: { by: "manual" }, quiz: null, done: null },
      { id: "s3", kind: "lesson", title: "select", lesson: null, quiz: null, done: null },
      { id: "s4", kind: "sheet", done: null },
      { id: "s5", kind: "project", done: null },
      { id: "s6", kind: "exam", done: null },
      { id: "s7", kind: "up", done: null },
    ],
  },
  gaps: [
    { id: "g1", text: "关闭的 channel 还能读吗", from: { level: "l2", step: "s1", question: 3 }, fixed: null },
    { id: "g2", text: "nil channel 会怎样", from: { level: "l2", step: "s1" }, fixed: { by: "manual" } },
  ],
  finishedAt: null,
};

/** The same, the first lesson's quiz put off ("以后再测", prototype 4A). */
const LATER: StudyProgress = {
  ...PROGRESS,
  steps: {
    l2: [
      {
        id: "s1",
        kind: "lesson",
        title: "goroutine",
        lesson: { by: "agent" },
        quiz: { by: "later" },
        done: { by: "manual" },
      },
      ...(PROGRESS.steps["l2"] ?? []).slice(1),
    ],
  },
};

/** Every level done and the direction finished: no level is current; the last one's four steps. */
const FINISHED: StudyProgress = {
  ...PROGRESS,
  ladder: [
    { id: "l1", name: "语法", topics: "", pass: "", state: "skipped" },
    { id: "l2", name: "并发", topics: "", pass: "", state: "done" },
    { id: "l3", name: "上线", topics: "", pass: "", state: "done" },
  ],
  steps: {
    l3: [
      { id: "s1", kind: "sheet", done: { by: "agent" } },
      { id: "s2", kind: "project", done: { by: "agent" } },
      { id: "s3", kind: "exam", done: { by: "agent", score: 9, of: 10 } },
      { id: "s4", kind: "up", done: null },
    ],
  },
  finishedAt: "2026-12-01T00:00:00.000Z",
};

/** What the host offers at the second lesson: the quiz, or putting it off. */
const QUIZ_NEXT: StudyNext = {
  primary: { type: "start", kind: "quiz", level: "l2", step: "s2", available: true },
  secondary: { type: "mark", mark: "later", level: "l2", step: "s2" },
};

/**
 * Renders the workbench over a fake client, in the direction's home.
 *
 * @remarks
 * A window `width` wide, the direction's container chosen with no session open.
 *
 * @sideEffects Renders; clears `localStorage` when the test ends.
 * @param fields - The direction's fields.
 * @param more - Sessions, the tabs, the window's width, and how the fake answers.
 * @returns The screen and the fake.
 */
async function home(
  fields: Partial<Parameters<typeof direction>[0]> = {},
  more: {
    readonly sessions?: ReturnType<typeof session>[];
    readonly open?: string;
    readonly width?: number;
    readonly answers?: Parameters<typeof fakeClient>[1];
  } = {},
) {
  await page.viewport(more.width ?? 1280, 820);
  onTestFinished(() => localStorage.clear());
  const fake = fakeClient(
    {
      directions: [
        direction({ id: GO, name: "Go", discussing: false, progress: PROGRESS, next: QUIZ_NEXT, ...fields }),
      ],
      sessions: more.sessions ?? [],
      layout: {
        container: GO,
        tabs: { [GO]: { open: more.open === undefined ? [] : [more.open], active: more.open ?? null } },
      },
    },
    more.answers,
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
  return { screen, ...fake };
}

/** How a long name looks when it is kept to one line: cut, with an ellipsis. */
const CUT = { oneLine: true, overflows: true, textOverflow: "ellipsis", overflow: "hidden" };

/**
 * How an element holds its text: within a line, overflowing, and how the overflow ends.
 *
 * @sideEffects none
 * @param element - The element.
 * @param lineHeight - The most a line may be high.
 * @returns Whether it is one line, whether its text overflows it, and its text overflow and overflow styles.
 */
function cut(element: Element, lineHeight: number) {
  const style = getComputedStyle(element);
  return {
    oneLine: element.getBoundingClientRect().height <= lineHeight,
    overflows: element.scrollWidth > element.clientWidth,
    textOverflow: style.textOverflow,
    overflow: style.overflow,
  };
}

describe("the step strip (SPEC-0008, ML2; prototype 2D)", () => {
  it("shows the level, a dot a step, the current step and the host's buttons under the tab bar", async () => {
    const { screen, calls } = await home();
    const strip = screen.getByTestId("step-strip");

    await expect.element(strip).toHaveAttribute("data-state", "learning");
    await expect.element(strip).toHaveTextContent("第 2 级 · 并发第 2 步 · channel · 上课完成以后再测开始测验");
    expect(
      [...strip.element().querySelectorAll("i[data-state]")].map((dot) => dot.getAttribute("data-state")),
    ).toStrictEqual(["done", "current", "todo", "todo", "todo", "todo", "todo"]);
    const quiz = strip.getByRole("button", { name: "开始测验" });
    await expect.element(quiz).toBeEnabled();
    expect(quiz.element().getAttribute("title")).toBeNull();
    await strip.getByRole("button", { name: "以后再测" }).click();

    expect(calls).toContain(`markStudyStep ${GO} l2 s2 later true`);
  });

  it("starts the session a lesson needs, and shows its session's tab over the home", async () => {
    const { screen, calls } = await home({
      next: { primary: { type: "start", kind: "lesson", level: "l2", step: "s3", available: true }, secondary: null },
    });

    await screen.getByTestId("step-strip").getByRole("button", { name: "开始上课" }).click();

    await expect.poll(() => calls).toContain(`startStudySession ${GO} {"kind":"lesson","level":"l2","step":"s3"}`);
  });

  it("goes back to the session open for the step, with a dot while it runs, and is there in the session too", async () => {
    const lesson = session({
      sessionId: "lesson",
      containerId: GO,
      name: null,
      prompt: null,
      running: true,
      study: { kind: "lesson", level: "l2", step: "s3" },
    });
    const { screen, calls } = await home(
      { next: { primary: { type: "open", sessionId: "lesson" }, secondary: null } },
      { sessions: [lesson], open: "lesson" },
    );
    const strip = screen.getByTestId("step-strip");

    await expect.element(strip.getByLabelText("在跑")).toBeVisible();
    await expect.element(screen.getByTestId("direction-home")).not.toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "打开的会话" });
    await expect.element(tabs.getByRole("tab", { name: /上课 · select/ })).toBeVisible();
    await strip.getByRole("button", { name: "回到会话" }).click();

    expect(calls).toContain("openSession lesson");
  });

  it("says a direction is under discussion, and offers nothing while its file cannot be read", async () => {
    const discussing = await home({ discussing: true, progress: null, next: { primary: null, secondary: null } });

    await expect
      .element(discussing.screen.getByTestId("step-strip"))
      .toHaveTextContent("讨论中，排出阶梯以后这里显示当前一级的步骤");
    await discussing.screen.unmount();
    const broken = await home({
      broken: true,
      discussing: true,
      progress: null,
      next: { primary: null, secondary: null },
    });
    const strip = broken.screen.getByTestId("step-strip");

    await expect.element(strip).toHaveAttribute("data-state", "broken");
    await expect.element(strip).toHaveTextContent("档案读不出来");
    expect(strip.element().querySelectorAll("i")).toHaveLength(13);
    expect(strip.element().querySelectorAll("button")).toHaveLength(0);
  });

  it("shows an archived direction where it stopped, and a finished one all lit, without buttons", async () => {
    // Buttons the host would never offer here are not drawn either.
    const archived = await home({ archived: true });
    const strip = archived.screen.getByTestId("step-strip");

    await expect.element(strip).toHaveTextContent("已归档停在第 2 步");
    expect(strip.element().querySelectorAll("button")).toHaveLength(0);
    await archived.screen.unmount();
    // Finished: every level done, so none is current; the last level's dots, all lit.
    const finished = await home({
      progress: FINISHED,
      next: { primary: null, secondary: null },
    });
    const done = finished.screen.getByTestId("step-strip");

    await expect.element(done).toHaveTextContent("已学完共 3 级");
    const dots = [...done.element().querySelectorAll("i")];
    expect(dots).toHaveLength(4);
    expect(dots.filter((dot) => dot.className.includes("--tint"))).toHaveLength(4);
  });

  it("shows a file of a later version like the dots of where it is, without buttons", async () => {
    const { screen } = await home({ newer: true, next: { primary: null, secondary: null } });
    const strip = screen.getByTestId("step-strip");

    await expect.element(strip).toHaveAttribute("data-state", "newer");
    await expect.element(strip).toHaveTextContent("档案是更新版本的 Atrium 写的，只能看停在第 2 步");
    expect(strip.element().querySelectorAll("i[data-state]")).toHaveLength(7);
    expect(strip.element().querySelectorAll("button")).toHaveLength(0);
  });

  it("presses a start once: the button waits while the host opens the session", async () => {
    const opening = Promise.withResolvers<void>();
    const { screen, calls } = await home(
      {
        next: { primary: { type: "start", kind: "lesson", level: "l2", step: "s3", available: true }, secondary: null },
      },
      { answers: { directionCommand: () => opening.promise } },
    );
    const start = screen.getByTestId("step-strip").getByRole("button", { name: "开始上课" });

    await start.click();
    await expect.element(start).toBeDisabled();
    opening.resolve();
    await expect.element(start).toBeEnabled();
    expect(calls.filter((call) => call.startsWith("startStudySession"))).toHaveLength(1);
  });
});

describe("a direction's home with its progress (ML2; prototypes 1A, 3A, 4A, 5A)", () => {
  it("shows the current step's card and the level's steps, with a lesson's parts and its sessions", async () => {
    const quiz = session({
      sessionId: "quiz",
      containerId: GO,
      name: "测 goroutine",
      study: { kind: "quiz", level: "l2", step: "s1" },
    });
    const { screen, calls } = await home({}, { sessions: [quiz] });
    const card = screen.getByRole("region", { name: "当前步骤" });

    await expect.element(card).toHaveTextContent("第 2 步 · 上课channel上课›测验›补漏开始测验");
    await expect.element(card.getByRole("button", { name: "开始测验" })).toBeEnabled();
    const steps = screen.getByRole("region", { name: "步骤" }).getByTestId("study-step");
    await expect
      .poll(() => steps.elements().map((row) => row.getAttribute("data-state")))
      .toStrictEqual(["done", "current", "todo", "todo", "todo", "todo", "todo"]);
    await expect.element(steps.nth(0)).toHaveTextContent("1goroutine测验3/5");
    expect(
      [...steps.nth(0).element().querySelectorAll("i[data-part]")].map((part) => part.getAttribute("data-part")),
    ).toStrictEqual(["done", "done", "gap"]);
    // Taught by hand: hollow, and "你标的" where its session would be.
    await expect.element(steps.nth(1)).toHaveTextContent("2channel上课 · 你标的");
    expect(steps.nth(1).element().querySelector("i[data-part]")?.getAttribute("data-part")).toBe("manual");
    await expect.element(steps.nth(6)).toHaveTextContent("升到第 3 级");
    await steps
      .nth(0)
      .getByRole("button", { name: /测验/ })
      .click();

    expect(calls).toContain("openSession quiz");
  });

  it("marks a step's part done by hand from its menu, and takes a manual mark back", async () => {
    const { screen, calls } = await home();
    const steps = screen.getByRole("region", { name: "步骤" }).getByTestId("study-step");

    await steps.nth(1).getByRole("button", { name: "channel 的更多操作" }).click();
    await expect
      .poll(() =>
        screen
          .getByRole("menuitem")
          .elements()
          .map((item) => item.textContent),
      )
      .toStrictEqual(["标测验完成连上课", "整步标为完成", "撤回“上课完成”"]);
    // Prototype 1A: a line between a part's mark and the whole step's.
    const menu = screen.getByRole("menu");
    expect(
      [...menu.element().querySelectorAll('[role="menuitem"], [role="separator"]')].map(
        (item) => `${String(item.getAttribute("role"))} ${item.textContent}`,
      ),
    ).toStrictEqual(["menuitem 标测验完成连上课", "separator ", "menuitem 整步标为完成", "menuitem 撤回“上课完成”"]);
    await expect.element(screen.getByText("agent 报告的不能撤回；之后 agent 报告这一步，以它的为准。")).toBeVisible();
    await screen.getByRole("menuitem", { name: /标测验完成/ }).click();
    await steps.nth(1).getByRole("button", { name: "channel 的更多操作" }).click();
    await screen.getByRole("menuitem", { name: "撤回“上课完成”" }).click();
    await steps.nth(3).getByRole("button", { name: "速查表 的更多操作" }).click();
    await expect
      .poll(() =>
        screen
          .getByRole("menuitem")
          .elements()
          .map((item) => item.textContent),
      )
      .toStrictEqual(["标为完成"]);
    await screen.getByRole("menuitem", { name: "标为完成" }).click();

    expect(calls.filter((call) => call.startsWith("markStudyStep"))).toStrictEqual([
      `markStudyStep ${GO} l2 s2 quiz true`,
      `markStudyStep ${GO} l2 s2 lesson false`,
      `markStudyStep ${GO} l2 s4 step true`,
    ]);
  });

  it("offers no mark for the upgrade, which only upgrading does", async () => {
    const { screen } = await home();
    const up = screen.getByRole("region", { name: "步骤" }).getByTestId("study-step").nth(6);

    await expect.element(up).toHaveTextContent("升到第 3 级");
    expect(up.element().querySelectorAll("button")).toHaveLength(0);
  });

  it("offers no marks on an archived direction, one whose file cannot be written, or one of a later version", async () => {
    for (const fields of [{ archived: true }, { newer: true }] as const) {
      const { screen } = await home({ ...fields, next: { primary: null, secondary: null } });
      const steps = screen.getByRole("region", { name: "步骤" });
      const gaps = screen.getByRole("region", { name: "漏洞" });

      await expect.element(steps.getByTestId("study-step").nth(1)).toHaveTextContent("2channel上课 · 你标的");
      expect(steps.element().querySelectorAll('button[aria-haspopup="menu"]')).toHaveLength(0);
      await expect
        .element(gaps.getByTestId("study-gap").nth(1))
        .toHaveTextContent("nil channel 会怎样goroutine · 你标的已补");
      expect(gaps.element().querySelectorAll("button")).toHaveLength(0);
      await screen.unmount();
    }
  });

  it("says a quiz put off is not taken, and offers 补测 on hover, a quiz of that step (ML3)", async () => {
    const { screen, calls } = await home({ progress: LATER });
    const first = screen.getByRole("region", { name: "步骤" }).getByTestId("study-step").nth(0);

    await expect.element(first.getByText("没测")).toBeVisible();
    expect(first.element().querySelectorAll("i[data-part]")[1]?.getAttribute("data-part")).toBe("later");
    await first.hover();
    const retake = first.getByRole("button", { name: "补测" });
    await expect.element(retake).toBeVisible();
    await retake.click();

    await expect.poll(() => calls).toContain(`startStudySession ${GO} {"kind":"quiz","level":"l2","step":"s1"}`);
  });

  it("marks a gap fixed by hand from its hover button, and takes it back", async () => {
    const { screen, calls } = await home();
    const gaps = screen.getByRole("region", { name: "漏洞" }).getByTestId("study-gap");

    await expect.element(gaps.nth(0)).toHaveTextContent("关闭的 channel 还能读吗goroutine · 测验第 3 题");
    await expect.element(gaps.nth(1)).toHaveTextContent("nil channel 会怎样goroutine · 你标的已补 · 撤回");
    await gaps.nth(0).hover();
    await gaps.nth(0).getByRole("button", { name: "标为已补" }).click();
    await gaps.nth(1).getByRole("button", { name: "撤回" }).click();

    expect(calls.filter((call) => call.startsWith("markStudyGap"))).toStrictEqual([
      `markStudyGap ${GO} g1 true`,
      `markStudyGap ${GO} g2 false`,
    ]);
  });

  it("opens a ladder level in place to say what it covers, how it is passed and where it stands", async () => {
    const { screen } = await home();
    const ladder = screen.getByRole("region", { name: "阶梯" });
    const level = ladder.getByRole("button", { name: /第 2 级 · 并发/ });

    await expect.element(ladder).toHaveTextContent("阶梯 · 3 级第 1 级 · 语法跳过第 2 级 · 并发当前第 3 级 · 上线");
    await level.click();

    await expect.element(level).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() => JSON.stringify(ladder.element().textContent))
      .toContain("当前学什么goroutine、channel怎样算过关一个爬虫状态第 2 / 7 步第 3 级");
    await ladder.getByRole("button", { name: /第 1 级 · 语法/ }).click();
    await expect.poll(() => ladder.element().textContent).toContain("状态摸底时跳过");
    await expect.element(level).toHaveAttribute("aria-expanded", "false");
  });

  it("is two columns in a wide window and one in a narrow one, the ladder before the steps", async () => {
    const wide = await home();
    const ladderWide = wide.screen.getByRole("region", { name: "阶梯" }).element().getBoundingClientRect();
    const stepsWide = wide.screen.getByRole("region", { name: "步骤" }).element().getBoundingClientRect();

    expect(ladderWide.left).toBeGreaterThan(stepsWide.right);
    expect(Math.round(ladderWide.width)).toBe(240);
    // The current step's card in the left column, beside the ladder, above the steps.
    const cardWide = wide.screen.getByRole("region", { name: "当前步骤" }).element().getBoundingClientRect();
    expect(cardWide.right).toBeLessThan(ladderWide.left);
    expect(Math.round(cardWide.top)).toBe(Math.round(ladderWide.top));
    expect(Math.round(cardWide.left)).toBe(Math.round(stepsWide.left));
    expect(cardWide.bottom).toBeLessThanOrEqual(stepsWide.top);
    await wide.screen.unmount();
    const narrow = await home({}, { width: 760 });
    const ladder = narrow.screen.getByRole("region", { name: "阶梯" }).element().getBoundingClientRect();
    const steps = narrow.screen.getByRole("region", { name: "步骤" }).element().getBoundingClientRect();
    const gaps = narrow.screen.getByRole("region", { name: "漏洞" }).element().getBoundingClientRect();
    const card = narrow.screen.getByRole("region", { name: "当前步骤" }).element().getBoundingClientRect();

    expect(card.bottom).toBeLessThanOrEqual(ladder.top);
    expect(Math.round(ladder.left)).toBe(Math.round(steps.left));
    expect(ladder.bottom).toBeLessThanOrEqual(steps.top);
    expect(steps.bottom).toBeLessThanOrEqual(gaps.top);
  });

  it("keeps a long level name on one line, cut with an ellipsis, the whole name on hover (2026-11-09)", async () => {
    const long = "所有权、借用与生命周期：从 move 语义到在真实项目里不再和借用检查器打架";
    const { screen } = await home({
      progress: {
        ...PROGRESS,
        ladder: [
          { id: "l1", name: "语法", topics: "类型、函数", pass: "一个小工具", state: "skipped" },
          { id: "l2", name: long, topics: "goroutine、channel", pass: "一个爬虫", state: "current" },
          { id: "l3", name: "上线", topics: "部署", pass: "VPS", state: "todo" },
        ],
      },
    });
    const whole = `第 2 级 · ${long}`;
    const tag = screen.getByTestId("level-tag");
    await expect.element(tag).toHaveAttribute("title", whole);
    expect(cut(tag.element(), 22)).toStrictEqual(CUT);
    // The profile beside it stays on the same line.
    expect(screen.getByTestId("profile-line").element().getBoundingClientRect().height).toBeLessThanOrEqual(22);

    const rung = screen.getByRole("region", { name: "阶梯" }).getByTitle(whole);
    expect(cut(rung.element(), 30)).toStrictEqual(CUT);
    // All the row but the dot and the arrow: no room kept for an empty 跳过 / 当前.
    expect(rung.element().getBoundingClientRect().width).toBeGreaterThan(130);

    const label = screen.getByTestId("step-strip").getByTitle(whole);
    expect(cut(label.element(), 22)).toStrictEqual(CUT);
  });

  it("lists the sessions of no step as other sessions, asking ones by their title", async () => {
    const { screen } = await home(
      {},
      {
        sessions: [
          session({ sessionId: "talk", containerId: GO, name: "定档", study: { kind: "discuss" }, updatedAt: 1 }),
          session({ sessionId: "ask", containerId: GO, name: "ORM 要不要用", study: { kind: "ask" }, updatedAt: 2 }),
        ],
      },
    );

    const rows = screen.getByRole("list", { name: "其他会话" }).getByRole("button");
    await expect
      .poll(() => rows.elements().map((row) => row.querySelector(".truncate")?.textContent))
      .toStrictEqual(["ORM 要不要用", "定档"]);
  });
});

describe("a session the host opened for a use (ML2)", () => {
  it("says a session that did not start, by its code, and starts it again on 重试", async () => {
    const lesson = session({
      sessionId: "lesson",
      containerId: GO,
      name: null,
      prompt: null,
      study: { kind: "lesson", level: "l2", step: "s3" },
      kickoff: { code: "study_kickoff_failed" },
    });
    const { screen, calls } = await home({}, { sessions: [lesson], open: "lesson" });
    const line = screen.getByRole("alert").filter({ hasText: "没能开始" });

    await expect.element(line).toHaveTextContent("这一步的会话没能开始：pi 没有加载 Atrium 的学习扩展重试");
    await line.getByRole("button", { name: "重试" }).click();

    expect(calls).toContain("retryStudyKickoff lesson");
  });

  it("says nothing for a session that started", async () => {
    const lesson = session({
      sessionId: "lesson",
      containerId: GO,
      study: { kind: "lesson", level: "l2", step: "s3" },
    });
    const { screen } = await home({}, { sessions: [lesson], open: "lesson" });

    await expect.element(screen.getByTestId("step-strip")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试" }).elements()).toHaveLength(0);
  });

  it("starts with its use and step as the source line, not a message of yours", async () => {
    const turn: Turn = {
      kind: "turn",
      id: "t1",
      source: { kind: "study", study: { kind: "lesson", level: "l2", step: "s3" } },
      user: { text: "", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
      steps: [{ kind: "text", id: "0", text: "今天讲 select" }],
      outcome: "done",
      error: null,
      startedAt: 0,
      durationMs: 1000,
      usage: null,
      changes: [],
    };
    const lesson = session({
      sessionId: "lesson",
      containerId: GO,
      name: null,
      prompt: null,
      study: { kind: "lesson", level: "l2", step: "s3" },
    });
    const { screen, views } = await home({}, { sessions: [lesson], open: "lesson" });
    await vi.waitFor(() => expect(views.has("lesson")).toBe(true));
    views.get("lesson")?.setState({ items: [turn] });

    const line = screen.getByTestId("source-line");
    await expect.element(line).toHaveAttribute("data-event", "study");
    await expect.element(line).toHaveTextContent("上课 · 第 2 级第 3 步 · select");
  });
});
