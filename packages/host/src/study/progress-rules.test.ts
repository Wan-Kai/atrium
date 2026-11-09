import { describe, expect, it } from "vitest";
import { StudyFile, progressOf } from "./progress";
import {
  StudyRuleError,
  addGap,
  fixGap,
  markGap,
  markStep,
  nextOf,
  report,
  setLadder,
  setName,
  setProfile,
  setSteps,
} from "./progress-rules";

/** A direction under discussion, with a field of a later version kept. */
const FRESH: StudyFile = { version: 1, name: "Go", createdAt: "2026-11-09T00:00:00.000Z", later: { keep: true } };

/** Three levels: the first skipped, the second where the learner starts, with two lessons. */
const LADDER = {
  levels: [
    { name: "语法", topics: "类型", pass: "小工具", skip: true },
    { name: "并发", topics: "goroutine", pass: "爬虫" },
    { name: "上线", topics: "部署", pass: "VPS" },
  ],
  lessons: ["goroutine", "channel"],
};

/** The direction once the discussion wrote its ladder. */
const PLANNED = setLadder(FRESH, LADDER);

/**
 * The refusal a rule throws.
 *
 * @remarks
 * Its code and parameters, to compare whole.
 *
 * @sideEffects Runs the rule.
 * @param rule - The rule.
 * @returns The code and parameters.
 */
function refusal(rule: () => unknown): { code: string; params: unknown } {
  try {
    rule();
  } catch (error) {
    if (error instanceof StudyRuleError) return { code: error.code, params: error.params };
    throw error;
  }
  throw new Error("not refused");
}

/** The steps of the second level of a file. */
function steps(file: StudyFile) {
  return file.steps?.["l2"] ?? [];
}

/** The levels of a file. */
function ladder(file: StudyFile) {
  return file.ladder ?? [];
}

/**
 * A file with each level's state set as given.
 *
 * @remarks
 * Levels not named keep theirs.
 *
 * @sideEffects none
 * @param file - The file.
 * @param states - The states, by level id.
 * @returns The file.
 */
function withStates(
  file: StudyFile,
  states: Readonly<Record<string, "skipped" | "current" | "done" | "todo">>,
): StudyFile {
  return { ...file, ladder: ladder(file).map((level) => ({ ...level, state: states[level.id] ?? level.state })) };
}

/**
 * A file with one step of the second level changed.
 *
 * @remarks
 * The others as they were.
 *
 * @sideEffects none
 * @param file - The file.
 * @param id - The step.
 * @param fields - What to set on it.
 * @returns The file.
 */
function withStep(file: StudyFile, id: string, fields: Record<string, unknown>): StudyFile {
  return StudyFile.parse({
    ...file,
    steps: { l2: steps(file).map((step) => (step.id === id ? { ...step, ...fields } : step)) },
  });
}

/** A session's record at a step of the second level. */
function at(kind: "lesson" | "quiz" | "exam" | "sheet" | "discuss", step: string) {
  return { kind, level: "l2", step };
}

