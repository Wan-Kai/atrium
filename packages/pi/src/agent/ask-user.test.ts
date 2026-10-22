import type { AskedQuestion } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { ASK_USER_STOPPED, answerText, askUserOutcome, askedQuestions, checkQuestions } from "./ask-user";

/** A question as the model writes it, with its recommendation marked in the label. */
const scope = {
  header: "Scope",
  question: "How far should the refactor go?",
  options: [
    { label: "Only the inbox (Recommended)", description: "Nothing else changes" },
    { label: "The whole sidebar", description: "Bigger change", preview: "<Sidebar />" },
  ],
};

/** A multiple-choice question. */
const tests = {
  header: "测试",
  question: "要补哪些测试？",
  multiSelect: true,
  options: [
    { label: "单元", description: "纯函数" },
    { label: "端到端（推荐）", description: "真实 Electron" },
    { label: "浏览器组件", description: "展开收起" },
  ],
};

/** What `scope` reads as. */
const scopeRead: AskedQuestion = {
  header: "Scope",
  question: "How far should the refactor go?",
  multiSelect: false,
  options: [
    { label: "Only the inbox", description: "Nothing else changes", preview: null, recommended: true },
    { label: "The whole sidebar", description: "Bigger change", preview: "<Sidebar />", recommended: false },
  ],
};

/**
 * A copy of `scope` with one option changed.
 *
 * @param index - Which option.
 * @param change - What to change in it.
 * @returns The question.
 */
function withOption(index: number, change: Record<string, unknown>): Record<string, unknown> {
  return { ...scope, options: scope.options.map((option, at) => (at === index ? { ...option, ...change } : option)) };
}

