import {
  type Control,
  IDLE_CONTROL,
  type QueuedPrompt,
  type SessionStudy,
  type StudyProgress,
  type TranscriptItem,
  type Turn,
} from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  type ControlOf,
  type LoopSession,
  archivedGroups,
  copiedItems,
  feynmanSessionOf,
  feynmanStudy,
  gapGroups,
  isLastLevel,
  lessonSessionOf,
  levelSessions,
  loopSessionName,
  studyToolLine,
  upgradeView,
  waitsForLesson,
} from "./loop";

/**
 * The controls a window shows: one session's as given, none for the others.
 *
 * @sideEffects none
 * @param sessionId - The session shown.
 * @param fields - What its control has besides being idle.
 * @returns How to find a session's control.
 */
function controlFor(sessionId: string, fields: Partial<Control>): ControlOf {
  const shown = { ...IDLE_CONTROL, ...fields };
  return (id) => [shown].find(() => id === sessionId) ?? null;
}

/** A message waiting in the host's queue. */
const QUEUED: QueuedPrompt = { id: "q1", text: "next", createdAt: 0, images: 0 };

/** Three levels, the second current: two lessons and the four steps after; gaps of both levels. */
const PROGRESS: StudyProgress = {
  profile: {},
  ladder: [
    { id: "l1", name: "所有权", topics: "", pass: "", state: "done" },
    { id: "l2", name: "借用", topics: "", pass: "", state: "current" },
    { id: "l3", name: "trait 与泛型", topics: "", pass: "", state: "todo" },
  ],
  steps: {
    l1: [{ id: "s1", kind: "lesson", title: "移动", lesson: null, quiz: null, done: { by: "manual" } }],
    l2: [
      { id: "s1", kind: "lesson", title: "借用规则", lesson: { by: "agent" }, quiz: null, done: null },
      { id: "s2", kind: "lesson", title: "生命周期", lesson: null, quiz: null, done: null },
      { id: "s3", kind: "sheet", done: null },
      { id: "s4", kind: "project", done: null },
      { id: "s5", kind: "exam", done: null },
      { id: "s6", kind: "up", done: null },
    ],
  },
  gaps: [
    { id: "g1", text: "旧的没补", from: { level: "l1", step: "s1", question: 2 }, fixed: null },
    { id: "g2", text: "旧的补了", from: { level: "l1", step: "s1" }, fixed: { by: "agent" } },
    { id: "g3", text: "这一级补了", from: { level: "l2", step: "s1" }, fixed: { by: "manual" } },
    { id: "g4", text: "这一级没补", from: { level: "l2", step: "s1", question: 3 }, fixed: null },
  ],
  finishedAt: null,
};

/**
 * A session of the direction.
 *
 * @remarks
 * Not archived, not running, with no parent, unless the fields say so.
 *
 * @sideEffects none
 * @param sessionId - Its id.
 * @param study - Its use.
 * @param fields - The rest.
 * @returns The session.
 */
function one(sessionId: string, study: SessionStudy | null, fields: Partial<LoopSession> = {}): LoopSession {
  return {
    sessionId,
    containerId: "lrn_rust",
    parent: null,
    study,
    archived: false,
    running: false,
    updatedAt: 100,
    ...fields,
  };
}

/**
 * A turn with a source.
 *
 * @remarks
 * Only its id and source matter here.
 *
 * @sideEffects none
 * @param id - Its id.
 * @param source - What opened it.
 * @returns The turn.
 */
