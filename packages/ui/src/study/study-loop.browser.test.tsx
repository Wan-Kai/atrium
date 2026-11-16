import { CommandError } from "@atrium/client";
import {
  IDLE_CONTROL,
  type SessionSummary,
  type Step,
  type StudyNext,
  type StudyProgress,
  type Turn,
} from "@atrium/protocol";
import { userEvent } from "vitest/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { Workbench } from "../app/workbench";
import { type FakeAnswers, direction, fakeClient, session } from "../test/fake-client";

// The study loop's screens (SPEC-0008, "ML3 定的细节"; prototype study-loop 1A 2A 3B 4A 5B 6A 7C).

const RUST = "lrn_rust";

/** Three levels: the first done, the second current with two lessons, the third to come. */
const PROGRESS: StudyProgress = {
  profile: { goal: "写 CLI" },
  ladder: [
    { id: "l1", name: "所有权", topics: "移动", pass: "小工具", state: "done" },
    { id: "l2", name: "借用", topics: "引用", pass: "解析器", state: "current" },
    { id: "l3", name: "trait 与泛型", topics: "trait", pass: "插件", state: "todo" },
  ],
  steps: {
    l1: [
      {
        id: "s1",
        kind: "lesson",
        title: "移动",
        lesson: { by: "agent" },
        quiz: { by: "agent", score: 42, of: 50 },
        done: { by: "manual" },
      },
      { id: "s2", kind: "up", done: { by: "manual" } },
    ],
    l2: [
      {
        id: "s1",
        kind: "lesson",
        title: "借用规则",
        lesson: { by: "agent" },
        quiz: { by: "agent", score: 32, of: 50 },
        done: null,
      },
      { id: "s2", kind: "lesson", title: "生命周期", lesson: null, quiz: null, done: null },
      { id: "s3", kind: "sheet", done: null },
      { id: "s4", kind: "project", done: null },
      { id: "s5", kind: "exam", done: null },
      { id: "s6", kind: "up", done: null },
    ],
  },
  gaps: [
    { id: "g1", text: "Rc 和 Arc 的区别", from: { level: "l2", step: "s1", question: 3 }, fixed: null },
    { id: "g2", text: "&mut 什么时候结束", from: { level: "l2", step: "s1" }, fixed: { by: "agent" } },
    { id: "g3", text: "移动后不能再用", from: { level: "l1", step: "s1", question: 2 }, fixed: null },
    { id: "g4", text: "loop 能带返回值", from: { level: "l1", step: "s1" }, fixed: { by: "agent" } },
  ],
  finishedAt: null,
};

/** Every step of the second level done but the upgrade; the exam left a gap. */
const AT_UPGRADE: StudyProgress = {
  ...PROGRESS,
  steps: {
    ...PROGRESS.steps,
    l2: (PROGRESS.steps["l2"] ?? []).map((step) => (step.kind === "up" ? step : { ...step, done: { by: "agent" } })),
  },
  gaps: [
    ...PROGRESS.gaps,
    { id: "g5", text: "生命周期省略", from: { level: "l2", step: "s5", question: 8 }, fixed: null },
  ],
};

/** The third level current, with no lessons yet: just upgraded. */
const UNPLANNED: StudyProgress = {
  ...PROGRESS,
  ladder: PROGRESS.ladder.map((level) =>
    level.id === "l3" ? { ...level, state: "current" } : { ...level, state: "done" },
  ),
};

/** The main button is the quiz of the second lesson's first step, or putting it off. */
const QUIZ: StudyNext = {
  primary: { type: "start", kind: "quiz", level: "l2", step: "s1", available: true },
  secondary: { type: "mark", mark: "later", level: "l2", step: "s1" },
};

/**
 * Renders the workbench over a fake client, in the direction's home.
 *
 * @remarks
 * Its container chosen, its home shown unless a session tab is open.
 *
 * @sideEffects Renders; clears `localStorage` when the test ends.
 * @param fields - The direction's fields.
 * @param more - Sessions, the tab open, the fake's answers, other directions and the sessions shown.
 * @returns The screen and the fake.
 */