describe("checkQuestions", () => {
  it("reads the questions, takes the recommendation off the label and defaults to a single choice", () => {
    expect(checkQuestions({ questions: [scope, tests] })).toStrictEqual({
      ok: true,
      questions: [
        scopeRead,
        {
          header: "测试",
          question: "要补哪些测试？",
          multiSelect: true,
          options: [
            { label: "单元", description: "纯函数", preview: null, recommended: false },
            { label: "端到端", description: "真实 Electron", preview: null, recommended: true },
            { label: "浏览器组件", description: "展开收起", preview: null, recommended: false },
          ],
        },
      ],
    });
  });

  it("takes a blank preview as none, on any question", () => {
    const read = checkQuestions({
      questions: [{ ...tests, options: [{ ...tests.options[0], preview: " \n" }, ...tests.options.slice(1)] }],
    });

    expect(read).toMatchObject({
      ok: true,
      questions: [
        {
          options: [
            { label: "单元", description: "纯函数", preview: null, recommended: false },
            { label: "端到端", description: "真实 Electron", preview: null, recommended: true },
            { label: "浏览器组件", description: "展开收起", preview: null, recommended: false },
          ],
        },
      ],
    });
  });

  it("reads a recommendation only at the end of a label", () => {
    const read = checkQuestions({
      questions: [
        {
          header: "Mode",
          question: "Which?",
          options: [
            { label: "Plan (Recommended) first", description: "" },
            { label: "Fast (recommended)!", description: "" },
          ],
        },
      ],
    });

    expect(read).toStrictEqual({
      ok: true,
      questions: [
        {
          header: "Mode",
          question: "Which?",
          multiSelect: false,
          options: [
            { label: "Plan (Recommended) first", description: "", preview: null, recommended: false },
            { label: "Fast (recommended)!", description: "", preview: null, recommended: false },
          ],
        },
      ],
    });
  });

  it("trims the texts it shows, and reads a recommendation in either case and width", () => {
    expect(
      checkQuestions({
        questions: [
          {
            header: "  Scope ",
            question: " Which? ",
            options: [
              { label: " A  (recommended) ", description: " first " },
              { label: "B （推荐）", description: "" },
            ],
          },
        ],
      }),
    ).toStrictEqual({
      ok: true,
      questions: [
        {
          header: "Scope",
          question: "Which?",
          multiSelect: false,
          options: [
            { label: "A", description: "first", preview: null, recommended: true },
            { label: "B", description: "", preview: null, recommended: true },
          ],
        },
      ],
    });
  });

  it.each([
    ["no questions", { questions: [] }, "Ask between 1 and 4 questions."],
    ["five questions", { questions: [scope, scope, scope, scope, scope] }, "Ask between 1 and 4 questions."],
    ["something else", { questions: "which?" }, "Ask between 1 and 4 questions."],
    ["nothing", null, "Ask between 1 and 4 questions."],
    ["a question of another shape", { questions: [{ ...scope, header: 1 }] }, "Ask between 1 and 4 questions."],
    [
      "options of another shape",
      { questions: [{ ...scope, options: [{ label: 1 }, { label: 2 }] }] },
      "Ask between 1 and 4 questions.",
    ],
    [
      "one option",
      { questions: [{ ...scope, options: scope.options.slice(0, 1) }] },
      "Question 1: give between 2 and 4 options.",
    ],
    [
      "five options",
      { questions: [{ ...tests, options: [...tests.options, ...scope.options] }] },
      "Question 1: give between 2 and 4 options.",
    ],
    ["a blank header", { questions: [{ ...scope, header: " " }] }, "Question 1: the header is empty."],
    [
      "a header too long",
      { questions: [{ ...scope, header: "x".repeat(13) }] },
      "Question 1: the header is longer than 12 characters.",
    ],
    ["a blank question", { questions: [{ ...scope, question: "" }] }, "Question 1: the question is empty."],
    [
      "a question too long",
      { questions: [{ ...scope, question: "x".repeat(1001) }] },
      "Question 1: the question is longer than 1000 characters.",
    ],
    [
      "a label that is only a recommendation",
      { questions: [withOption(1, { label: "(Recommended)" })] },
      "Question 1, option 2: the label is empty.",
    ],
    [
      "a label too long",
      { questions: [withOption(0, { label: "x".repeat(61) })] },
      "Question 1, option 1: the label is longer than 60 characters.",
    ],
    [
      "a description too long",
      { questions: [withOption(0, { description: "x".repeat(301) })] },
      "Question 1, option 1: the description is longer than 300 characters.",
    ],
    [
      "a preview too long",
      { questions: [withOption(1, { preview: "x".repeat(4001) })] },
      "Question 1, option 2: the preview is longer than 4000 characters.",
    ],
    [
      "an other option",
      { questions: [scope, withOption(1, { label: "other" })] },
      'Question 2, option 2: do not write an "Other" option; every question gets one.',
    ],
    [
      "an Other option, in any case",
      { questions: [withOption(0, { label: "OTHER" })] },
      'Question 1, option 1: do not write an "Other" option; every question gets one.',
    ],
    [
      "a 其他 option",
      { questions: [withOption(0, { label: " 其他 " })] },
      'Question 1, option 1: do not write an "Other" option; every question gets one.',
    ],
    [
      "the same label twice",
      { questions: [withOption(1, { label: "Only the inbox" })] },
      'Question 1: two options are labeled "Only the inbox".',
    ],
    [
      "a preview on a multiple-choice question",
      { questions: [{ ...tests, options: [{ ...tests.options[0], preview: "x" }, ...tests.options.slice(1)] }] },
      "Question 1: only single-choice questions can have previews.",
    ],
    [
      "the same header twice",
      { questions: [scope, { ...tests, header: "Scope" }] },
      'Two questions have the header "Scope".',
    ],
  ])("refuses %s, telling the model what to fix", (_name, params, error) => {
    expect(checkQuestions(params)).toStrictEqual({ ok: false, error });
  });

  it("takes each text at its limit", () => {
    const question = {
      header: "x".repeat(12),
      question: "x".repeat(1000),
      options: [
        { label: "x".repeat(60), description: "x".repeat(300), preview: "x".repeat(4000) },
        { label: "y", description: "" },
      ],
    };
    const four = { ...tests, header: "四", options: [...tests.options, { label: "冒烟", description: "" }] };
    expect(checkQuestions({ questions: [question, { ...question, header: "y" }, four, scope] }).ok).toBe(true);
  });
});

