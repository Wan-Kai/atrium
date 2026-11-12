import type { Direction, SessionSummary, StudyProgress } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { type HomeDots, archivedDirections, archivedLine, continueCard, directionCard, lastLine } from "./home-view";

/** 2026-11-10 12:00 local time, the tests' now. */
const NOW = new Date(2026, 10, 10, 12, 0).getTime();

/** Three levels, the first skipped; the second current at its third step, a lesson. */
const PROGRESS: StudyProgress = {
  profile: {},
  ladder: [
    { id: "l1", name: "语法", topics: "", pass: "", state: "skipped" },
    { id: "l2", name: "所有权", topics: "", pass: "", state: "current" },
    { id: "l3", name: "trait", topics: "", pass: "", state: "todo" },
  ],
  steps: {
    l2: [
      { id: "s1", kind: "lesson", title: "移动", lesson: { by: "agent" }, quiz: null, done: { by: "agent" } },
      {
        id: "s2",
        kind: "lesson",
        title: "借用规则",
        lesson: { by: "agent" },
        quiz: { by: "agent", score: 32, of: 50 },
        done: { by: "agent" },
      },
      { id: "s3", kind: "lesson", title: "生命周期", lesson: null, quiz: null, done: null },
      { id: "s4", kind: "sheet", done: null },
      { id: "s5", kind: "project", done: null },
      { id: "s6", kind: "exam", done: null },
      { id: "s7", kind: "up", done: null },
    ],
  },
  gaps: [{ id: "g1", text: "x", from: { level: "l2", step: "s2" }, fixed: null }],
  finishedAt: null,
};

/** The next step of `PROGRESS`: its third lesson. */
const START = { type: "start", kind: "lesson", level: "l2", step: "s3", available: true } as const;

/**
 * A direction of the list, learning `PROGRESS`.
 *
 * @remarks
 * Fields a test does not care about keep the defaults.
 *
 * @sideEffects none
 * @param more - What the test changes.
 * @returns The direction.
 */
function direction(more: Partial<Direction> = {}): Direction {
  return {
    id: "lrn_rust",
    dir: "/L/rust",
    name: "Rust",
    alias: null,
    broken: false,
    newer: false,
    discussing: false,
    archived: false,
    createdAt: 1,
    pinnedAt: null,
    lastOpenedAt: 2,
    progress: PROGRESS,
    next: { primary: START, secondary: null },
    ...more,
  };
}

/**
 * A session of the direction, of a use, last active at a time.
 *
 * @remarks
 * Only the fields the learning home reads.
 *
 * @sideEffects none
 * @param sessionId - Its id.
 * @param more - What the test changes.
 * @returns The session.
 */
function session(sessionId: string, more: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    containerId: "lrn_rust",
    name: null,
    prompt: null,
    state: "saved",
    archived: false,
    running: false,
    asking: null,
    attention: null,
    updatedAt: NOW - 60_000,
    study: null,
    parent: null,
    ...more,
  } as SessionSummary;
}

/** The upgrade's next step: every step but the upgrade done. */
const UPGRADE: StudyProgress = {
  ...PROGRESS,
  steps: {
    l2: (PROGRESS.steps["l2"] ?? []).map((step) =>
      step.kind === "up"
        ? step
        : step.kind === "lesson"
          ? { ...step, done: { by: "agent" as const } }
          : { ...step, done: { by: "agent" as const } },
    ),
  },
};

/** Finished: every level done or skipped. */
const FINISHED: StudyProgress = {
  ...UPGRADE,
  ladder: PROGRESS.ladder.map((level) => ({ ...level, state: level.state === "skipped" ? "skipped" : "done" })),
  steps: {
    l2: (UPGRADE.steps["l2"] ?? []).map((step) => ({ ...step, done: { by: "agent" as const } })),
    l3: (UPGRADE.steps["l2"] ?? []).map((step) => ({ ...step, done: { by: "agent" as const } })),
  },
  finishedAt: "2026-11-09T00:00:00Z",
};

