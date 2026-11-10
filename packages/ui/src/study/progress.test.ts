import type { StudyAction, StudyFixedStep, StudyLesson, StudyProgress } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  actionLabel,
  currentLevel,
  lessonParts,
  progressLine,
  shownLevel,
  stepPhase,
  stepTitle,
  stripView,
  studyLabel,
} from "./progress";
import { studySessionTitle } from "./study-icon";

/** The first lesson: done, quizzed by the agent, with a gap left. */
const FIRST: StudyLesson = {
  id: "s1",
  kind: "lesson",
  title: "goroutine",
  lesson: { by: "agent" },
  quiz: { by: "agent", score: 3, of: 5 },
  done: { by: "manual" },
};

/** The second lesson: taught by hand. */
const SECOND: StudyLesson = {
  id: "s2",
  kind: "lesson",
  title: "channel",
  lesson: { by: "manual" },
  quiz: null,
  done: null,
};

/** The cheat sheet. */
const SHEET: StudyFixedStep = { id: "s3", kind: "sheet", done: null };

/** The second level's steps. */
const STEPS = [
  FIRST,
  SECOND,
  SHEET,
  { id: "s4", kind: "project", done: null },
  { id: "s5", kind: "exam", done: null },
  { id: "s6", kind: "up", done: null },
] as const satisfies readonly (StudyLesson | StudyFixedStep)[];

/** Three levels, the first skipped; the second current, with two lessons and the four steps after. */
const PROGRESS: StudyProgress = {
  profile: { goal: "爬虫" },
  ladder: [
    { id: "l1", name: "语法", topics: "", pass: "", state: "skipped" },
    { id: "l2", name: "并发", topics: "goroutine", pass: "爬虫", state: "current" },
    { id: "l3", name: "上线", topics: "", pass: "", state: "todo" },
  ],
  steps: { l2: [...STEPS] },
  gaps: [
    { id: "g1", text: "x", from: { level: "l2", step: "s1" }, fixed: null },
    { id: "g2", text: "y", from: { level: "l2", step: "s1" }, fixed: { by: "manual" } },
  ],
  finishedAt: null,
};

/** No buttons. */
const NONE = { primary: null, secondary: null };