describe("askedQuestions", () => {
  it("reads a call's arguments as pi ran them: null for what was left out, true and false written as text", () => {
    expect(
      askedQuestions({
        questions: [
          { ...scope, multiSelect: null, options: [{ ...scope.options[0], preview: null }, scope.options[1]] },
          { ...tests, multiSelect: "true" },
          { ...scope, header: "三", multiSelect: "false" },
        ],
      })?.map((one) => [one.multiSelect, one.options[0]?.preview]),
    ).toStrictEqual([
      [false, null],
      [true, null],
      [false, null],
    ]);
  });

  it("reads a call's arguments, or nothing when they would have been refused", () => {
    expect(askedQuestions({ questions: [scope] })).toStrictEqual([scopeRead]);
    expect(askedQuestions({ questions: [] })).toBeNull();
    expect(askedQuestions({})).toBeNull();
  });
});

describe("answerText", () => {
  const read = checkQuestions({ questions: [scope, tests] });
  const questions = read.ok ? read.questions : [];

  it("tells the model each answer by the option's label, several joined, the other answer marked", () => {
    expect(
      answerText(questions, {
        outcome: "answered",
        answers: [
          { selected: [0], other: null },
          { selected: [0, 2], other: "加一个基准\n跑在夜间" },
        ],
      }),
    ).toBe(
      [
        "The user answered:",
        '"How far should the refactor go?" = "Only the inbox"',
        '"要补哪些测试？" = "单元", "浏览器组件", Other: "加一个基准\\n跑在夜间"',
        "Go on with these answers in mind.",
      ].join("\n"),
    );
  });

  it("tells the model the other answer without the blanks around it", () => {
    expect(
      answerText(questions.slice(0, 1), {
        outcome: "answered",
        answers: [{ selected: [], other: "  放在设置上面 \n" }],
      }),
    ).toBe(
      [
        "The user answered:",
        '"How far should the refactor go?" = Other: "放在设置上面"',
        "Go on with these answers in mind.",
      ].join("\n"),
    );
  });

  it("names the options picked in the question's order, whatever order they came in", () => {
    expect(answerText(questions.slice(1), { outcome: "answered", answers: [{ selected: [2, 0], other: null }] })).toBe(
      ["The user answered:", '"要补哪些测试？" = "单元", "浏览器组件"', "Go on with these answers in mind."].join("\n"),
    );
  });

  it("tells the model the user skipped, or replied directly with a message that follows", () => {
    expect(answerText(questions, { outcome: "skipped" })).toBe(
      "The user skipped these questions. Continue with your best judgment, or ask in a different way.",
    );
    expect(answerText(questions, { outcome: "reply" })).toBe(
      "The user did not pick an answer and replied directly; their message follows.",
    );
  });

  it("says what the user did when the run stopped them", () => {
    expect(ASK_USER_STOPPED).toBe("The user stopped the run before answering.");
  });
});

describe("askUserOutcome", () => {
  it("reads how the questions ended from the result's details", () => {
    expect(askUserOutcome({ v: 1, outcome: { kind: "skipped" } })).toStrictEqual({ kind: "skipped" });
    expect(
      askUserOutcome({ v: 1, outcome: { kind: "answered", answers: [{ selected: [1], other: null }] } }),
    ).toStrictEqual({ kind: "answered", answers: [{ selected: [1], other: null }] });
  });

  it.each([
    ["nothing", undefined],
    ["pi's empty details for a stopped tool", {}],
    ["another version", { v: 2, outcome: { kind: "skipped" } }],
    ["an unknown outcome", { v: 1, outcome: { kind: "maybe" } }],
  ])("reads %s as no outcome", (_name, details) => {
    expect(askUserOutcome(details)).toBeNull();
  });
});
