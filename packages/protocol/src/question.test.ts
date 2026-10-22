import { describe, expect, it } from "vitest";
import { AskedQuestion, PendingQuestion, QUESTION_LIMITS, QuestionReply, answersQuestion } from "./question";

/** A single-choice question with three choices. */
const single: AskedQuestion = {
  header: "范围",
  question: "改到哪为止？",
  multiSelect: false,
  options: [
    { label: "只改收件箱", description: "别处不动", preview: null, recommended: true },
    { label: "收件箱和项目列表", description: "多改 3 个文件", preview: null, recommended: false },
    { label: "整个侧栏", description: "改动大", preview: null, recommended: false },
  ],
};

/** The same choices, any number of them. */
const multi: AskedQuestion = { ...single, header: "测试", multiSelect: true };

describe("answersQuestion", () => {
  it.each([
    ["one choice", { selected: [1], other: null }],
    ["only the other answer", { selected: [], other: "放在设置上面" }],
  ])("takes %s for a single-choice question", (_name, answer) => {
    expect(answersQuestion(single, answer)).toBe(true);
  });

  it.each([
    ["nothing", { selected: [], other: null }],
    ["two choices", { selected: [0, 1], other: null }],
    ["a choice and the other answer", { selected: [0], other: "也行" }],
    ["a choice past the last", { selected: [3], other: null }],
    ["a negative choice", { selected: [-1], other: null }],
    ["an other answer of blanks", { selected: [], other: " \n\t" }],
  ])("refuses %s for a single-choice question", (_name, answer) => {
    expect(answersQuestion(single, answer)).toBe(false);
  });

  it.each([
    ["one choice", { selected: [2], other: null }],
    ["every choice", { selected: [0, 1, 2], other: null }],
    ["choices and the other answer", { selected: [0, 2], other: "再加一个基准" }],
    ["only the other answer", { selected: [], other: "都不要" }],
  ])("takes %s for a multiple-choice question", (_name, answer) => {
    expect(answersQuestion(multi, answer)).toBe(true);
  });

  it.each([
    ["nothing", { selected: [], other: null }],
    ["a choice twice", { selected: [1, 1], other: null }],
    ["a choice past the last", { selected: [0, 3], other: null }],
    ["a choice and an empty other answer", { selected: [0], other: "" }],
  ])("refuses %s for a multiple-choice question", (_name, answer) => {
    expect(answersQuestion(multi, answer)).toBe(false);
  });
});

describe("PendingQuestion", () => {
  /** A question at each limit (SPEC-0003, "工具"). */
  const widest: AskedQuestion = {
    header: "长".repeat(QUESTION_LIMITS.header),
    question: "问".repeat(QUESTION_LIMITS.question),
    multiSelect: false,
    options: Array.from({ length: QUESTION_LIMITS.options }, (_, index) => ({
      label: `${String(index)}${"选".repeat(QUESTION_LIMITS.label - 1)}`,
      description: "说".repeat(QUESTION_LIMITS.description),
      preview: "预".repeat(QUESTION_LIMITS.preview),
      recommended: index === 0,
    })),
  };

  it("takes one to four questions of two to four choices, each text at its limit", () => {
    expect(QUESTION_LIMITS).toStrictEqual({
      questions: 4,
      options: 4,
      header: 12,
      question: 1000,
      label: 60,
      description: 300,
      preview: 4000,
      other: 4000,
    });
    expect(PendingQuestion.safeParse({ id: "call-1", askedAt: 5, questions: [single] }).success).toBe(true);
    expect(
      PendingQuestion.safeParse({ id: "call-1", askedAt: 5, questions: Array.from({ length: 4 }, () => widest) })
        .success,
    ).toBe(true);
  });

  it.each([
    ["no question", { questions: [] }],
    ["five questions", { questions: Array.from({ length: 5 }, () => single) }],
    ["one choice", { questions: [{ ...single, options: single.options.slice(0, 1) }] }],
    ["five choices", { questions: [{ ...single, options: [...single.options, ...single.options.slice(0, 2)] }] }],
    ["a header too long", { questions: [{ ...single, header: "长".repeat(QUESTION_LIMITS.header + 1) }] }],
    ["an empty header", { questions: [{ ...single, header: "" }] }],
    ["a question too long", { questions: [{ ...single, question: "问".repeat(QUESTION_LIMITS.question + 1) }] }],
    ["an empty question", { questions: [{ ...single, question: "" }] }],
    [
      "a label too long",
      {
        questions: [
          {
            ...single,
            options: [{ ...widest.options[0], label: "选".repeat(QUESTION_LIMITS.label + 1) }, ...single.options],
          },
        ],
      },
    ],
    [
      "an empty label",
      { questions: [{ ...single, options: [{ ...single.options[0], label: "" }, ...single.options] }] },
    ],
    [
      "a description too long",
      {
        questions: [
          {
            ...single,
            options: [
              { ...single.options[0], description: "说".repeat(QUESTION_LIMITS.description + 1) },
              ...single.options,
            ],
          },
        ],
      },
    ],
    [
      "a preview too long",
      {
        questions: [
          {
            ...single,
            options: [{ ...single.options[0], preview: "预".repeat(QUESTION_LIMITS.preview + 1) }, ...single.options],
          },
        ],
      },
    ],
  ])("refuses %s", (_name, change) => {
    expect(PendingQuestion.safeParse({ id: "call-1", askedAt: 5, ...change }).success).toBe(false);
  });
});

describe("QuestionReply", () => {
  it("is the answers, one per question, or skipping them all", () => {
    expect(QuestionReply.safeParse({ answers: [{ selected: [0], other: null }] }).success).toBe(true);
    expect(QuestionReply.safeParse({ skipped: true }).success).toBe(true);
    expect(QuestionReply.safeParse({ answers: [] }).success).toBe(false);
    expect(
      QuestionReply.safeParse({ answers: Array.from({ length: 5 }, () => ({ selected: [0], other: null })) }).success,
    ).toBe(false);
    expect(QuestionReply.safeParse({ skipped: false }).success).toBe(false);
    expect(
      QuestionReply.safeParse({ answers: [{ selected: [0], other: "长".repeat(QUESTION_LIMITS.other + 1) }] }).success,
    ).toBe(false);
    expect(QuestionReply.safeParse({ answers: [{ selected: [0.5], other: null }] }).success).toBe(false);
    expect(QuestionReply.safeParse({ answers: [{ selected: [0, 1, 2, 3, 0], other: null }] }).success).toBe(false);
  });
});