describe("study progress words", () => {
  it("numbers the current level and names steps, the upgrade by the level it goes to", () => {
    expect(currentLevel(PROGRESS)).toStrictEqual({ id: "l2", number: 2, name: "并发" });
    expect(
      currentLevel({ ...PROGRESS, ladder: PROGRESS.ladder.map((level) => ({ ...level, state: "done" as const })) }),
    ).toBeNull();
    expect(STEPS.map((step) => stepTitle(step, 2, PROGRESS.ladder))).toStrictEqual([
      "goroutine",
      "channel",
      "速查表",
      "过关项目",
      "综合测验",
      "升到第 3 级",
    ]);
    expect(stepTitle({ id: "s6", kind: "up", done: null }, 3, PROGRESS.ladder)).toBe("学完最后一级");
  });

  it("names the upgrade by the next level not skipped, and the last to learn as finishing (ML3)", () => {
    const up = { id: "s6", kind: "up", done: null } as const;
    const ladder = [
      { id: "l1", name: "a", topics: "", pass: "", state: "current" },
      { id: "l2", name: "b", topics: "", pass: "", state: "skipped" },
      { id: "l3", name: "c", topics: "", pass: "", state: "todo" },
      { id: "l4", name: "d", topics: "", pass: "", state: "skipped" },
    ] as const;

    expect(stepTitle(up, 1, ladder)).toBe("升到第 3 级");
    expect(stepTitle(up, 3, ladder)).toBe("学完最后一级");
    const strip = stripView(
      {
        broken: false,
        newer: false,
        archived: false,
        next: NONE,
        progress: { ...PROGRESS, ladder: [...ladder], steps: { l1: [{ ...up, id: "s1" }] } },
      },
      [],
    );
    expect(strip).toMatchObject({ step: { number: 1, title: "升到第 3 级" } });
  });

  it("shows a finished direction's last level learnt, not a skipped one after it", () => {
    const finished: StudyProgress = {
      ...PROGRESS,
      ladder: [
        { id: "l1", name: "a", topics: "", pass: "", state: "done" },
        { id: "l2", name: "b", topics: "", pass: "", state: "done" },
        { id: "l3", name: "c", topics: "", pass: "", state: "skipped" },
      ],
      finishedAt: "2026-11-10T00:00:00.000Z",
    };

    expect(shownLevel(finished)).toStrictEqual({ id: "l2", number: 2, name: "b" });
    expect(
      stripView({ broken: false, newer: false, archived: false, next: NONE, progress: finished }, []),
    ).toMatchObject({
      kind: "finished",
      level: { id: "l2", number: 2 },
      dots: STEPS.map((step) => ({ id: step.id, state: "done" })),
    });
    // None learnt: the ladder's last.
    expect(
      shownLevel({ ...finished, ladder: finished.ladder.map((one) => ({ ...one, state: "skipped" as const })) }),
    ).toMatchObject({
      id: "l3",
      number: 3,
    });
  });

  it("labels a session by its use, level and step, or its use alone", () => {
    expect(studyLabel({ kind: "lesson", level: "l2", step: "s2" }, PROGRESS)).toBe("上课 · 第 2 级第 2 步");
    expect(studyLabel({ kind: "exam", level: "l2" }, PROGRESS)).toBe("综合测验 · 第 2 级");
    expect(studyLabel({ kind: "lesson", level: "l9", step: "s1" }, PROGRESS)).toBe("上课");
    expect(studyLabel({ kind: "lesson", level: "l2", step: "s9" }, PROGRESS)).toBe("上课 · 第 2 级");
    expect(studyLabel({ kind: "discuss" }, PROGRESS)).toBe("讨论");
    expect(studyLabel({ kind: "ask" }, null)).toBe("随口问");
    expect(studyLabel({ kind: "feynman", level: "l2", step: "s1", gap: "g1" }, null)).toBe("费曼");
  });

  it("draws a lesson's three parts: by the agent, by hand, put off, with gaps open", () => {
    const [first, second] = [FIRST, SECOND];

    expect(lessonParts(first, "l2", PROGRESS.gaps)).toStrictEqual(["done", "done", "gap"]);
    expect(lessonParts(first, "l2", [])).toStrictEqual(["done", "done", "done"]);
    expect(lessonParts(second, "l2", PROGRESS.gaps)).toStrictEqual(["manual", "todo", "todo"]);
    expect(lessonParts({ ...second, quiz: { by: "later" } }, "l2", [])).toStrictEqual(["manual", "later", "todo"]);
    expect(lessonParts({ ...second, quiz: { by: "manual" } }, "l2", [])).toStrictEqual(["manual", "manual", "done"]);
    expect(lessonParts({ ...second, lesson: null }, "l2", [])).toStrictEqual(["todo", "todo", "todo"]);
  });

  it("says where the current step stands", () => {
    const [first, second, sheet] = [FIRST, SECOND, SHEET];

    expect(stepPhase({ ...second, lesson: null }, "l2", [], false)).toBe("还没开始");
    expect(stepPhase(second, "l2", [], false)).toBe("上课完成");
    expect(stepPhase(first, "l2", PROGRESS.gaps, false)).toBe("测验 3/5 · 1 个漏洞");
    expect(stepPhase({ ...first, quiz: { by: "manual" } }, "l2", [...PROGRESS.gaps, PROGRESS.gaps[0]!], false)).toBe(
      "2 个漏洞",
    );
    expect(stepPhase(first, "l2", [], false)).toBe("测完了");
    expect(stepPhase(sheet, "l2", [], false)).toBe("还没开始");
    expect(stepPhase(sheet, "l2", [], true)).toBe("进行中");
  });

  it("says the upgrade waits on the exam's open gaps, and nothing else for it (prototype 2A)", () => {
    const up = STEPS[5];
    const examGap = { id: "g9", text: "z", from: { level: "l2", step: "s5" }, fixed: null };
    expect(stepPhase(up, "l2", [examGap, { ...examGap, id: "g8" }], false, STEPS)).toBe("综合测验还有 2 个漏洞");
    expect(stepPhase(up, "l2", [{ ...examGap, fixed: { by: "agent" } }], false, STEPS)).toBe("");
    expect(stepPhase(up, "l2", [{ ...examGap, from: { level: "l1", step: "s5" } }], false, STEPS)).toBe("");
    expect(stepPhase(up, "l2", [examGap], false)).toBe("");
    expect(stepPhase(up, "l2", [examGap], true, STEPS)).toBe("进行中");
  });

  it("words every button", () => {
    const at = { level: "l2", step: "s1" };

    const actions: StudyAction[] = [
      { type: "start", kind: "lesson", ...at, available: true },
      { type: "start", kind: "quiz", ...at, available: false },
      { type: "start", kind: "feynman", ...at, gap: "g1", available: false },
      { type: "start", kind: "sheet", ...at, available: true },
      { type: "start", kind: "project", ...at, available: true },
      { type: "start", kind: "exam", ...at, available: true },
      { type: "open", sessionId: "s" },
      { type: "mark", mark: "later", ...at },
      { type: "mark", mark: "step", ...at },
      { type: "upgrade", level: "l2", available: false },
      { type: "start", kind: "plan", level: "l3", available: true },
    ];

    expect(actions.map((action) => actionLabel(action))).toStrictEqual([
      "开始上课",
      "开始测验",
      "跑费曼",
      "生成速查表",
      "开始项目",
      "开始测验",
      "回到会话",
      "以后再测",
      "进入下一步",
      "升级",
      "排计划",
    ]);
    expect(actionLabel({ type: "upgrade", level: "l2", available: true }, true)).toBe("学完");
    expect(actionLabel({ type: "start", kind: "plan", level: "l3", available: true }, true)).toBe("排计划");
  });

  it("writes a card's line, with the open gaps only when some are", () => {
    expect(progressLine(PROGRESS)).toBe("共 3 级 · 第 2 级第 2 步 · 漏洞 1");
    expect(progressLine({ ...PROGRESS, gaps: [] })).toBe("共 3 级 · 第 2 级第 2 步");
    expect(progressLine({ ...PROGRESS, finishedAt: "2026-12-01T00:00:00.000Z", gaps: [] })).toBe("共 3 级 · 已学完");
    expect(progressLine({ ...PROGRESS, steps: {}, gaps: [] })).toBe("共 3 级 · 第 2 级");
  });
});