async function home(
  fields: Partial<Parameters<typeof direction>[0]> = {},
  more: {
    readonly sessions?: SessionSummary[];
    readonly open?: string;
    /** How the fake answers. */
    readonly answers?: FakeAnswers;
    /** Directions besides this one. */
    readonly others?: ReturnType<typeof direction>[];
    /** Sessions this window shows, so their views are there from the start. */
    readonly watched?: readonly string[];
  } = {},
) {
  await page.viewport(1280, 820);
  onTestFinished(() => localStorage.clear());
  const fake = fakeClient(
    {
      directions: [
        direction({ id: RUST, name: "Rust", discussing: false, progress: PROGRESS, next: QUIZ, ...fields }),
        ...(more.others ?? []),
      ],
      sessions: more.sessions ?? [],
      layout: {
        container: RUST,
        tabs: { [RUST]: { open: more.open === undefined ? [] : [more.open], active: more.open ?? null } },
      },
    },
    more.answers,
  );
  if (more.watched !== undefined) await fake.client.watch(more.watched);
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

/**
 * A study session of the direction, with no title of its own.
 *
 * @remarks
 * As the host opens them: no name, no message of yours.
 *
 * @sideEffects none
 * @param sessionId - Its id.
 * @param fields - The rest.
 * @returns The session.
 */
function studied(sessionId: string, fields: Partial<SessionSummary>): SessionSummary {
  return session({ sessionId, containerId: RUST, name: null, prompt: null, ...fields });
}

/**
 * A finished turn.
 *
 * @remarks
 * Its source and steps as given.
 *
 * @sideEffects none
 * @param id - Its id.
 * @param source - What opened it; `null` for a message of yours.
 * @param steps - Its steps.
 * @param text - Your message.
 * @returns The turn.
 */
function turn(id: string, source: Turn["source"], steps: Step[], text = ""): Turn {
  return {
    kind: "turn",
    id,
    source,
    user: { text, images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
    steps,
    outcome: "done",
    error: null,
    startedAt: 0,
    durationMs: 1000,
    usage: null,
    changes: [],
  };
}

describe("the step strip's new states (prototype 2A)", () => {
  it("fades 开始测验 with 等上课这一轮结束 while the lesson's turn runs, and lights it once it ends", async () => {
    const lesson = studied("lesson", { running: true, study: { kind: "lesson", level: "l2", step: "s1" } });
    const { screen, calls, index } = await home({}, { sessions: [lesson] });
    const strip = screen.getByTestId("step-strip");
    const quiz = strip.getByRole("button", { name: "开始测验" });
    const card = screen.getByRole("region", { name: "当前步骤" }).getByRole("button", { name: "开始测验" });

    await expect.element(quiz).toBeDisabled();
    await expect.element(quiz).toHaveAttribute("title", "等上课这一轮结束");
    await expect.element(card).toBeDisabled();
    await expect.element(card).toHaveAttribute("title", "等上课这一轮结束");
    index.setState({ sessions: [{ ...lesson, running: false }] });
    await expect.element(quiz).toBeEnabled();
    expect(quiz.element().getAttribute("title")).toBeNull();
    await quiz.click();

    await expect.poll(() => calls).toContain(`startStudySession ${RUST} {"kind":"quiz","level":"l2","step":"s1"}`);
  });

  it("fades 开始测验 only for this direction's lesson, not one of another direction at the same ids", async () => {
    const elsewhere = session({
      sessionId: "other-lesson",
      containerId: "lrn_go",
      running: true,
      study: { kind: "lesson", level: "l2", step: "s1" },
    });
    const mine = studied("lesson", { study: { kind: "lesson", level: "l2", step: "s1" }, updatedAt: 1 });
    const { screen } = await home(
      {},
      {
        sessions: [mine, { ...elsewhere, updatedAt: 9 }],
        others: [direction({ id: "lrn_go", name: "Go", discussing: false, progress: PROGRESS, next: QUIZ })],
      },
    );

    await expect.element(screen.getByTestId("step-strip").getByRole("button", { name: "开始测验" })).toBeEnabled();
    await expect
      .element(screen.getByRole("region", { name: "当前步骤" }).getByRole("button", { name: "开始测验" }))
      .toBeEnabled();
  });

  it("fades 开始测验 while the lesson shown here stops, and words the host's session_busy the same (C)", async () => {
    const lesson = studied("lesson", { study: { kind: "lesson", level: "l2", step: "s1" } });
    const { screen, views } = await home(
      {},
      {
        sessions: [lesson],
        watched: ["lesson"],
        answers: { directionCommand: async () => Promise.reject(new CommandError("session_busy")) },
      },
    );
    const strip = screen.getByTestId("step-strip");
    const quiz = strip.getByRole("button", { name: "开始测验" });
    const card = screen.getByRole("region", { name: "当前步骤" }).getByRole("button", { name: "开始测验" });
    await expect.element(quiz).toBeEnabled();

    views.get("lesson")?.setState({ control: { ...IDLE_CONTROL, stopping: true } });
    await expect.element(quiz).toBeDisabled();
    await expect.element(quiz).toHaveAttribute("title", "等上课这一轮结束");
    await expect.element(card).toBeDisabled();
    views.get("lesson")?.setState({ control: IDLE_CONTROL });
    await expect.element(quiz).toBeEnabled();
    await quiz.click();

    await expect.element(strip.getByRole("alert")).toHaveTextContent("等上课这一轮结束");
  });

  it("names the upgrade by the next level not skipped, on the strip, the card and the steps", async () => {
    const skipping: StudyProgress = {
      ...AT_UPGRADE,
      ladder: [
        ...AT_UPGRADE.ladder.slice(0, 2),
        { ...AT_UPGRADE.ladder[2]!, state: "skipped" },
        { id: "l4", name: "异步", topics: "", pass: "", state: "todo" },
      ],
    };
    const { screen } = await home({
      progress: skipping,
      next: { primary: { type: "upgrade", level: "l2", available: true }, secondary: null },
    });

    await expect
      .element(screen.getByTestId("step-strip"))
      .toHaveTextContent("第 2 级 · 借用第 6 步 · 升到第 4 级 · 综合测验还有 1 个漏洞升级");
    await expect
      .element(screen.getByRole("region", { name: "当前步骤" }))
      .toHaveTextContent("第 6 步 · 升级升到第 4 级升级");
    await expect
      .poll(() => screen.getByRole("region", { name: "步骤" }).getByTestId("study-step").nth(5).element().textContent)
      .toBe("升到第 4 级");
  });

  it("offers Feynman on a gap after the quiz, with the score and how many gaps, or going on", async () => {
    const { screen, calls } = await home({
      next: {
        primary: { type: "start", kind: "feynman", level: "l2", step: "s1", gap: "g1", available: true },
        secondary: { type: "mark", mark: "step", level: "l2", step: "s1" },
      },
    });
    const strip = screen.getByTestId("step-strip");

    await expect
      .element(strip)
      .toHaveTextContent("第 2 级 · 借用第 1 步 · 借用规则 · 测验 32/50 · 1 个漏洞进入下一步跑费曼");
    await strip.getByRole("button", { name: "跑费曼" }).click();

    await expect
      .poll(() => calls)
      .toContain(`startStudySession ${RUST} {"kind":"feynman","level":"l2","step":"s1","gap":"g1"}`);
  });

  it("offers Feynman on the exam's gap before upgrading, and the upgrade as the other button", async () => {
    const { screen } = await home({
      progress: AT_UPGRADE,
      next: {
        primary: { type: "start", kind: "feynman", level: "l2", step: "s5", gap: "g5", available: true },
        secondary: { type: "upgrade", level: "l2", available: true },
      },
    });
    const strip = screen.getByTestId("step-strip");

    await expect
      .element(strip)
      .toHaveTextContent("第 2 级 · 借用第 6 步 · 升到第 3 级 · 综合测验还有 1 个漏洞升级跑费曼");
    await strip.getByRole("button", { name: "升级" }).click();

    await expect
      .element(screen.getByRole("alertdialog"))
      .toHaveTextContent(
        "升到第 3 级「trait 与泛型」第 2 级前面的 5 步都做完了。确定后开一个“排计划”会话，排第 3 级的课。还没补的 3 个漏洞带到第 3 级。先不升升级并排计划",
      );
  });

  it("shows a level with no lessons yet without dots, with 排计划, then 排计划中 with its session open", async () => {
    const plan = studied("plan", { running: true, study: { kind: "plan", level: "l3" } });
    const before = await home({
      progress: UNPLANNED,
      next: { primary: { type: "start", kind: "plan", level: "l3", available: true }, secondary: null },
    });
    const strip = before.screen.getByTestId("step-strip");

    await expect
      .element(strip)
      .toHaveTextContent("第 3 级 · trait 与泛型还没排课 · 排计划会话排出课以后，这里是这一级的步骤排计划");
    expect(strip.element().querySelectorAll("i[data-state]")).toHaveLength(0);
    await strip.getByRole("button", { name: "排计划" }).click();
    await expect.poll(() => before.calls).toContain(`startStudySession ${RUST} {"kind":"plan","level":"l3"}`);
    await before.screen.unmount();

    const after = await home(
      { progress: UNPLANNED, next: { primary: { type: "open", sessionId: "plan" }, secondary: null } },
      { sessions: [plan] },
    );
    const open = after.screen.getByTestId("step-strip");
    await expect.element(open).toHaveTextContent("第 3 级 · trait 与泛型排计划中回到会话");
    await expect.element(open.getByLabelText("在跑")).toBeVisible();
  });
});

describe("the upgrade's confirmation (prototype 4A)", () => {
  /** This level's sessions: the lesson running, its quiz child, Feynman; the discussion left out. */
  const sessions = [
    studied("lesson", { running: true, study: { kind: "lesson", level: "l2", step: "s1" } }),
    studied("quiz", { study: { kind: "quiz", level: "l2", step: "s1" }, parent: { sessionId: "lesson", by: "user" } }),
    studied("feynman", { study: { kind: "feynman", level: "l2", step: "s1", gap: "g1" } }),
    studied("talk", { running: true, study: { kind: "discuss" } }),
  ];
  const UPGRADE: StudyNext = { primary: { type: "upgrade", level: "l2", available: true }, secondary: null };

  it("says the level gone to, archives the level's sessions by default, the gaps carried and those it stops", async () => {
    const { screen, calls } = await home({ progress: AT_UPGRADE, next: UPGRADE }, { sessions });
    await screen.getByTestId("step-strip").getByRole("button", { name: "升级" }).click();
    const dialog = screen.getByRole("alertdialog");

    await expect
      .element(dialog)
      .toHaveTextContent(
        "升到第 3 级「trait 与泛型」第 2 级前面的 5 步都做完了。确定后开一个“排计划”会话，排第 3 级的课。把第 2 级的 3 个会话一起归档档案和笔记都留着，会话能在“已归档”里恢复。还没补的 3 个漏洞带到第 3 级。会停掉 1 个在跑的会话。先不升升级并排计划",
      );
    const box = dialog.getByRole("checkbox", { name: "把第 2 级的 3 个会话一起归档" });
    await expect.element(box).toBeChecked();
    await box.click({ force: true });
    await expect
      .poll(() => dialog.element().textContent)
      .toBe(
        "升到第 3 级「trait 与泛型」第 2 级前面的 5 步都做完了。确定后开一个“排计划”会话，排第 3 级的课。把第 2 级的 3 个会话一起归档档案和笔记都留着，会话能在“已归档”里恢复。还没补的 3 个漏洞带到第 3 级。先不升升级并排计划",
      );
    await dialog.getByRole("button", { name: "升级并排计划" }).click();

    await expect.poll(() => calls).toContain(`upgradeStudy ${RUST} l2 false`);
    await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("archives when left checked, and closes on 先不升 without upgrading", async () => {
    const { screen, calls } = await home({ progress: AT_UPGRADE, next: UPGRADE }, { sessions });
    const strip = screen.getByTestId("step-strip");
    await strip.getByRole("button", { name: "升级" }).click();
    await screen.getByRole("alertdialog").getByRole("button", { name: "先不升" }).click();
    await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls.filter((call) => call.startsWith("upgradeStudy"))).toStrictEqual([]);

    await screen.getByRole("region", { name: "当前步骤" }).getByRole("button", { name: "升级" }).click();
    await screen.getByRole("alertdialog").getByRole("button", { name: "升级并排计划" }).click();
    await expect.poll(() => calls).toContain(`upgradeStudy ${RUST} l2 true`);
  });

  it("finishes the last level: 学完 on the strip, the dialog without a plan or gaps carried", async () => {
    const last: StudyProgress = {
      ...AT_UPGRADE,
      ladder: [AT_UPGRADE.ladder[0]!, AT_UPGRADE.ladder[1]!, { ...AT_UPGRADE.ladder[2]!, state: "skipped" }],
    };
    const { screen, calls } = await home({ progress: last, next: UPGRADE }, { sessions: [] });
    const strip = screen.getByTestId("step-strip");

    await expect.element(strip).toHaveTextContent("第 2 级 · 借用第 6 步 · 学完 · 综合测验还有 1 个漏洞学完");
    await strip.getByRole("button", { name: "学完" }).click();
    const dialog = screen.getByRole("alertdialog");
    await expect
      .element(dialog)
      .toHaveTextContent(
        "学完最后一级第 2 级前面的 5 步都做完了。确定后这个方向标为“已学完”，还能随口问、复习。先不升学完",
      );
    expect(dialog.getByRole("checkbox").elements()).toHaveLength(0);
    await dialog.getByRole("button", { name: "学完" }).click();

    await expect.poll(() => calls).toContain(`upgradeStudy ${RUST} l2 false`);
  });
});

describe("the home after an upgrade, before lessons (prototype 6A)", () => {
  it("shows the plan's card and a placeholder for the steps, then 回到会话 with the plan open", async () => {
    const plan = studied("plan", { running: true, study: { kind: "plan", level: "l3" } });
    const before = await home({
      progress: UNPLANNED,
      next: { primary: { type: "start", kind: "plan", level: "l3", available: true }, secondary: null },
    });
    const card = before.screen.getByRole("region", { name: "当前步骤" });

    await expect
      .element(card)
      .toHaveTextContent(
        "第 3 级 · 排计划第 3 级还没排课排计划会话按阶梯和带来的 2 个漏洞排出这一级的课，问过你才写进去。开始排计划",
      );
    await expect
      .element(before.screen.getByTestId("steps-placeholder"))
      .toHaveTextContent("课排出来以后列在这里，后面接速查表、过关项目、综合测验、升级。");
    await card.getByRole("button", { name: "开始排计划" }).click();
    await expect.poll(() => before.calls).toContain(`startStudySession ${RUST} {"kind":"plan","level":"l3"}`);
    await before.screen.unmount();

    const after = await home(
      { progress: UNPLANNED, next: { primary: { type: "open", sessionId: "plan" }, secondary: null } },
      { sessions: [plan] },
    );
    const open = after.screen.getByRole("region", { name: "当前步骤" });
    await expect.element(open.getByLabelText("在跑")).toBeVisible();
    await open.getByRole("button", { name: "回到会话" }).click();
    await expect.poll(() => after.calls).toContain("openSession plan");
  });

  it("takes a level hand-edited down to steps without lessons as not planned, on the home and the strip", async () => {
    const edited: StudyProgress = {
      ...UNPLANNED,
      steps: { ...UNPLANNED.steps, l3: [{ id: "s1", kind: "sheet", done: null }] },
    };
    const { screen } = await home({
      progress: edited,
      next: { primary: { type: "start", kind: "plan", level: "l3", available: true }, secondary: null },
    });

    await expect.element(screen.getByTestId("steps-placeholder")).toBeVisible();
    await expect
      .poll(() => screen.getByRole("region", { name: "当前步骤" }).element().textContent)
      .toContain("第 3 级还没排课");
    await expect.poll(() => screen.getByTestId("step-strip").element().textContent).toContain("还没排课");
  });
});

describe("the gaps, this level's and carried (prototype 3B)", () => {
  it("groups this level's and those carried, folds earlier fixed ones, and runs Feynman from a row", async () => {
    const { screen, calls } = await home();
    const gaps = screen.getByRole("region", { name: "漏洞" });

    await expect
      .element(gaps)
      .toHaveTextContent(
        "漏洞2 个没补这一级1 个没补Rc 和 Arc 的区别借用规则 · 测验第 3 题&mut 什么时候结束借用规则之前带来的1 个移动后不能再用第 1 级 · 移动 · 测验第 2 题之前已补1 个",
      );
    const earlier = gaps.getByRole("button", { name: /之前已补/ });
    await earlier.click();
    await expect.element(earlier).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(gaps.getByRole("list", { name: "之前带来的漏洞" }))
      .toHaveTextContent("移动后不能再用第 1 级 · 移动 · 测验第 2 题loop 能带返回值第 1 级 · 移动之前已补1 个");

    const here = gaps.getByRole("list", { name: "这一级的漏洞" }).getByTestId("study-gap").nth(0);
    await here.hover();
    await here.getByRole("button", { name: "跑费曼" }).click();
    const carried = gaps.getByRole("list", { name: "之前带来的漏洞" }).getByTestId("study-gap").nth(0);
    await carried.hover();
    await carried.getByRole("button", { name: "跑费曼" }).click();
    // A fixed one has neither button.
    const fixed = gaps.getByRole("list", { name: "这一级的漏洞" }).getByTestId("study-gap").nth(1);
    expect(fixed.element().querySelectorAll("button")).toHaveLength(0);

    await expect
      .poll(() => calls.filter((call) => call.startsWith("startStudySession")))
      .toStrictEqual([
        `startStudySession ${RUST} {"kind":"feynman","level":"l2","step":"s1","gap":"g1"}`,
        `startStudySession ${RUST} {"kind":"feynman","level":"l2","gap":"g3"}`,
      ]);
  });

  it("goes back to a gap's Feynman session when one is open", async () => {
    const feynman = studied("fey", { study: { kind: "feynman", level: "l2", gap: "g3" } });
    const { screen, calls } = await home({}, { sessions: [feynman] });
    const carried = screen
      .getByRole("region", { name: "漏洞" })
      .getByRole("list", { name: "之前带来的漏洞" })
      .getByTestId("study-gap")
      .nth(0);

    await carried.hover();
    await carried.getByRole("button", { name: "回到费曼" }).click();

    await expect.poll(() => calls).toContain("openSession fey");
    expect(calls.filter((call) => call.startsWith("startStudySession"))).toStrictEqual([]);
  });
});

describe("a level's archived sessions (prototype 5B)", () => {
  const archived = [
    studied("l1-lesson", { archived: true, study: { kind: "lesson", level: "l1", step: "s1" } }),
    studied("l1-quiz", {
      archived: true,
      study: { kind: "quiz", level: "l1", step: "s1" },
      parent: { sessionId: "l1-lesson", by: "user" },
    }),
    studied("l1-plan", { archived: true, study: { kind: "plan", level: "l1" } }),
  ];

  it("lists them under the level opened, by step, each opened to be read or restored", async () => {
    const { screen, calls } = await home({}, { sessions: archived });
    const ladder = screen.getByRole("region", { name: "阶梯" });
    await ladder.getByRole("button", { name: /第 1 级 · 所有权/ }).click();
    const more = ladder.getByRole("button", { name: "会话 3 个 · 已归档" });
    await more.click();
    const list = ladder.getByLabelText("已归档的会话");

    await expect
      .poll(() => list.element().textContent)
      .toMatch(/^移动上课 · 移动\d+ 分钟前恢复测验 · 移动42\/50恢复排计划排计划 · 第 1 级\d+ 分钟前恢复$/);
    const rows = list.getByTestId("archived-session");
    await rows.nth(1).hover();
    await rows.nth(1).getByRole("button", { name: "恢复" }).click();
    await rows
      .nth(0)
      .getByRole("button", { name: /上课 · 移动/ })
      .click();

    await expect.poll(() => calls).toContain(`restoreStudySessions ${RUST} l1-quiz`);
    await expect.poll(() => calls).toContain("openSession l1-lesson");
  });

  it("says nothing for a level with none archived", async () => {
    const { screen } = await home({}, { sessions: [] });
    const ladder = screen.getByRole("region", { name: "阶梯" });
    await ladder.getByRole("button", { name: /第 1 级 · 所有权/ }).click();

    await expect.poll(() => ladder.element().textContent).toContain("状态学完了");
    expect(ladder.getByRole("button", { name: /已归档/ }).elements()).toHaveLength(0);
  });

  it("shows an archived session to read, with 恢复 in place of the input box", async () => {
    const { screen, calls } = await home({}, { sessions: archived, open: "l1-lesson" });
    const bar = screen.getByRole("region", { name: "会话已归档" });

    await expect.element(bar).toHaveTextContent("这个会话已归档，恢复以后才能接着发恢复");
    expect(screen.getByTestId("composer-card").elements()).toHaveLength(0);
    await bar.getByRole("button", { name: "恢复" }).click();

    await expect.poll(() => calls).toContain(`restoreStudySessions ${RUST} l1-lesson`);
  });
});

describe("the home's other fixes (2026-11-09 review)", () => {
  /** The first lesson's quiz put off ("以后再测"), the second the step to do. */
  const PUT_OFF: StudyProgress = {
    ...PROGRESS,
    steps: {
      ...PROGRESS.steps,
      l2: (PROGRESS.steps["l2"] ?? []).map((step) =>
        step.id === "s1" && step.kind === "lesson" ? { ...step, quiz: { by: "later" }, done: { by: "manual" } } : step,
      ),
    },
  };

  it("fades 补测 while its lesson runs, as 开始测验", async () => {
    const lesson = studied("lesson", { running: true, study: { kind: "lesson", level: "l2", step: "s1" } });
    const { screen, index } = await home(
      {
        progress: PUT_OFF,
        next: { primary: { type: "start", kind: "lesson", level: "l2", step: "s2", available: true }, secondary: null },
      },
      { sessions: [lesson] },
    );
    const row = screen.getByRole("region", { name: "步骤" }).getByTestId("study-step").nth(0);
    await row.hover();
    const retake = row.getByRole("button", { name: "补测" });

    await expect.element(retake).toBeDisabled();
    await expect.element(retake).toHaveAttribute("title", "等上课这一轮结束");
    index.setState({ sessions: [{ ...lesson, running: false }] });
    await expect.element(retake).toBeEnabled();
  });

  it("offers no manual mark or undo in a finished direction", async () => {
    const finished: StudyProgress = {
      ...PROGRESS,
      ladder: PROGRESS.ladder.map((level) => ({ ...level, state: "done" as const })),
      steps: {
        ...PROGRESS.steps,
        l3: [{ id: "s1", kind: "sheet", done: { by: "manual" } }],
      },
      gaps: [{ id: "g9", text: "手动补的", from: { level: "l3", step: "s1" }, fixed: { by: "manual" } }],
      finishedAt: "2026-11-10T00:00:00.000Z",
    };
    const { screen } = await home({ progress: finished, next: { primary: null, secondary: null } });
    const steps = screen.getByRole("region", { name: "步骤" });

    await expect.element(steps).toHaveTextContent("第 3 级的步骤速查表");
    expect(steps.getByRole("button", { name: /更多操作/ }).elements()).toHaveLength(0);
    const gaps = screen.getByRole("region", { name: "漏洞" });
    await expect.element(gaps).toHaveTextContent("漏洞这一级都补了手动补的速查表 · 你标的已补");
    expect(gaps.getByRole("button", { name: "撤回" }).elements()).toHaveLength(0);
    expect(gaps.getByRole("button", { name: "标为已补" }).elements()).toHaveLength(0);
  });

  it("lists sessions of an earlier level kept or restored under 其他会话", async () => {
    const kept = studied("old-lesson", { study: { kind: "lesson", level: "l1", step: "s1" } });
    const { screen, calls } = await home({}, { sessions: [kept] });
    const others = screen.getByRole("region", { name: "其他会话" });

    await expect.poll(() => others.element().textContent).toMatch(/^其他会话上课 · 移动\d+ 分钟前$/);
    await others.getByRole("button", { name: /上课 · 移动/ }).click();
    await expect.poll(() => calls).toContain("openSession old-lesson");
  });

  it("reaches an archived session's 恢复 by the keyboard", async () => {
    const shelved = studied("l1-lesson", { archived: true, study: { kind: "lesson", level: "l1", step: "s1" } });
    const { screen, calls } = await home({}, { sessions: [shelved] });
    const ladder = screen.getByRole("region", { name: "阶梯" });
    await ladder.getByRole("button", { name: /第 1 级 · 所有权/ }).click();
    await ladder.getByRole("button", { name: "会话 1 个 · 已归档" }).click();
    const row = ladder.getByTestId("archived-session").nth(0);

    (row.getByRole("button", { name: /上课 · 移动/ }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Tab}");
    const restore = row.getByRole("button", { name: "恢复" });
    await expect.element(restore).toHaveFocus();
    await expect.element(restore).toBeVisible();
    await userEvent.keyboard("{Enter}");

    await expect.poll(() => calls).toContain(`restoreStudySessions ${RUST} l1-lesson`);
  });
});

describe("a quiz child's start (prototype 1A)", () => {
  const lessonSource = { kind: "study", study: { kind: "lesson", level: "l2", step: "s1" } } as const;
  const quizSource = { kind: "study", study: { kind: "quiz", level: "l2", step: "s1" } } as const;

  it("says where it came from, folds the lesson's turns it copied, and goes back to the lesson", async () => {
    const quiz = studied("quiz", {
      prompt: "我改好了",
      study: { kind: "quiz", level: "l2", step: "s1" },
      parent: { sessionId: "lesson", by: "user" },
    });
    const lesson = studied("lesson", { study: { kind: "lesson", level: "l2", step: "s1" } });
    const { screen, views, calls } = await home({}, { sessions: [lesson, quiz], open: "quiz" });
    await vi.waitFor(() => expect(views.has("quiz")).toBe(true));
    views.get("quiz")?.setState({
      items: [
        turn("t1", lessonSource, [{ kind: "text", id: "0", text: "今天讲借用" }]),
        turn("t2", null, [{ kind: "text", id: "0", text: "对，就是作用范围" }], "我改好了"),
        turn("t3", quizSource, [{ kind: "text", id: "0", text: "第 1 题" }]),
      ],
    });

    await expect
      .element(screen.getByTestId("quiz-head"))
      .toHaveTextContent("测验 · 来自上课「借用规则」，带着这节课的上下文回到上课");
    const fold = screen.getByTestId("copied-turns");
    await expect.element(fold).toHaveTextContent("这节课的 2 轮· 来自上课会话");
    const transcript = screen.getByTestId("transcript");
    await expect.poll(() => transcript.element().textContent).toContain("测验 · 第 2 级第 1 步 · 借用规则第 1 题");
    expect(transcript.element().textContent).not.toContain("今天讲借用");
    const tabs = screen.getByRole("tablist", { name: "打开的会话" });
    await expect.element(tabs.getByRole("tab", { name: /测验 · 借用规则/ })).toBeVisible();
    await fold.click();
    await expect.poll(() => transcript.element().textContent).toContain("今天讲借用");
    await screen.getByTestId("quiz-head").getByRole("button", { name: "回到上课" }).click();

    await expect.poll(() => calls).toContain("openSession lesson");
  });

  it("says a quiz with no lesson to carry had no lesson's context, without the head", async () => {
    const quiz = studied("quiz", { study: { kind: "quiz", level: "l2", step: "s1" } });
    const { screen, views } = await home({}, { sessions: [quiz], open: "quiz" });
    await vi.waitFor(() => expect(views.has("quiz")).toBe(true));
    views.get("quiz")?.setState({ items: [turn("t3", quizSource, [{ kind: "text", id: "0", text: "第 1 题" }])] });

    await expect
      .element(screen.getByTestId("source-line"))
      .toHaveTextContent("测验 · 第 2 级第 1 步 · 借用规则 · 没带上课的上下文");
    expect(screen.getByTestId("quiz-head").elements()).toHaveLength(0);
    expect(screen.getByTestId("copied-turns").elements()).toHaveLength(0);
  });
});

describe("study tools on the process track (prototype 7C)", () => {
  it("says a gap found and a report in words, the gap's node a small attention square, the detail where it went", async () => {
    const quiz = studied("quiz", { study: { kind: "quiz", level: "l2", step: "s1" } });
    const { screen, views } = await home({}, { sessions: [quiz], open: "quiz" });
    await vi.waitFor(() => expect(views.has("quiz")).toBe(true));
    views.get("quiz")?.setState({
      items: [
        turn("t1", { kind: "study", study: { kind: "quiz", level: "l2", step: "s1" } }, [
          {
            kind: "tool",
            id: "a",
            callId: "a",
            tool: "study_add_gap",
            args: { text: "Rc 和 Arc 的区别", question: 3 },
            status: "done",
            output: "ok",
            details: null,
            partial: false,
          },
          {
            kind: "tool",
            id: "b",
            callId: "b",
            tool: "study_report",
            args: { score: 32, of: 50 },
            status: "done",
            output: "ok",
            details: null,
            partial: false,
          },
          { kind: "text", id: "c", text: "测验结束" },
        ]),
      ],
    });
    await screen.getByTestId("process-header").click();
    const steps = screen.getByTestId("step");

    await expect.element(steps.nth(0)).toHaveTextContent("记下漏洞 · Rc 和 Arc 的区别");
    await expect.element(steps.nth(1)).toHaveTextContent("报告 · 测验 32 / 50");
    expect(steps.nth(0).element().querySelector('[data-testid="rail-gap"]')).not.toBeNull();
    expect(steps.nth(1).element().querySelector('[data-testid="rail-gap"],[data-testid="rail-fixed"]')).toBeNull();
    await steps.nth(1).getByRole("button").first().click();

    await expect
      .poll(() => steps.nth(1).getByTestId("step-detail").element().textContent)
      .toBe('study_report  {"score":32,"of":50}\n写到  第 2 级第 1 步 · 测验');
  });

  it("says the gap a Feynman session fixed, its node a small ok square", async () => {
    const feynman = studied("fey", { study: { kind: "feynman", level: "l2", step: "s1", gap: "g1" } });
    const { screen, views } = await home({}, { sessions: [feynman], open: "fey" });
    await vi.waitFor(() => expect(views.has("fey")).toBe(true));
    views.get("fey")?.setState({
      items: [
        turn("t1", { kind: "study", study: { kind: "feynman", level: "l2", step: "s1", gap: "g1" } }, [
          {
            kind: "tool",
            id: "a",
            callId: "a",
            tool: "study_fix_gap",
            args: {},
            status: "done",
            output: "ok",
            details: null,
            partial: false,
          },
          { kind: "text", id: "c", text: "讲清楚了" },
        ]),
      ],
    });
    await screen.getByTestId("process-header").click();
    const step = screen.getByTestId("step").nth(0);

    await expect.element(step).toHaveTextContent("补上漏洞 · Rc 和 Arc 的区别");
    expect(step.element().querySelector('[data-testid="rail-fixed"]')).not.toBeNull();
  });
});
