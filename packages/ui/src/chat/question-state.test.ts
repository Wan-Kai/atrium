import type { AskedQuestion } from "@atrium/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  type QuestionDraft,
  answered,
  choose,
  forgetDrafts,
  nextUnanswered,
  readDraft,
  replyOf,
  writeDraft,
} from "./question-state";

/** A single-choice question of two options. */
const scope: AskedQuestion = {
  header: "范围",
  question: "改到哪？",
  multiSelect: false,
  options: [
    { label: "收件箱", description: "", preview: null, recommended: true },
    { label: "侧栏", description: "", preview: null, recommended: false },
  ],
};

/** A multiple-choice question of three options. */
const tests: AskedQuestion = {
  header: "测试",
  question: "补哪些？",
  multiSelect: true,
  options: [
    { label: "单元", description: "", preview: null, recommended: false },
    { label: "组件", description: "", preview: null, recommended: false },
    { label: "端到端", description: "", preview: null, recommended: false },
  ],
};

/** Nothing picked. */
const none = { selected: [], other: null } as const;

describe("choose", () => {
  it("picks one option of a single-choice question, the other answer among them, keeping what was written", () => {
    const first = choose(scope, none, 1);
    const other = choose(scope, first, 2);
    const written = { ...other, other: "放在设置上面" };

    expect(first).toStrictEqual({ selected: [1], other: null });
    expect(other).toStrictEqual({ selected: [], other: "" });
    expect(choose(scope, written, 2)).toStrictEqual({ selected: [], other: "放在设置上面" });
    expect(choose(scope, written, 0)).toStrictEqual({ selected: [0], other: null, kept: "放在设置上面" });
  });

  it("toggles options of a multiple-choice question in order, and the other answer beside them", () => {
    const two = choose(tests, choose(tests, none, 2), 0);
    const withOther = choose(tests, two, 3);

    expect(two).toStrictEqual({ selected: [0, 2], other: null });
    expect(choose(tests, two, 2)).toStrictEqual({ selected: [0], other: null });
    expect(withOther).toStrictEqual({ selected: [0, 2], other: "" });
    expect(choose(tests, { ...withOther, other: "基准" }, 3)).toStrictEqual({
      selected: [0, 2],
      other: null,
      kept: "基准",
    });
    expect(choose(tests, { selected: [0], other: null, kept: "基准" }, 1)).toStrictEqual({
      selected: [0, 1],
      other: null,
      kept: "基准",
    });
  });
});

describe("choose, keeping what was written", () => {
  it("keeps the other answer's text when it is unpicked and picked again, on either kind of question", () => {
    const written = { selected: [0], other: "加一个基准" };
    const unticked = choose(tests, written, 3);
    const elsewhere = choose(scope, { selected: [], other: "设置上面" }, 1);

    expect(unticked).toMatchObject({ selected: [0], other: null });
    expect(choose(tests, unticked, 3)).toMatchObject({ selected: [0], other: "加一个基准" });
    expect(elsewhere).toMatchObject({ selected: [1], other: null });
    expect(choose(scope, elsewhere, 2)).toMatchObject({ selected: [], other: "设置上面" });
  });

  it("keeps nothing for an other answer left empty, and keeps what it kept as another option is picked", () => {
    expect(choose(tests, { selected: [0], other: "" }, 3)).toStrictEqual({ selected: [0], other: null });
    expect(choose(scope, { selected: [1], other: null, kept: "设置上面" }, 0)).toStrictEqual({
      selected: [0],
      other: null,
      kept: "设置上面",
    });
  });
});

describe("answered", () => {
  it("counts a question answered by a pick, or by the other answer once something is written", () => {
    expect([
      answered(scope, none),
      answered(scope, { selected: [0], other: null }),
      answered(scope, { selected: [], other: "" }),
      answered(scope, { selected: [], other: "  " }),
      answered(scope, { selected: [], other: "x" }),
      answered(tests, { selected: [1], other: "" }),
    ]).toStrictEqual([false, true, false, false, true, false]);
  });
});

describe("nextUnanswered", () => {
  it("finds the next question without an answer after one, coming round, or none", () => {
    const picks = [none, { selected: [0], other: null }, none];
    const questions = [scope, tests, scope];

    expect(nextUnanswered(questions, picks, 0)).toBe(2);
    expect(nextUnanswered(questions, picks, 2)).toBe(0);
    expect(nextUnanswered([scope], [{ selected: [0], other: null }], 0)).toBeNull();
    expect(nextUnanswered([scope], [none], 0)).toBe(0);
  });
});

describe("replyOf", () => {
  it("gives the answers once every question has one, the other answer trimmed, and nothing before", () => {
    expect(replyOf([scope, tests], [{ selected: [1], other: null }, none])).toBeNull();
    expect(
      replyOf(
        [scope, tests],
        [
          { selected: [], other: " 设置上面 " },
          { selected: [0, 1], other: null },
        ],
      ),
    ).toStrictEqual({
      answers: [
        { selected: [], other: "设置上面" },
        { selected: [0, 1], other: null },
      ],
    });
  });
});

describe("drafts", () => {
  afterEach(() => forgetDrafts("s1", null));

  it("keeps a session's picks for its question, and forgets them once it asks another or none", () => {
    const draft: QuestionDraft = { current: 1, picks: [{ selected: [0], other: null }, none] };

    writeDraft("s1", "call-1", draft);
    writeDraft("s2", "call-1", { current: 0, picks: [none] });

    expect(readDraft("s1", "call-1", 2)).toStrictEqual(draft);
    expect(readDraft("s1", "call-2", 2)).toStrictEqual({ current: 0, picks: [none, none] });
    forgetDrafts("s1", "call-1");
    expect(readDraft("s1", "call-1", 2)).toStrictEqual(draft);
    forgetDrafts("s1", "call-2");
    expect(readDraft("s1", "call-1", 2)).toStrictEqual({ current: 0, picks: [none, none] });
    expect(readDraft("s2", "call-1", 1)).toStrictEqual({ current: 0, picks: [none] });
    forgetDrafts("s2", null);
    expect(readDraft("s2", "call-1", 1)).toStrictEqual({ current: 0, picks: [none] });
  });

  it("starts afresh when the questions kept do not match in number", () => {
    writeDraft("s1", "call-1", { current: 0, picks: [{ selected: [0], other: null }] });

    expect(readDraft("s1", "call-1", 2)).toStrictEqual({ current: 0, picks: [none, none] });
  });
});
