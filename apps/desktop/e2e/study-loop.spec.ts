import type { FauxReply } from "@atrium/testkit";
import { type Page, expect, test } from "@playwright/test";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

/** A tool call's arguments, as the faux script takes them. */
type ToolArguments = Extract<FauxReply["blocks"][number], { type: "toolCall" }>["arguments"];

/**
 * A reply that calls one tool.
 *
 * @remarks
 * The ids only need to differ within a session.
 *
 * @sideEffects none
 * @param name - The tool.
 * @param args - Its arguments.
 * @returns The reply.
 */
function call(name: string, args: ToolArguments = {}): FauxReply {
  return { blocks: [{ type: "toolCall", id: `${name}-1`, name, arguments: args }] };
}

/**
 * A reply of text.
 *
 * @sideEffects none
 * @param text - The text.
 * @returns The reply.
 */
function say(text: string): FauxReply {
  return { blocks: [{ type: "text", text }] };
}

/** The quiz's one multiple-choice question, as the model asks it (SPEC-0003). */
const QUESTION = {
  header: "第 1 题",
  question: "const 声明的变量能重新赋值吗？",
  options: [
    { label: "能", description: "随时" },
    { label: "不能", description: "只赋值一次" },
  ],
};

/**
 * What each use's agent does in one level, by the use the host starts its pi for.
 *
 * @remarks
 * Each list is picked by the replies since the session's own start (`studyReplies`), so a quiz
 * forked from its lesson starts at its own first.
 *
 * @sideEffects none
 * @param levels - The ladder's levels.
 * @returns The replies.
 */
function level(levels: readonly { readonly name: string }[]): Record<string, FauxReply[]> {
  return {
    discuss: [
      call("study_set_ladder", {
        levels: levels.map(({ name }) => ({ name, topics: "基础", pass: "一个小工具" })),
        lessons: ["变量"],
      }),
      say("阶梯排好了"),
    ],
    lesson: [call("study_report"), say("这节课讲完了：let 和 const")],
    quiz: [
      call("ask_user", { questions: [QUESTION] }),
      call("study_add_gap", { text: "分不清 let 和 const", question: 1 }),
      call("study_report", { score: 5, of: 10 }),
      say("测完了"),
    ],
    feynman: [call("study_fix_gap"), say("讲清楚了")],
    sheet: [call("study_report"), say("速查表好了")],
    project: [call("study_report"), say("项目过了")],
    exam: [
      call("study_add_gap", { text: "闭包", question: 3 }),
      call("study_report", { score: 7, of: 10 }),
      say("考完了"),
    ],
    plan: [call("study_set_steps", { lessons: ["并发"] }), say("排了 1 节课")],
  };
}

/**
 * Starts a direction from its first message and waits for the discussion to write its ladder.
 *
 * @remarks
 * As the ML2 end-to-end test does.
 *
 * @sideEffects Clicks and types in the app.
 * @param window - The app's page.
 */
async function newDirection(window: Page): Promise<void> {
  await window.getByTestId("learning-row").click();
  await window.getByRole("button", { name: "新建方向" }).click();
  await window.getByRole("textbox", { name: "消息" }).fill("我想学 JavaScript");
  await window.getByRole("textbox", { name: "消息" }).press("Enter");
  await expect(window.getByTestId("reply").last()).toHaveText("阶梯排好了", { timeout: 60_000 });
}

/**
 * Presses a step-strip button once it can be pressed, then waits for the reply it leads to.
 *
 * @remarks
 * A button is dimmed while the session before it still runs (prototype 2A).
 *
 * @sideEffects Clicks in the app.
 * @param window - The app's page.
 * @param button - The button's name.
 * @param reply - The last reply of the session it opens; none for a mark.
 */
async function press(window: Page, button: string, reply?: string): Promise<void> {
  const target = window.getByTestId("step-strip").getByRole("button", { name: button, exact: true });
  await expect(target).toBeEnabled({ timeout: 60_000 });
  await target.click();
  if (reply !== undefined) await expect(window.getByTestId("reply").last()).toHaveText(reply, { timeout: 60_000 });
}

/**
 * Whether a request offered a quiz's tools.
 *
 * @remarks
 * Only a quiz or an exam records gaps.
 *
 * @sideEffects none
 * @param context - The request.
 * @returns Whether.
 */
function asksQuiz(context: { readonly tools?: readonly string[] }): boolean {
  return (context.tools ?? []).includes("study_add_gap");
}

/** The index's session records, as the host writes them. */
async function records(home: string) {
  const index = JSON.parse(await readFile(join(home, "sessions.json"), "utf8")) as {
    sessions: {
      sessionId: string;
      archived?: boolean;
      parent?: { sessionId: string; by: string };
      study?: { kind: string; level?: string };
    }[];
  };
  return index.sessions;
}