describe("stripView (prototype 2D)", () => {
  const base = { broken: false, newer: false, archived: false, progress: PROGRESS, next: NONE };

  it("shows the current level's dots, the current step and its phase", () => {
    expect(stripView(base, [])).toStrictEqual({
      kind: "learning",
      level: { id: "l2", number: 2, name: "并发" },
      levels: 3,
      dots: [
        { id: "s1", round: false, state: "done" },
        { id: "s2", round: false, state: "current" },
        { id: "s3", round: true, state: "todo" },
        { id: "s4", round: true, state: "todo" },
        { id: "s5", round: true, state: "todo" },
        { id: "s6", round: true, state: "todo" },
      ],
      step: { number: 2, title: "channel", phase: "上课完成" },
    });
  });

  it("says a session open for the step runs", () => {
    const next = { primary: { type: "open" as const, sessionId: "s7" }, secondary: null };

    expect(stripView({ ...base, next }, [{ sessionId: "s7", running: true }])).toMatchObject({
      step: { phase: "进行中" },
    });
    expect(stripView({ ...base, next }, [{ sessionId: "s7", running: false }])).toMatchObject({
      step: { phase: "上课完成" },
    });
  });

  it("is under discussion without progress, placeholders when broken, archived and finished as such", () => {
    expect(stripView({ ...base, progress: null }, [])).toStrictEqual({ kind: "discussing" });
    expect(stripView({ ...base, broken: true }, [])).toStrictEqual({ kind: "broken", dots: 13 });
    expect(stripView({ ...base, archived: true }, [])).toMatchObject({ kind: "archived", step: { number: 2 } });
    const finished = stripView({ ...base, progress: { ...PROGRESS, finishedAt: "2026-12-01T00:00:00.000Z" } }, []);

    expect(finished).toMatchObject({
      kind: "finished",
      dots: STEPS.map(() => ({ state: "done" })),
    });
  });

  it("shows the last level once none is current, as a finished direction's", () => {
    const allDone: StudyProgress = {
      ...PROGRESS,
      ladder: PROGRESS.ladder.map((level) => ({ ...level, state: "done" as const })),
      steps: { l3: [SHEET] },
      finishedAt: "2026-12-01T00:00:00.000Z",
    };

    expect(stripView({ ...base, progress: allDone }, [])).toStrictEqual({
      kind: "finished",
      level: { id: "l3", number: 3, name: "上线" },
      levels: 3,
      dots: [{ id: "s3", round: true, state: "done" }],
      step: { number: 1, title: "速查表", phase: "还没开始" },
    });
  });

  it("shows a file of a later version where it stands, as its own state", () => {
    expect(stripView({ ...base, newer: true }, [])).toMatchObject({
      kind: "newer",
      level: { id: "l2" },
      step: { number: 2 },
    });
    expect(stripView({ ...base, newer: true, broken: true }, [])).toStrictEqual({ kind: "broken", dots: 13 });
  });
});