function turn(id: string, source: Turn["source"]): TranscriptItem {
  return {
    kind: "turn",
    id,
    source,
    user: { text: "", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
    steps: [],
    outcome: "done",
    error: null,
    startedAt: 0,
    durationMs: null,
    usage: null,
    changes: [],
  };
}

describe("the quiz's lesson session", () => {
  it("is the latest lesson session of the step not archived, and a quiz waits while it runs", () => {
    const sessions = [
      one("old", { kind: "lesson", level: "l2", step: "s1" }, { updatedAt: 1, running: true }),
      one("new", { kind: "lesson", level: "l2", step: "s1" }, { updatedAt: 5 }),
      one("gone", { kind: "lesson", level: "l2", step: "s1" }, { updatedAt: 9, archived: true, running: true }),
      one("other", { kind: "lesson", level: "l2", step: "s2" }, { updatedAt: 7, running: true }),
      one("quiz", { kind: "quiz", level: "l2", step: "s1" }, { updatedAt: 8, running: true }),
    ];
    expect(lessonSessionOf(sessions, "l2", "s1")?.sessionId).toBe("new");
    expect(lessonSessionOf(sessions, "l2", "s3")).toBeUndefined();
    const quiz = { type: "start", kind: "quiz", level: "l2", step: "s1", available: true } as const;
    expect(waitsForLesson(quiz, sessions)).toBe(false);
    const running = [...sessions.filter((session) => session.sessionId !== "new"), { ...sessions[1]!, running: true }];
    expect(waitsForLesson(quiz, running)).toBe(true);
    expect(waitsForLesson({ ...quiz, kind: "lesson" }, running)).toBe(false);
    expect(waitsForLesson({ ...quiz, step: "s2" }, running)).toBe(true);
    expect(waitsForLesson({ ...quiz, step: "s3" }, running)).toBe(false);
    expect(waitsForLesson({ type: "start", kind: "quiz", level: "l2", available: true }, running)).toBe(false);
    expect(waitsForLesson({ type: "open", sessionId: "new" }, running)).toBe(false);
    expect(waitsForLesson(null, running)).toBe(false);
  });

  it("waits while the lesson shown here stops, compacts, restarts or has messages queued (C)", () => {
    const sessions = [one("new", { kind: "lesson", level: "l2", step: "s1" }, { updatedAt: 5 })];
    const quiz = { type: "start", kind: "quiz", level: "l2", step: "s1", available: true } as const;
    for (const busy of [{ stopping: true }, { compacting: true }, { restarting: true }, { queue: [QUEUED] }]) {
      expect(waitsForLesson(quiz, sessions, controlFor("new", busy))).toBe(true);
    }
    expect(waitsForLesson(quiz, sessions, () => IDLE_CONTROL)).toBe(false);
    // Another session's control does not count.
    expect(waitsForLesson(quiz, sessions, controlFor("other", { stopping: true }))).toBe(false);
  });
});

describe("the upgrade (prototype 4A)", () => {
  /** The level's sessions: a lesson with its quiz child and that child's child, Feynman, the plan. */
  const sessions = [
    one("lesson", { kind: "lesson", level: "l2", step: "s1" }, { running: true }),
    one("quiz", { kind: "quiz", level: "l2", step: "s1" }, { parent: { sessionId: "lesson", by: "user" } }),
    one("deep", null, { parent: { sessionId: "quiz", by: "agent" }, running: true }),
    one("feynman", { kind: "feynman", level: "l2", gap: "g1" }),
    one("discuss", { kind: "discuss" }, { running: true }),
    one("ask", { kind: "ask", level: "l2" }),
    one("plain", null),
    one("before", { kind: "lesson", level: "l1", step: "s1" }),
    one("archived", { kind: "lesson", level: "l2", step: "s2" }, { archived: true }),
    one("archivedChild", null, { parent: { sessionId: "lesson", by: "user" }, archived: true }),
  ];

  it("archives the level's sessions with their children, not the discussion, asking or other levels", () => {
    expect(levelSessions(sessions, "l2")).toStrictEqual(["lesson", "quiz", "feynman", "deep"]);
    expect(levelSessions(sessions, "l1")).toStrictEqual(["before"]);
    expect(levelSessions(sessions, "l3")).toStrictEqual([]);
  });

  it("says what it does for a level in the middle: the next level, the sessions, those running, the gaps carried", () => {
    expect(upgradeView(PROGRESS, "l2", sessions)).toStrictEqual({
      last: false,
      title: "升到第 3 级「trait 与泛型」",
      body: "第 2 级前面的 5 步都做完了。确定后开一个“排计划”会话，排第 3 级的课。",
      archive: "把第 2 级的 4 个会话一起归档",
      sessionIds: ["lesson", "quiz", "feynman", "deep"],
      running: 2,
      carried: "还没补的 2 个漏洞带到第 3 级。",
      confirm: "升级并排计划",
    });
  });

  it("skips skipped levels, and says nothing of gaps or sessions with none", () => {
    const skipped: StudyProgress = {
      ...PROGRESS,
      ladder: [
        ...PROGRESS.ladder.slice(0, 2),
        { id: "l3", name: "跳", topics: "", pass: "", state: "skipped" },
        { id: "l4", name: "上线", topics: "", pass: "", state: "todo" },
      ],
      gaps: [],
    };
    const view = upgradeView(skipped, "l2", []);
    expect(view?.title).toBe("升到第 4 级「上线」");
    expect(view?.body).toBe("第 2 级前面的 5 步都做完了。确定后开一个“排计划”会话，排第 4 级的课。");
    expect(view?.archive).toBeNull();
    expect(view?.carried).toBeNull();
    expect(view?.running).toBe(0);
  });

  it("finishes the direction at the last level: no plan, no gaps carried, '学完'", () => {
    const last: StudyProgress = {
      ...PROGRESS,
      ladder: [
        PROGRESS.ladder[0]!,
        PROGRESS.ladder[1]!,
        { id: "l3", name: "trait 与泛型", topics: "", pass: "", state: "skipped" },
      ],
    };
    expect(isLastLevel(last, "l2")).toBe(true);
    expect(isLastLevel(PROGRESS, "l2")).toBe(false);
    expect(isLastLevel(PROGRESS, "l9")).toBe(false);
    expect(upgradeView(last, "l2", sessions)).toStrictEqual({
      last: true,
      title: "学完最后一级",
      body: "第 2 级前面的 5 步都做完了。确定后这个方向标为“已学完”，还能随口问、复习。",
      archive: "把第 2 级的 4 个会话一起归档",
      sessionIds: ["lesson", "quiz", "feynman", "deep"],
      running: 2,
      carried: null,
      confirm: "学完",
    });
    expect(upgradeView(PROGRESS, "l9", sessions)).toBeNull();
  });

  it("counts no steps before a level with none", () => {
    expect(upgradeView({ ...PROGRESS, steps: {} }, "l2", [])?.body).toBe(
      "第 2 级前面的 0 步都做完了。确定后开一个“排计划”会话，排第 3 级的课。",
    );
  });
});

describe("the gaps (prototype 3B)", () => {
  it("groups this level's, open first, those carried still open, and earlier fixed ones", () => {
    const groups = gapGroups(PROGRESS);
    expect(groups.here.map((gap) => gap.id)).toStrictEqual(["g4", "g3"]);
    expect(groups.carried.map((gap) => gap.id)).toStrictEqual(["g1"]);
    expect(groups.earlierFixed.map((gap) => gap.id)).toStrictEqual(["g2"]);
    expect(groups.open).toBe(2);
  });

  it("starts Feynman at the current level, with the step only for a gap of it", () => {
    expect(feynmanStudy(PROGRESS.gaps[3]!, PROGRESS)).toStrictEqual({
      kind: "feynman",
      level: "l2",
      step: "s1",
      gap: "g4",
    });
    expect(feynmanStudy(PROGRESS.gaps[0]!, PROGRESS)).toStrictEqual({ kind: "feynman", level: "l2", gap: "g1" });
    const finished: StudyProgress = {
      ...PROGRESS,
      ladder: PROGRESS.ladder.map((level) => ({ ...level, state: "done" as const })),
    };
    expect(feynmanStudy(PROGRESS.gaps[0]!, finished)).toBeNull();
  });

  it("finds the Feynman session open for a gap's start, the latest not archived, matched as the host does", () => {
    const sessions = [
      one("a", { kind: "feynman", level: "l2", gap: "g1" }, { updatedAt: 1 }),
      one("b", { kind: "feynman", level: "l2", gap: "g1" }, { updatedAt: 3 }),
      one("c", { kind: "feynman", level: "l2", gap: "g1" }, { updatedAt: 9, archived: true }),
      one("d", { kind: "quiz", level: "l2", gap: "g4" }, { updatedAt: 9 }),
      // The same gap's Feynman of an earlier level, kept at the upgrade, and one with a step.
      one("e", { kind: "feynman", level: "l1", gap: "g1" }, { updatedAt: 20 }),
      one("f", { kind: "feynman", level: "l2", step: "s1", gap: "g1" }, { updatedAt: 20 }),
    ];
    expect(feynmanSessionOf(sessions, { level: "l2", gap: "g1" })).toBe("b");
    expect(feynmanSessionOf(sessions, { level: "l2", step: "s1", gap: "g1" })).toBe("f");
    expect(feynmanSessionOf(sessions, { level: "l3", gap: "g1" })).toBeNull();
    expect(feynmanSessionOf(sessions, { level: "l2", gap: "g4" })).toBeNull();
  });
});

describe("a level's archived sessions (prototype 5B)", () => {
  it("groups them by step in the level's order, those of no step by use, children with their parents", () => {
    const sessions = [
      one("q", { kind: "quiz", level: "l2", step: "s2" }, { archived: true, updatedAt: 2 }),
      one("l", { kind: "lesson", level: "l2", step: "s1" }, { archived: true, updatedAt: 1 }),
      one("kid", null, { archived: true, parent: { sessionId: "l", by: "agent" }, updatedAt: 3 }),
      one("plan", { kind: "plan", level: "l2" }, { archived: true, updatedAt: 4 }),
      one("live", { kind: "lesson", level: "l2", step: "s1" }),
      one("other", { kind: "lesson", level: "l1", step: "s1" }, { archived: true }),
      one("talk", { kind: "discuss" }, { archived: true }),
      one("orphan", null, { archived: true, parent: { sessionId: "missing", by: "user" } }),
    ];
    const groups = archivedGroups(sessions, PROGRESS, "l2");
    expect(
      groups.map(({ key, title, sessions: inside }) => [key, title, inside.map((s) => s.sessionId)]),
    ).toStrictEqual([
      ["step:s1", "借用规则", ["l", "kid"]],
      ["step:s2", "生命周期", ["q"]],
      ["kind:plan", "排计划", ["plan"]],
    ]);
    expect(archivedGroups(sessions, PROGRESS, "l3")).toStrictEqual([]);
    expect(archivedGroups(sessions, PROGRESS, "l1").map((group) => group.title)).toStrictEqual(["移动"]);
  });

  it("stops at a loop in the parents", () => {
    const sessions = [
      one("a", null, { archived: true, parent: { sessionId: "b", by: "user" } }),
      one("b", null, { archived: true, parent: { sessionId: "a", by: "user" } }),
    ];
    expect(archivedGroups(sessions, PROGRESS, "l2")).toStrictEqual([]);
  });
});

describe("a quiz child's copied turns (prototype 1A)", () => {
  const lesson = { kind: "study", study: { kind: "lesson", level: "l2", step: "s1" } } as const;
  const quiz = { kind: "study", study: { kind: "quiz", level: "l2", step: "s1" } } as const;

  it("are those before the quiz's own start", () => {
    expect(copiedItems([turn("a", lesson), turn("b", null), turn("c", quiz), turn("d", null)])).toBe(2);
  });

  it("are all before the quiz started, and all shown while its start is not among them", () => {
    expect(copiedItems([turn("a", lesson), turn("b", null)])).toBe(2);
    // Older turns not loaded and no quiz start among those shown: all shown are copied (SPEC-0008).
    expect(copiedItems([turn("b", null)])).toBe(1);
    expect(copiedItems([turn("a", lesson), turn("c", quiz)])).toBe(1);
    expect(copiedItems([])).toBe(0);
  });
});

describe("study tools on the process track (prototype 7C)", () => {
  const quiz: SessionStudy = { kind: "quiz", level: "l2", step: "s1" };

  it("words a gap found, with its square and where it went", () => {
    expect(
      studyToolLine("study_add_gap", { text: "Rc 和 Arc\n细节", question: 3 }, false, quiz, PROGRESS),
    ).toStrictEqual({
      verb: "记下漏洞",
      object: "Rc 和 Arc",
      square: "gap",
      wrote: "第 2 级第 1 步 · 测验",
    });
    expect(studyToolLine("study_add_gap", { text: 3 }, true, quiz, PROGRESS)?.verb).toBe("正在记下漏洞");
    expect(studyToolLine("study_add_gap", {}, false, quiz, PROGRESS)?.object).toBe("");
  });

  it("words the gap a Feynman session fixed, from the progress", () => {
    const feynman: SessionStudy = { kind: "feynman", level: "l2", gap: "g4" };
    expect(studyToolLine("study_fix_gap", {}, false, feynman, PROGRESS)).toStrictEqual({
      verb: "补上漏洞",
      object: "这一级没补",
      square: "fixed",
      wrote: "第 2 级 · 费曼",
    });
    expect(studyToolLine("study_fix_gap", {}, true, feynman, null)).toStrictEqual({
      verb: "正在补上漏洞",
      object: "",
      square: "fixed",
      wrote: null,
    });
  });

  it("words each use's report", () => {
    const words = (kind: SessionStudy["kind"], args: Record<string, unknown> = {}) =>
      studyToolLine("study_report", args, false, { kind, level: "l2", step: "s1" }, PROGRESS)?.object;
    expect(words("quiz", { score: 32, of: 50 })).toBe("测验 32 / 50");
    expect(words("exam", { score: 8, of: 10 })).toBe("综合测验 8 / 10");
    expect(words("quiz")).toBe("测验");
    expect(words("lesson")).toBe("上课完成");
    expect(words("sheet")).toBe("速查表完成");
    expect(words("project")).toBe("过关项目通过");
    expect(studyToolLine("study_report", { score: 1, of: 2 }, false, null, PROGRESS)).toStrictEqual({
      verb: "报告",
      object: "1 / 2",
      square: null,
      wrote: null,
    });
    expect(studyToolLine("study_report", {}, true, { kind: "quiz", level: "l2", step: "s1" }, PROGRESS)?.verb).toBe(
      "正在报告",
    );
  });

  it("words the lessons a plan wrote, and leaves other tools alone", () => {
    const plan: SessionStudy = { kind: "plan", level: "l3" };
    expect(studyToolLine("study_set_steps", { lessons: ["a", "b"] }, false, plan, PROGRESS)).toStrictEqual({
      verb: "排了课",
      object: "第 3 级 · 2 节",
      square: null,
      wrote: "第 3 级",
    });
    expect(studyToolLine("study_set_steps", {}, true, plan, null)).toStrictEqual({
      verb: "正在排课",
      object: "",
      square: null,
      wrote: null,
    });
    expect(studyToolLine("study_set_ladder", {}, false, plan, PROGRESS)).toBeNull();
    expect(studyToolLine("bash", {}, false, plan, PROGRESS)).toBeNull();
  });
});

describe("the loop's session names", () => {
  it("names a quiz by its lesson, Feynman by its gap cut short, a plan by its level", () => {
    expect(loopSessionName({ kind: "quiz", level: "l2", step: "s1" }, PROGRESS)).toBe("测验 · 借用规则");
    expect(loopSessionName({ kind: "quiz", level: "l2", step: "s3" }, PROGRESS)).toBeNull();
    expect(loopSessionName({ kind: "feynman", level: "l2", gap: "g4" }, PROGRESS)).toBe("费曼 · 这一级没补");
    const long = { ...PROGRESS, gaps: [{ ...PROGRESS.gaps[0]!, text: "一".repeat(30) }] };
    expect(loopSessionName({ kind: "feynman", level: "l2", gap: "g1" }, long)).toBe(`费曼 · ${"一".repeat(24)}…`);
    expect(loopSessionName({ kind: "feynman", level: "l2", gap: "g9" }, PROGRESS)).toBeNull();
    expect(loopSessionName({ kind: "plan", level: "l3" }, PROGRESS)).toBe("排计划 · 第 3 级");
    expect(loopSessionName({ kind: "plan", level: "l9" }, PROGRESS)).toBeNull();
    expect(loopSessionName({ kind: "lesson", level: "l2", step: "s1" }, PROGRESS)).toBe("上课 · 借用规则");
    expect(loopSessionName({ kind: "lesson", level: "l2", step: "s9" }, PROGRESS)).toBeNull();
    expect(loopSessionName({ kind: "sheet", level: "l2", step: "s3" }, PROGRESS)).toBe("速查表 · 第 2 级");
    expect(loopSessionName({ kind: "project", level: "l2" }, PROGRESS)).toBe("过关项目 · 第 2 级");
    expect(loopSessionName({ kind: "exam", level: "l2" }, PROGRESS)).toBe("综合测验 · 第 2 级");
    expect(loopSessionName({ kind: "exam", level: "l9" }, PROGRESS)).toBeNull();
    expect(loopSessionName({ kind: "discuss" }, PROGRESS)).toBeNull();
    expect(loopSessionName({ kind: "quiz" }, PROGRESS)).toBeNull();
    expect(loopSessionName({ kind: "plan", level: "l3" }, null)).toBeNull();
  });
});