describe("the discussion's tools", () => {
  it("writes the ladder, its start and the starting level's lessons with the four steps after them", () => {
    expect(PLANNED).toStrictEqual({
      ...FRESH,
      ladder: [
        { id: "l1", name: "语法", topics: "类型", pass: "小工具", state: "skipped" },
        { id: "l2", name: "并发", topics: "goroutine", pass: "爬虫", state: "current" },
        { id: "l3", name: "上线", topics: "部署", pass: "VPS", state: "todo" },
      ],
      steps: {
        l2: [
          { id: "s1", kind: "lesson", title: "goroutine", lesson: null, quiz: null, done: null },
          { id: "s2", kind: "lesson", title: "channel", lesson: null, quiz: null, done: null },
          { id: "s3", kind: "sheet", done: null },
          { id: "s4", kind: "project", done: null },
          { id: "s5", kind: "exam", done: null },
          { id: "s6", kind: "up", done: null },
        ],
      },
      gaps: [],
      finishedAt: null,
    });
  });

  it("takes 2 and 6 levels, refuses 1 and 7 with the bounds", () => {
    const level = { name: "x", topics: "", pass: "" };
    expect(setLadder(FRESH, { levels: [level, level], lessons: ["a"] }).ladder).toHaveLength(2);
    expect(setLadder(FRESH, { levels: Array.from({ length: 6 }, () => level), lessons: ["a"] }).ladder).toHaveLength(6);
    expect(refusal(() => setLadder(FRESH, { levels: [level], lessons: ["a"] }))).toStrictEqual({
      code: "study_ladder_size",
      params: { min: 2, max: 6, got: 1 },
    });
    expect(
      refusal(() => setLadder(FRESH, { levels: Array.from({ length: 7 }, () => level), lessons: ["a"] })),
    ).toStrictEqual({
      code: "study_ladder_size",
      params: { min: 2, max: 6, got: 7 },
    });
  });

  it("refuses a ladder written already, and one with every level skipped", () => {
    expect(refusal(() => setLadder(PLANNED, LADDER))).toStrictEqual({ code: "study_ladder_set", params: {} });
    expect(
      refusal(() =>
        setLadder(FRESH, { levels: LADDER.levels.map((level) => ({ ...level, skip: true })), lessons: ["a"] }),
      ),
    ).toStrictEqual({ code: "agent_bad_request", params: {} });
  });

  it("names the direction and merges the profile, keeping other fields", () => {
    expect(setName(FRESH, "Go 并发")).toStrictEqual({ ...FRESH, name: "Go 并发" });
    const profiled = setProfile({ ...FRESH, profile: { goal: "CLI", other: 1 } }, { language: "Go" });

    expect(profiled.profile).toStrictEqual({ goal: "CLI", other: 1, language: "Go" });
    expect(setProfile(profiled, { goal: "爬虫" }).profile).toStrictEqual({ goal: "爬虫", other: 1, language: "Go" });
  });
});

describe("planning a level", () => {
  it("writes the current level's lessons when it has none, numbering after the steps there are", () => {
    const upgraded = withStates(PLANNED, { l2: "done", l3: "current" });

    expect(setSteps(upgraded, ["docker"]).steps?.["l3"]).toStrictEqual([
      { id: "s1", kind: "lesson", title: "docker", lesson: null, quiz: null, done: null },
      { id: "s2", kind: "sheet", done: null },
      { id: "s3", kind: "project", done: null },
      { id: "s4", kind: "exam", done: null },
      { id: "s5", kind: "up", done: null },
    ]);
    expect(refusal(() => setSteps(PLANNED, ["again"]))).toStrictEqual({ code: "study_steps_set", params: {} });
    expect(refusal(() => setSteps(FRESH, ["a"]))).toStrictEqual({ code: "study_not_found", params: {} });
  });
});

describe("reports", () => {
  it("marks a lesson taught, then its quiz with the score, the lesson taken over as the agent's", () => {
    const taught = report(PLANNED, { kind: "lesson", level: "l2", step: "s1" }, {});

    expect(steps(taught)[0]).toMatchObject({ lesson: { by: "agent" }, quiz: null, done: null });
    const manual = markStep(PLANNED, "l2", "s1", "lesson", true);
    const quizzed = report(manual, { kind: "quiz", level: "l2", step: "s1" }, { score: 4, of: 5 });

    expect(steps(quizzed)[0]).toMatchObject({ lesson: { by: "agent" }, quiz: { by: "agent", score: 4, of: 5 } });
  });

  it("takes the agent's report over a manual mark", () => {
    const marked = markStep(PLANNED, "l2", "s1", "quiz", true);
    const taught = markStep(PLANNED, "l2", "s1", "lesson", true);

    expect(steps(report(taught, { kind: "lesson", level: "l2", step: "s1" }, {}))[0]).toMatchObject({
      lesson: { by: "agent" },
    });

    expect(steps(marked)[0]).toMatchObject({ lesson: { by: "manual" }, quiz: { by: "manual" } });
    expect(steps(report(marked, { kind: "quiz", level: "l2", step: "s1" }, { score: 2, of: 3 }))[0]).toMatchObject({
      lesson: { by: "agent" },
      quiz: { by: "agent", score: 2, of: 3 },
    });
    const sheet = markStep(PLANNED, "l2", "s3", "step", true);

    expect(steps(report(sheet, { kind: "sheet", level: "l2", step: "s3" }, {}))[2]).toStrictEqual({
      id: "s3",
      kind: "sheet",
      done: { by: "agent" },
    });
  });

  it("marks the fixed steps done, the exam with its score", () => {
    expect(steps(report(PLANNED, { kind: "project", level: "l2", step: "s4" }, {}))[3]).toStrictEqual({
      id: "s4",
      kind: "project",
      done: { by: "agent" },
    });
    expect(steps(report(PLANNED, { kind: "exam", level: "l2", step: "s5" }, { score: 8, of: 10 }))[4]).toStrictEqual({
      id: "s5",
      kind: "exam",
      done: { by: "agent", score: 8, of: 10 },
    });
  });

  it("refuses a report that does not fit the session's step", () => {
    const bad = [
      [at("lesson", "s1"), { score: 1, of: 2 }],
      [at("quiz", "s1"), {}],
      [at("quiz", "s1"), { score: 3, of: 2 }],
      [at("quiz", "s1"), { score: 1 }],
      [at("exam", "s5"), {}],
      [at("sheet", "s3"), { score: 1, of: 1 }],
    ] as const;
    const missing = [at("lesson", "s9"), at("lesson", "s3"), at("sheet", "s1"), { kind: "lesson" as const }];

    expect(bad.map(([study, args]) => refusal(() => report(PLANNED, study, args)).code)).toStrictEqual(
      bad.map(() => "study_bad_report"),
    );
    expect(missing.map((study) => refusal(() => report(PLANNED, study, {})).code)).toStrictEqual(
      missing.map(() => "study_not_found"),
    );
    expect(refusal(() => report(PLANNED, at("discuss", "s1"), {}))).toStrictEqual({
      code: "study_not_allowed",
      params: {},
    });
  });
});