/** The current level is the third, not planned yet. */
const UNPLANNED: StudyProgress = {
  ...PROGRESS,
  ladder: [
    PROGRESS.ladder[0]!,
    { ...PROGRESS.ladder[1]!, state: "done" },
    { ...PROGRESS.ladder[2]!, state: "current" },
  ],
  steps: { ...PROGRESS.steps, l3: [] },
};

/** The second level's steps with its exam done, scored 82 of 100. */
const EXAMINED = [
  ...(PROGRESS.steps["l2"] ?? []).slice(0, 5),
  { id: "s6", kind: "exam", done: { by: "agent", score: 82, of: 100 } },
  { id: "s7", kind: "up", done: null },
] satisfies StudyProgress["steps"][string];

/**
 * The dots of a card as shape and state, for comparing.
 *
 * @remarks
 * Only a level's dots have them; a broken file's and none are `null`.
 *
 * @sideEffects none
 * @param dots - The card's dots.
 * @returns The dots, or `null`.
 */
function stepDots(dots: HomeDots | null): [boolean, string][] | null {
  return dots?.kind === "steps" ? dots.dots.map((dot) => [dot.round, dot.state]) : null;
}

describe("the continue card (SPEC-0008, ML4)", () => {
  it("says the next step: the direction, level and step above, its title, the strip's dots and its primary", () => {
    const card = continueCard(direction(), [], NOW);

    expect(card).toMatchObject({
      eyebrow: "Rust · 第 2 级 · 第 3 步",
      warn: false,
      big: "生命周期",
      desc: null,
      primary: START,
      running: false,
      last: null,
      dots: { kind: "steps", look: "learning" },
    });
    expect(stepDots(card.dots)).toStrictEqual([
      [false, "done"],
      [false, "done"],
      [false, "current"],
      [true, "todo"],
      [true, "todo"],
      [true, "todo"],
      [true, "todo"],
    ]);
  });

  it("goes back to the session open for the step, with the dot of one running", () => {
    const open = { type: "open", sessionId: "lesson-1" } as const;
    const lesson = session("lesson-1", { running: true, study: { kind: "lesson", level: "l2", step: "s3" } });

    expect(continueCard(direction({ next: { primary: open, secondary: null } }), [lesson], NOW)).toMatchObject({
      primary: open,
      running: true,
    });
    expect(
      continueCard(direction({ next: { primary: open, secondary: null } }), [{ ...lesson, running: false }], NOW),
    ).toMatchObject({ running: false });
  });

  it("names the upgrade by the level it goes to, and the last one as finishing", () => {
    const up = { type: "upgrade", level: "l2", available: true } as const;
    const upgrade = direction({ progress: UPGRADE, next: { primary: up, secondary: null } });
    const last: StudyProgress = { ...UPGRADE, ladder: UPGRADE.ladder.slice(0, 2) };

    expect(continueCard(upgrade, [], NOW)).toMatchObject({
      eyebrow: "Rust · 第 2 级 · 第 7 步",
      big: "升到第 3 级",
      primary: up,
    });
    expect(continueCard(direction({ progress: last, next: { primary: up, secondary: null } }), [], NOW).big).toBe(
      "学完最后一级",
    );
  });

  it("offers only opening a finished direction, one under discussion, a broken one or a newer one", () => {
    const finished = continueCard(direction({ progress: FINISHED, next: { primary: null, secondary: null } }), [], NOW);
    const discussing = continueCard(direction({ progress: null, discussing: true }), [], NOW);
    const broken = continueCard(direction({ progress: null, broken: true, discussing: true }), [], NOW);
    const newer = continueCard(direction({ newer: true }), [], NOW);

    expect(finished).toMatchObject({
      eyebrow: "Rust",
      big: "已学完 · 共 3 级",
      primary: null,
      dots: { kind: "steps", look: "finished" },
    });
    expect(discussing).toMatchObject({
      eyebrow: "Rust · 讨论中",
      big: "还没排出阶梯",
      primary: null,
      dots: null,
      warn: false,
    });
    expect(broken).toStrictEqual({
      eyebrow: "Rust",
      warn: true,
      big: "档案读不出来",
      desc: ".atrium-study.json 不是能读的格式，文件没有被改动",
      dots: { kind: "broken", count: 13 },
      primary: null,
      running: false,
      last: null,
    });
    expect(newer).toMatchObject({
      eyebrow: "Rust · 第 2 级 · 第 3 步",
      big: "生命周期",
      desc: "档案是更新版本的 Atrium 写的，只能看",
      primary: null,
      last: null,
      dots: { kind: "steps", look: "newer" },
    });
  });

  it("says a level not planned yet, or being planned, with the plan's button and no dots", () => {
    const plan = { type: "start", kind: "plan", level: "l3", available: true } as const;
    const open = { type: "open", sessionId: "plan-1" } as const;

    expect(
      continueCard(direction({ progress: UNPLANNED, next: { primary: plan, secondary: null } }), [], NOW),
    ).toMatchObject({
      eyebrow: "Rust · 第 3 级",
      big: "还没排课",
      dots: null,
      primary: plan,
    });
    expect(
      continueCard(direction({ progress: UNPLANNED, next: { primary: open, secondary: null } }), [], NOW).big,
    ).toBe("排计划中");
  });

  it("says a newer file with no lessons in its level is only to be read, without the last session", () => {
    const newer = direction({ newer: true, progress: UNPLANNED, next: { primary: null, secondary: null } });

    expect(continueCard(newer, [session("x", { name: "随口问的" })], NOW)).toStrictEqual({
      eyebrow: "Rust · 第 3 级",
      warn: false,
      big: "还没排课",
      desc: "档案是更新版本的 Atrium 写的，只能看",
      dots: null,
      primary: null,
      running: false,
      last: null,
    });
  });

  it("uses the display name the user gave", () => {
    expect(continueCard(direction({ alias: "我的 Rust" }), [], NOW).eyebrow).toBe("我的 Rust · 第 2 级 · 第 3 步");
  });
});