test("walks a level: lesson, its quiz as a child with an asked question, Feynman, sheet, project, exam, then upgrades to plan the next (SPEC-0008, ML3)", async () => {
  const pi = await fauxPiEnvironment({
    replies: [],
    studyReplies: level([{ name: "基础" }, { name: "进阶" }]),
    direction: JSON.stringify({ dir: "js", name: "JavaScript" }),
  });
  const launched = await launchApp(pi.env);
  const dir = join(await realpath(launched.home), "Learning", "js");
  try {
    const { window } = launched;
    await newDirection(window);
    const strip = window.getByTestId("step-strip");
    await expect(strip).toContainText("第 1 级 · 基础", { timeout: 30_000 });

    await press(window, "开始上课", "这节课讲完了：let 和 const");
    await press(window, "开始测验");
    // The quiz is the lesson's child, with its history folded, and asks on a card.
    await expect(window.getByTestId("quiz-head")).toContainText("测验 · 来自上课「变量」", { timeout: 60_000 });
    await expect(window.getByTestId("copied-turns")).toContainText("这节课的 1 轮");
    const card = window.getByTestId("question");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByRole("radio", { name: /不能/ }).click();
    await card.getByRole("button", { name: "提交回答" }).click();
    await expect(window.getByTestId("reply").last()).toHaveText("测完了", { timeout: 60_000 });
    const quizRequests = (await pi.contexts()).filter(asksQuiz);
    expect(quizRequests.length).toBeGreaterThan(0);
    expect(quizRequests[0]?.tools).not.toContain("study_set_ladder");
    expect(JSON.stringify(quizRequests[0]?.messages)).toContain("这节课讲完了：let 和 const");
    const quiz = (await records(launched.home)).find((one) => one.study?.kind === "quiz");
    const lesson = (await records(launched.home)).find((one) => one.study?.kind === "lesson");
    expect(quiz?.parent).toStrictEqual({ sessionId: lesson?.sessionId, by: "user" });

    await press(window, "跑费曼", "讲清楚了");
    await press(window, "进入下一步");
    await press(window, "生成速查表", "速查表好了");
    await press(window, "开始项目", "项目过了");
    await press(window, "开始测验", "考完了");
    // The exam left a gap: Feynman first, the upgrade beside it.
    await expect(strip.getByRole("button", { name: "跑费曼", exact: true })).toBeEnabled({ timeout: 60_000 });
    await press(window, "升级");
    const dialog = window.getByRole("alertdialog");
    await expect(dialog).toContainText("还没补的 1 个漏洞带到第 2 级");
    await expect(dialog.getByRole("checkbox")).toBeChecked();
    await dialog.getByRole("button", { name: "升级并排计划" }).click();

    // The plan session opens and plans; the strip is at the second level's first lesson.
    await expect(window.getByTestId("reply").last()).toHaveText("排了 1 节课", { timeout: 60_000 });
    await expect(strip).toContainText("第 2 级 · 进阶", { timeout: 30_000 });
    await expect(strip).toContainText("第 1 步 · 并发");
    const after = await records(launched.home);
    const levelOne = after.filter((one) => one.study?.level === "l1");
    expect(levelOne.map((one) => String(one.study?.kind)).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      "exam",
      "feynman",
      "lesson",
      "project",
      "quiz",
      "sheet",
    ]);
    expect(levelOne.every((one) => one.archived === true)).toBe(true);
    expect(after.find((one) => one.study?.kind === "discuss")?.archived).not.toBe(true);
    expect(after.find((one) => one.study?.kind === "plan")).toMatchObject({ study: { kind: "plan", level: "l2" } });
    const marker = JSON.parse(await readFile(join(dir, ".atrium-study.json"), "utf8")) as {
      ladder: { state: string }[];
      gaps: { text: string; fixed: unknown }[];
    };
    expect(marker.ladder.map((one) => one.state)).toStrictEqual(["done", "current"]);
    expect(marker.gaps.map((gap) => [gap.text, gap.fixed])).toStrictEqual([
      ["分不清 let 和 const", { by: "agent" }],
      ["闭包", null],
    ]);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("finishes a direction after its last level's upgrade, opening no plan (SPEC-0008, ML3)", async () => {
  const replies = level([{ name: "基础" }, { name: "进阶" }]);
  const pi = await fauxPiEnvironment({
    replies: [],
    studyReplies: {
      ...replies,
      // The first level is skipped, so the one learned is the last.
      discuss: [
        call("study_set_ladder", {
          levels: [
            { name: "基础", topics: "基础", pass: "小工具", skip: true },
            { name: "进阶", topics: "进阶", pass: "大工具" },
          ],
          lessons: ["变量"],
        }),
        say("阶梯排好了"),
      ],
      exam: [call("study_report", { score: 9, of: 10 }), say("考完了")],
    },
    direction: JSON.stringify({ dir: "js", name: "JavaScript" }),
  });
  const launched = await launchApp(pi.env);
  const dir = join(await realpath(launched.home), "Learning", "js");
  try {
    const { window } = launched;
    await newDirection(window);
    await press(window, "开始上课", "这节课讲完了：let 和 const");
    await press(window, "以后再测");
    await press(window, "生成速查表", "速查表好了");
    await press(window, "开始项目", "项目过了");
    await press(window, "开始测验", "考完了");
    await press(window, "学完");
    const dialog = window.getByRole("alertdialog");
    await expect(dialog.getByRole("heading")).toHaveText("学完最后一级");
    await dialog.getByRole("button", { name: "学完", exact: true }).click();

    await expect(window.getByTestId("step-strip")).toContainText("已学完", { timeout: 30_000 });
    const marker = JSON.parse(await readFile(join(dir, ".atrium-study.json"), "utf8")) as {
      ladder: { state: string }[];
      finishedAt: unknown;
    };
    expect(marker.ladder.map((one) => one.state)).toStrictEqual(["skipped", "done"]);
    expect(typeof marker.finishedAt).toBe("string");
    expect((await records(launched.home)).some((one) => one.study?.kind === "plan")).toBe(false);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