describe("studySessionTitle (ML3)", () => {
  const direction = { progress: PROGRESS };
  const base = { name: null, prompt: null, state: "persisted" as const };

  it("names the sessions the host opened by their use, never by the first message there (B)", () => {
    const quiz = { ...base, study: { kind: "quiz" as const, level: "l2", step: "s2" } };
    expect(studySessionTitle(quiz, direction)).toBe("测验 · channel");
    expect(studySessionTitle({ ...quiz, prompt: "上课时的话" }, direction)).toBe("测验 · channel");
    expect(studySessionTitle({ ...quiz, name: "改过的名字" }, direction)).toBe("改过的名字");
    for (const [study, name] of [
      [{ kind: "lesson", level: "l2", step: "s1" }, "上课 · goroutine"],
      [{ kind: "sheet", level: "l2", step: "s3" }, "速查表 · 第 2 级"],
      [{ kind: "project", level: "l2", step: "s4" }, "过关项目 · 第 2 级"],
      [{ kind: "exam", level: "l2", step: "s5" }, "综合测验 · 第 2 级"],
      [{ kind: "plan", level: "l2" }, "排计划 · 第 2 级"],
    ] as const) {
      expect(studySessionTitle({ ...base, prompt: "确认，就这样排。", study }, direction)).toBe(name);
    }
    // The discussion and asking keep the ordinary title.
    expect(studySessionTitle({ ...base, prompt: "我想学 Go", study: { kind: "discuss" } }, direction)).toBe(
      "我想学 Go",
    );
    expect(studySessionTitle({ ...base, prompt: "问一下", study: { kind: "ask" } }, direction)).toBe("问一下");
    expect(studySessionTitle({ ...base, study: { kind: "plan" as const, level: "l3" } }, direction)).toBe(
      "排计划 · 第 3 级",
    );
    expect(studySessionTitle({ ...base, study: { kind: "feynman" as const, level: "l2", gap: "g1" } }, direction)).toBe(
      "费曼 · x",
    );
    expect(studySessionTitle({ ...base, study: { kind: "lesson" as const, level: "l2", step: "s9" } }, direction)).toBe(
      "上课 · 第 2 级",
    );
    expect(studySessionTitle({ ...base, study: { kind: "plan" as const, level: "l3" } }, undefined)).toBe("排计划");
  });
});