describe("gaps", () => {
  it("records a gap from the session's step and fixes it, the agent over a manual mark", () => {
    const one = addGap(PLANNED, { kind: "quiz", level: "l2", step: "s1" }, { text: "关闭的 channel", question: 3 });
    const two = addGap(one, { kind: "exam", level: "l2", step: "s5" }, { text: "select" });

    expect(two.gaps).toStrictEqual([
      { id: "g1", text: "关闭的 channel", from: { level: "l2", step: "s1", question: 3 }, fixed: null },
      { id: "g2", text: "select", from: { level: "l2", step: "s5" }, fixed: null },
    ]);
    const manual = markGap(two, "g1", true);

    expect(manual.gaps?.[0]?.fixed).toStrictEqual({ by: "manual" });
    expect(fixGap(manual, "g1").gaps?.[0]?.fixed).toStrictEqual({ by: "agent" });
    expect(refusal(() => fixGap(two, "g9"))).toStrictEqual({ code: "study_not_found", params: {} });
    expect(refusal(() => addGap(PLANNED, { kind: "quiz", level: "l2", step: "s9" }, { text: "x" }))).toStrictEqual({
      code: "study_not_found",
      params: {},
    });
  });

  it("numbers a gap after the highest there is, and stops at the limit", () => {
    const file: StudyFile = {
      ...PLANNED,
      gaps: [{ id: "g7", text: "x", from: { level: "l2", step: "s1" }, fixed: null }],
    };

    expect(addGap(file, { kind: "quiz", level: "l2", step: "s1" }, { text: "y" }).gaps?.[1]?.id).toBe("g8");
    const full: StudyFile = {
      ...PLANNED,
      gaps: Array.from({ length: 200 }, (_, index) => ({
        id: `g${String(index + 1)}`,
        text: "x",
        from: { level: "l2", step: "s1" },
        fixed: null,
      })),
    };

    expect(refusal(() => addGap(full, { kind: "quiz", level: "l2", step: "s1" }, { text: "y" }))).toStrictEqual({
      code: "study_gaps_full",
      params: { max: 200 },
    });
  });

  it("marks a gap fixed by hand and takes it back, but not the agent's", () => {
    const one = addGap(PLANNED, { kind: "quiz", level: "l2", step: "s1" }, { text: "x" });
    const fixed = markGap(one, "g1", true);

    expect(markGap(fixed, "g1", false)).toStrictEqual(one);
    expect(refusal(() => markGap(fixed, "g1", true))).toStrictEqual({ code: "study_mark_refused", params: {} });
    expect(refusal(() => markGap(fixGap(one, "g1"), "g1", false))).toStrictEqual({
      code: "study_mark_refused",
      params: {},
    });
    expect(refusal(() => markGap(one, "g1", false))).toStrictEqual({ code: "study_mark_refused", params: {} });
    expect(refusal(() => markGap(one, "g2", true))).toStrictEqual({ code: "study_not_found", params: {} });
  });
});

