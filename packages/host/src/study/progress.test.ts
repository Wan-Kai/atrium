import { present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { parseStudyFile, progressOf } from "./progress";

/** A lesson as the file holds it, with a field Atrium does not know. */
const LESSON = { id: "s1", kind: "lesson", title: "goroutine", lesson: null, quiz: null, done: null, mine: 1 };

/** A file with a ladder and something of every kind in it. */
const FULL = {
  version: 1,
  name: "Go",
  createdAt: "2026-11-09T00:00:00.000Z",
  profile: { goal: "爬虫", weeklyHours: "4", language: "Go", extra: true },
  ladder: [
    { id: "l1", name: "语法", topics: "类型", pass: "工具", state: "skipped" },
    { id: "l2", name: "并发", topics: "goroutine", pass: "爬虫", state: "current", note: "x" },
  ],
  steps: {
    l2: [
      { ...LESSON, lesson: { by: "agent", at: 1 }, quiz: { by: "agent", score: 5, of: 5 }, done: { by: "manual" } },
      { ...LESSON, id: "s2", lesson: { by: "manual" }, quiz: { by: "manual" } },
      { ...LESSON, id: "s3", lesson: { by: "agent" }, quiz: { by: "later" }, done: { by: "manual" } },
      { id: "s4", kind: "sheet", done: { by: "agent" } },
      { id: "s5", kind: "exam", done: { by: "agent", score: 8, of: 10 } },
      { id: "s6", kind: "up", done: null },
    ],
  },
  gaps: [
    { id: "g1", text: "x", from: { level: "l2", step: "s1", question: 3 }, fixed: null },
    { id: "g2", text: "y", from: { level: "l2", step: "s1" }, fixed: { by: "manual" } },
  ],
  finishedAt: "2026-12-01T00:00:00.000Z",
};

/**
 * Whether a file with `change` made to `FULL` still reads.
 *
 * @remarks
 * For the bounds and shapes one at a time.
 *
 * @sideEffects none
 * @param change - What to change.
 * @returns Whether it reads.
 */
function reads(change: Record<string, unknown>): boolean {
  return parseStudyFile(JSON.stringify({ ...FULL, ...change })) !== null;
}

/**
 * Whether a file whose second level's steps are `steps` reads.
 *
 * @remarks
 * See `reads`.
 *
 * @sideEffects none
 * @param list - The steps.
 * @returns Whether it reads.
 */
function readsSteps(list: readonly unknown[]): boolean {
  return reads({ steps: { l2: list } });
}

/** A level not reached yet. */
function level(id: string) {
  return { id, name: "x", topics: "", pass: "", state: "todo" };
}

/** That many lessons. */
function steps(count: number) {
  return Array.from({ length: count }, (_, at) => ({ ...LESSON, id: `s${String(at)}` }));
}

describe("parseStudyFile and progressOf (SPEC-0008, ML2)", () => {
  it("reads every kind of step, mark and gap, and sends only what the protocol knows", () => {
    const file = parseStudyFile(JSON.stringify(FULL));

    expect(file).toStrictEqual(FULL);
    expect(progressOf(present(file, "the file"))).toStrictEqual({
      profile: { goal: "爬虫", weeklyHours: "4", language: "Go" },
      ladder: [
        { id: "l1", name: "语法", topics: "类型", pass: "工具", state: "skipped" },
        { id: "l2", name: "并发", topics: "goroutine", pass: "爬虫", state: "current" },
      ],
      steps: {
        l2: [
          {
            id: "s1",
            kind: "lesson",
            title: "goroutine",
            lesson: { by: "agent" },
            quiz: { by: "agent", score: 5, of: 5 },
            done: { by: "manual" },
          },
          {
            id: "s2",
            kind: "lesson",
            title: "goroutine",
            lesson: { by: "manual" },
            quiz: { by: "manual" },
            done: null,
          },
          {
            id: "s3",
            kind: "lesson",
            title: "goroutine",
            lesson: { by: "agent" },
            quiz: { by: "later" },
            done: { by: "manual" },
          },
          { id: "s4", kind: "sheet", done: { by: "agent" } },
          { id: "s5", kind: "exam", done: { by: "agent", score: 8, of: 10 } },
          { id: "s6", kind: "up", done: null },
        ],
      },
      gaps: [
        { id: "g1", text: "x", from: { level: "l2", step: "s1", question: 3 }, fixed: null },
        { id: "g2", text: "y", from: { level: "l2", step: "s1" }, fixed: { by: "manual" } },
      ],
      finishedAt: "2026-12-01T00:00:00.000Z",
    });
  });

  it("sends a file of no ladder as none, and one without profile, steps or gaps with empty ones", () => {
    const bare = parseStudyFile(JSON.stringify({ version: 1, name: "Go" }));

    expect(bare).toStrictEqual({ version: 1, name: "Go" });
    expect(progressOf(present(bare, "the file"))).toBeNull();
    const ladder = parseStudyFile(JSON.stringify({ version: 1, name: "Go", ladder: FULL.ladder }));

    expect(progressOf(present(ladder, "the file"))).toStrictEqual({
      profile: {},
      ladder: FULL.ladder.map(({ id, name, topics, pass, state }) => ({ id, name, topics, pass, state })),
      steps: {},
      gaps: [],
      finishedAt: null,
    });
  });

  it("reads marks only with who made them, and scores only up to their total", () => {
    expect(
      [
        { ...LESSON, lesson: {} },
        { ...LESSON, lesson: { by: "me" } },
        { ...LESSON, quiz: { by: "agent", score: 6, of: 5 } },
        { ...LESSON, quiz: { by: "agent" } },
        { ...LESSON, quiz: { by: "skipped" } },
        { ...LESSON, quiz: { by: "agent", score: 1, of: 101 } },
        { ...LESSON, title: "x".repeat(121) },
        { id: "s9", kind: "exam", done: {} },
        { id: "s9", kind: "exam", done: { by: "agent", score: 8 } },
        { id: "s9", kind: "exam", done: { by: "agent", of: 8 } },
        { id: "s9", kind: "exam", done: { by: "agent", score: 9, of: 8 } },
        { id: "s9", kind: "nap", done: null },
      ].map((step) => readsSteps([step])),
    ).toStrictEqual(Array.from({ length: 12 }, () => false));
    expect(
      [
        { ...LESSON, quiz: { by: "agent", score: 0, of: 1 } },
        { ...LESSON, quiz: { by: "later" } },
        { ...LESSON, title: "x".repeat(120) },
        { id: "s9", kind: "exam", done: { by: "manual" } },
        { id: "s9", kind: "exam", done: { by: "agent", score: 8, of: 8 } },
      ].map((step) => readsSteps([step])),
    ).toStrictEqual(Array.from({ length: 5 }, () => true));
  });

  it("reads 2 to 6 levels, at most 34 steps a level, ids once each, steps only of the ladder's levels", () => {
    expect(
      [
        { ladder: [level("l2")], steps: {} },
        { ladder: ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].map(level) },
        { ladder: [level("l2"), level("l2")] },
        { steps: { l9: [] } },
        { steps: { l2: steps(35) } },
        { steps: { l2: [LESSON, LESSON] } },
        { gaps: [FULL.gaps[0], FULL.gaps[0]] },
        { ladder: [level("l1"), { ...level("l2"), state: "passed" }] },
        { ladder: [level("l1"), { ...level("l2"), name: "x".repeat(61) }] },
      ].map((change) => reads(change)),
    ).toStrictEqual(Array.from({ length: 9 }, () => false));
    expect(
      [
        { ladder: [level("l1"), level("l2")] },
        { ladder: ["l1", "l2", "l3", "l4", "l5", "l6"].map(level), steps: {} },
        { steps: { l2: steps(34) } },
        { ladder: [level("l1"), { ...level("l2"), name: "x".repeat(60) }], steps: {} },
      ].map((change) => reads(change)),
    ).toStrictEqual(Array.from({ length: 4 }, () => true));
  });

  it("bounds texts by characters as seen, a joined emoji one", () => {
    const family = "👨‍👩‍👧";

    expect(readsSteps([{ ...LESSON, title: family.repeat(120) }])).toBe(true);
    expect(readsSteps([{ ...LESSON, title: family.repeat(121) }])).toBe(false);
    expect(reads({ gaps: [{ ...FULL.gaps[0], text: family.repeat(1000) }] })).toBe(true);
  });

  it("reads names, profiles and dates within their bounds, and nothing that is not JSON", () => {
    expect(
      [
        { name: "  " },
        { name: "x".repeat(257) },
        { version: 0 },
        { profile: { goal: "x".repeat(201) } },
        { profile: { weeklyHours: "x".repeat(201) } },
        { profile: { language: "x".repeat(201) } },
        { finishedAt: "x".repeat(65) },
        { gaps: [{ ...FULL.gaps[0], text: "" }] },
        { gaps: [{ ...FULL.gaps[0], from: { level: "l2", step: "s1", question: 0 } }] },
      ].map((change) => reads(change)),
    ).toStrictEqual(Array.from({ length: 9 }, () => false));
    expect(
      [
        { name: "x".repeat(256) },
        { profile: { goal: "x".repeat(200), weeklyHours: "", language: "x".repeat(200) } },
        { finishedAt: "x".repeat(64) },
        { finishedAt: null },
      ].map((change) => reads(change)),
    ).toStrictEqual(Array.from({ length: 4 }, () => true));
    expect(parseStudyFile("{")).toBeNull();
    expect(parseStudyFile("[]")).toBeNull();
  });
});