describe("the continue card's last line (SPEC-0008, ML4)", () => {
  it("names the latest session not archived, when, and a quiz's or an exam's score", () => {
    const quiz = session("q", { updatedAt: NOW - 26 * 3600_000, study: { kind: "quiz", level: "l2", step: "s2" } });
    const older = session("o", { updatedAt: NOW - 50 * 3600_000, name: "早先" });
    const archived = session("a", { updatedAt: NOW - 1000, archived: true, name: "归档了" });
    const exam: StudyProgress = { ...PROGRESS, steps: { l2: EXAMINED } };
    const examSession = session("e", { updatedAt: NOW - 120_000, study: { kind: "exam", level: "l2", step: "s6" } });

    expect(lastLine(direction(), [older, quiz, archived], NOW)).toBe("上次：昨天 · 测验 · 借用规则 32/50");
    expect(lastLine(direction({ progress: exam }), [examSession], NOW)).toBe(
      "上次：2 分钟前 · 综合测验 · 第 2 级 82/100",
    );
    expect(lastLine(direction(), [session("x", { name: "随口问的" })], NOW)).toBe("上次：1 分钟前 · 随口问的");
    expect(lastLine(direction(), [archived], NOW)).toBeNull();
    expect(lastLine(direction(), [session("x", { containerId: "lrn_go", name: "别处" })], NOW)).toBeNull();
  });

  it("goes on the card of a direction learning, finished or under discussion, not a broken or newer one", () => {
    const one = [session("x", { name: "随口问的" })];

    expect(continueCard(direction(), one, NOW).last).toBe("上次：1 分钟前 · 随口问的");
    expect(continueCard(direction({ progress: null, discussing: true }), one, NOW).last).toBe(
      "上次：1 分钟前 · 随口问的",
    );
    expect(continueCard(direction({ newer: true }), one, NOW).last).toBeNull();
    expect(continueCard(direction({ broken: true, progress: null }), one, NOW).last).toBeNull();
  });
});