describe("marking by hand", () => {
  it("marks a lesson's parts, the quiz with its lesson, and takes them back with what came after", () => {
    const lesson = markStep(PLANNED, "l2", "s1", "lesson", true);

    expect(steps(lesson)[0]).toMatchObject({ lesson: { by: "manual" }, quiz: null, done: null });
    const whole = markStep(PLANNED, "l2", "s1", "step", true);

    expect(steps(whole)[0]).toMatchObject({ lesson: { by: "manual" }, quiz: { by: "manual" }, done: { by: "manual" } });
    expect(markStep(whole, "l2", "s1", "lesson", false)).toStrictEqual(PLANNED);
    expect(steps(markStep(whole, "l2", "s1", "quiz", false))[0]).toMatchObject({
      lesson: { by: "manual" },
      quiz: null,
      done: null,
    });
    // Undoing the whole step takes back what it marked with it, as before the mark.
    expect(markStep(whole, "l2", "s1", "step", false)).toStrictEqual(PLANNED);
  });

  it("undoes the whole step back to before it, keeping what was marked before and what the agent reported since", () => {
    const lesson = markStep(PLANNED, "l2", "s1", "lesson", true);
    const whole = markStep(lesson, "l2", "s1", "step", true);

    expect(steps(whole)[0]).toMatchObject({ done: { by: "manual", parts: ["quiz"] } });
    expect(markStep(whole, "l2", "s1", "step", false)).toStrictEqual(lesson);
    expect(markStep(markStep(PLANNED, "l2", "s1", "step", true), "l2", "s1", "step", false)).toStrictEqual(PLANNED);
    const reported = report(markStep(PLANNED, "l2", "s1", "step", true), at("quiz", "s1"), { score: 3, of: 4 });

    expect(steps(markStep(reported, "l2", "s1", "step", false))[0]).toStrictEqual({
      id: "s1",
      kind: "lesson",
      title: "goroutine",
      lesson: { by: "agent" },
      quiz: { by: "agent", score: 3, of: 4 },
      done: null,
    });
    // A step marked whole by a file without `parts` keeps its parts.
    const old = withStep(PLANNED, "s1", { lesson: { by: "manual" }, quiz: { by: "manual" }, done: { by: "manual" } });

    expect(steps(markStep(old, "l2", "s1", "step", false))[0]).toMatchObject({
      lesson: { by: "manual" },
      quiz: { by: "manual" },
      done: null,
    });
  });

  it("puts a quiz off once the lesson is done, and takes that back", () => {
    const taught = report(PLANNED, { kind: "lesson", level: "l2", step: "s1" }, {});
    const later = markStep(taught, "l2", "s1", "later", true);

    expect(steps(later)[0]).toMatchObject({ lesson: { by: "agent" }, quiz: { by: "later" }, done: { by: "manual" } });
    expect(markStep(later, "l2", "s1", "later", false)).toStrictEqual(taught);
    expect(refusal(() => markStep(PLANNED, "l2", "s1", "later", true))).toStrictEqual({
      code: "study_mark_refused",
      params: {},
    });
  });

  it("goes on to the next step with gaps left, keeping the agent's parts", () => {
    const quizzed = report(PLANNED, { kind: "quiz", level: "l2", step: "s1" }, { score: 1, of: 5 });
    const on = markStep(quizzed, "l2", "s1", "step", true);

    expect(steps(on)[0]).toMatchObject({
      lesson: { by: "agent" },
      quiz: { by: "agent", score: 1, of: 5 },
      done: { by: "manual" },
    });
  });

  it("refuses marks the rules do not allow", () => {
    const taught = report(PLANNED, { kind: "lesson", level: "l2", step: "s1" }, {});
    const done = markStep(PLANNED, "l2", "s1", "step", true);
    const cases = [
      [taught, "s1", "lesson", true],
      [taught, "s1", "lesson", false],
      [done, "s1", "quiz", true],
      [done, "s1", "step", true],
      [PLANNED, "s1", "quiz", false],
      [PLANNED, "s1", "step", false],
      [PLANNED, "s1", "later", false],
      [PLANNED, "s3", "lesson", true],
      [PLANNED, "s3", "later", true],
      [PLANNED, "s3", "step", false],
      [report(PLANNED, { kind: "sheet", level: "l2", step: "s3" }, {}), "s3", "step", false],
      // The upgrade is the upgrade's to do, never a mark (prototype 1A).
      [PLANNED, "s6", "step", true],
    ] as const;

    expect(
      cases.map(([file, step, mark, value]) => refusal(() => markStep(file, "l2", step, mark, value)).code),
    ).toStrictEqual(cases.map(() => "study_mark_refused"));
    expect(refusal(() => markStep(PLANNED, "l2", "s9", "step", true))).toStrictEqual({
      code: "study_not_found",
      params: {},
    });
    expect(refusal(() => markStep(PLANNED, "l3", "s1", "step", true))).toStrictEqual({
      code: "study_not_found",
      params: {},
    });
  });

  it("marks a fixed step done by hand and takes it back", () => {
    const sheet = markStep(PLANNED, "l2", "s3", "step", true);

    expect(steps(sheet)[2]).toStrictEqual({ id: "s3", kind: "sheet", done: { by: "manual" } });
    expect(markStep(sheet, "l2", "s3", "step", false)).toStrictEqual(PLANNED);
  });

  it("keeps fields it does not know on a quiz the agent reports over", () => {
    const file = withStep(PLANNED, "s1", { lesson: { by: "manual" }, quiz: { by: "manual", note: "mine" } });

    expect(steps(report(file, at("quiz", "s1"), { score: 2, of: 4 }))[0]).toMatchObject({
      quiz: { by: "agent", note: "mine", score: 2, of: 4 },
    });
  });

  it("keeps fields it does not know on the step it marks", () => {
    const file = withStep(PLANNED, "s1", { note: "mine", lesson: { by: "agent", at: 1 } });
    const marked = markStep(file, "l2", "s1", "quiz", true);

    expect(steps(marked)[0]).toStrictEqual({
      id: "s1",
      kind: "lesson",
      title: "goroutine",
      note: "mine",
      lesson: { by: "agent", at: 1 },
      quiz: { by: "manual" },
      done: null,
    });
  });
});

/** The progress of a file, which must have a ladder. */
function progress(file: StudyFile) {
  const read = progressOf(file);
  if (read === null) throw new Error("no ladder");
  return read;
}

/** No session open in the direction. */
const NONE: never[] = [];

/** A direction neither archived nor broken, its file of this version. */
const LIVE = { archived: false, broken: false, newer: false };

describe("the next step (SPEC-0008, 下一步怎么算)", () => {
  it("lesson not taught: start the lesson", () => {
    expect(nextOf(progress(PLANNED), NONE, LIVE)).toStrictEqual({
      primary: { type: "start", kind: "lesson", level: "l2", step: "s1", available: true },
      secondary: null,
    });
  });

  it("lesson taught, no quiz: start the quiz, or put it off", () => {
    const taught = report(PLANNED, { kind: "lesson", level: "l2", step: "s1" }, {});

    expect(nextOf(progress(taught), NONE, LIVE)).toStrictEqual({
      primary: { type: "start", kind: "quiz", level: "l2", step: "s1", available: false },
      secondary: { type: "mark", mark: "later", level: "l2", step: "s1" },
    });
  });

  it("quizzed with a gap of this step not fixed: run Feynman on it, or go on", () => {
    const quizzed = report(PLANNED, { kind: "quiz", level: "l2", step: "s1" }, { score: 3, of: 5 });
    const elsewhere = addGap(quizzed, { kind: "exam", level: "l2", step: "s5" }, { text: "other step" });
    const gapped = addGap(elsewhere, { kind: "quiz", level: "l2", step: "s1" }, { text: "x" });
    const fixedFirst = addGap(markGap(gapped, "g2", true), { kind: "quiz", level: "l2", step: "s1" }, { text: "y" });

    expect(nextOf(progress(gapped), NONE, LIVE)).toStrictEqual({
      primary: { type: "start", kind: "feynman", level: "l2", step: "s1", gap: "g2", available: false },
      secondary: { type: "mark", mark: "step", level: "l2", step: "s1" },
    });
    expect(nextOf(progress(fixedFirst), NONE, LIVE).primary).toStrictEqual({
      type: "start",
      kind: "feynman",
      level: "l2",
      step: "s1",
      gap: "g3",
      available: false,
    });
  });

  it("quizzed, by the agent or by hand, with no gap or all fixed: go on", () => {
    const quizzed = report(PLANNED, { kind: "quiz", level: "l2", step: "s1" }, { score: 5, of: 5 });
    const fixed = markGap(addGap(quizzed, { kind: "quiz", level: "l2", step: "s1" }, { text: "x" }), "g1", true);
    const manual = markStep(PLANNED, "l2", "s1", "quiz", true);
    for (const file of [quizzed, fixed, manual]) {
      expect(nextOf(progress(file), NONE, LIVE)).toStrictEqual({
        primary: { type: "mark", mark: "step", level: "l2", step: "s1" },
        secondary: null,
      });
    }
  });

  it("cheat sheet, project, exam not done: start each, available", () => {
    const lessonsDone = markStep(markStep(PLANNED, "l2", "s1", "step", true), "l2", "s2", "step", true);
    const sheetDone = markStep(lessonsDone, "l2", "s3", "step", true);
    const projectDone = markStep(sheetDone, "l2", "s4", "step", true);
    const examDone = markStep(projectDone, "l2", "s5", "step", true);

    expect(
      [lessonsDone, sheetDone, projectDone].map((file) => nextOf(progress(file), NONE, LIVE).primary),
    ).toStrictEqual([
      { type: "start", kind: "sheet", level: "l2", step: "s3", available: true },
      { type: "start", kind: "project", level: "l2", step: "s4", available: true },
      { type: "start", kind: "exam", level: "l2", step: "s5", available: true },
    ]);
    expect(nextOf(progress(examDone), NONE, LIVE)).toStrictEqual({
      primary: { type: "upgrade", level: "l2", available: false },
      secondary: null,
    });
  });

  it("goes back to the session open for this step, the latest, archived ones left out", () => {
    const sessions = [
      { sessionId: "old", study: { kind: "lesson" as const, level: "l2", step: "s1" }, updatedAt: 1, archived: false },
      { sessionId: "new", study: { kind: "lesson" as const, level: "l2", step: "s1" }, updatedAt: 3, archived: false },
      { sessionId: "gone", study: { kind: "lesson" as const, level: "l2", step: "s1" }, updatedAt: 9, archived: true },
      {
        sessionId: "other",
        study: { kind: "lesson" as const, level: "l2", step: "s2" },
        updatedAt: 9,
        archived: false,
      },
      { sessionId: "ask", study: { kind: "ask" as const }, updatedAt: 9, archived: false },
      { sessionId: "none", study: null, updatedAt: 9, archived: false },
    ];

    expect(nextOf(progress(PLANNED), sessions, LIVE)).toStrictEqual({
      primary: { type: "open", sessionId: "new" },
      secondary: null,
    });
    const taught = report(PLANNED, { kind: "lesson", level: "l2", step: "s1" }, {});

    expect(nextOf(progress(taught), sessions, LIVE).primary).toStrictEqual({
      type: "start",
      kind: "quiz",
      level: "l2",
      step: "s1",
      available: false,
    });
    const quiz = [
      { sessionId: "q", study: { kind: "quiz" as const, level: "l2", step: "s1" }, updatedAt: 1, archived: false },
    ];

    expect(nextOf(progress(taught), quiz, LIVE)).toStrictEqual({
      primary: { type: "open", sessionId: "q" },
      secondary: { type: "mark", mark: "later", level: "l2", step: "s1" },
    });
  });

  it("offers nothing archived, broken, of a later version, finished, without a current level or without its steps", () => {
    const empty = { primary: null, secondary: null };

    expect(nextOf(progress(PLANNED), NONE, { ...LIVE, archived: true })).toStrictEqual(empty);
    expect(nextOf(progress(PLANNED), NONE, { ...LIVE, broken: true })).toStrictEqual(empty);
    // A file of a later version is read, not written: nothing to press.
    expect(nextOf(progress(PLANNED), NONE, { ...LIVE, newer: true })).toStrictEqual(empty);
    expect(nextOf(null, NONE, LIVE)).toStrictEqual(empty);
    expect(nextOf(progress({ ...PLANNED, finishedAt: "2026-12-01T00:00:00.000Z" }), NONE, LIVE)).toStrictEqual(empty);
    const noSteps: StudyFile = { ...PLANNED, steps: {} };

    expect(nextOf(progress(noSteps), NONE, LIVE)).toStrictEqual(empty);
    const noCurrent = withStates(PLANNED, { l1: "done", l2: "done", l3: "done" });

    expect(nextOf(progress(noCurrent), NONE, LIVE)).toStrictEqual(empty);
    const allDone: StudyFile = {
      ...PLANNED,
      steps: { l2: steps(PLANNED).map((step) => ({ ...step, done: { by: "manual" as const } })) },
    };

    expect(nextOf(progress(allDone), NONE, LIVE)).toStrictEqual(empty);
  });
});