describe("a direction's card (SPEC-0008, ML4)", () => {
  it("says where a direction stands, with its dots, in each state", () => {
    const plan = { type: "start", kind: "plan", level: "l3", available: true } as const;
    const cards = [
      direction(),
      direction({ progress: null, discussing: true }),
      direction({ progress: null, discussing: true, broken: true }),
      direction({ progress: FINISHED }),
      direction({ progress: UNPLANNED, next: { primary: plan, secondary: null } }),
      direction({ newer: true }),
    ].map((one) => directionCard(one, []));

    expect(cards.map(({ tag, line, warn, dots }) => [tag, line, warn, dots])).toMatchObject([
      [null, "共 3 级 · 第 2 级第 3 步 · 漏洞 1", false, { kind: "steps" }],
      ["讨论中", "还没排出阶梯", false, null],
      [null, "档案读不出来", true, { kind: "broken" }],
      [null, "已学完 · 共 3 级", false, { kind: "steps" }],
      [null, "第 3 级 · 还没排课", false, null],
      [null, "共 3 级 · 第 2 级第 3 步 · 漏洞 1 · 只能看", false, { kind: "steps" }],
    ]);
    expect(cards[3]?.dots).toMatchObject({ kind: "steps", look: "finished" });
  });

  it("says a newer file with no lessons in its level is only to be read", () => {
    const newer = direction({ newer: true, progress: UNPLANNED, next: { primary: null, secondary: null } });

    expect(directionCard(newer, [])).toStrictEqual({
      mark: null,
      tag: null,
      warn: false,
      line: "第 3 级 · 还没排课 · 只能看",
      dots: null,
    });
  });

  it("marks a session waiting for you over one running, among its sessions not archived only", () => {
    const running = session("r", { running: true });
    const asking = session("a", { asking: 1 });

    expect(
      [[], [running], [running, asking], [{ ...asking, archived: true }], [{ ...running, containerId: "lrn_go" }]].map(
        (sessions) => directionCard(direction(), sessions).mark,
      ),
    ).toStrictEqual([null, "running", "asking", null, null]);
  });
});

describe("the archived directions (SPEC-0008, ML4)", () => {
  it("says where each stopped", () => {
    expect(
      [
        direction({ archived: true }),
        direction({ archived: true, progress: null, discussing: true }),
        direction({ archived: true, progress: FINISHED }),
        direction({ archived: true, progress: null, broken: true }),
        direction({ archived: true, progress: UNPLANNED }),
      ].map(archivedLine),
    ).toStrictEqual(["停在第 2 级第 3 步", "讨论中", "已学完", "档案读不出来", "停在第 3 级"]);
  });

  it("lists only the archived, the one opened last first, then the newest made", () => {
    const listed = archivedDirections([
      direction({ id: "lrn_a", archived: true, lastOpenedAt: null, createdAt: 5 }),
      direction({ id: "lrn_b", archived: false, lastOpenedAt: 9 }),
      direction({ id: "lrn_c", archived: true, lastOpenedAt: 3, createdAt: 1 }),
      direction({ id: "lrn_d", archived: true, lastOpenedAt: null, createdAt: 7 }),
      direction({ id: "lrn_e", archived: true, lastOpenedAt: null, createdAt: 7 }),
      direction({ id: "lrn_f", archived: true, lastOpenedAt: null, createdAt: null }),
    ]);

    expect(listed.map(({ id }) => id)).toStrictEqual(["lrn_c", "lrn_d", "lrn_e", "lrn_a", "lrn_f"]);
  });
});
