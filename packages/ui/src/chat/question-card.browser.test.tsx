import { IDLE_CONTROL, type AskedQuestion, type PendingQuestion, type QuestionReply } from "@atrium/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { ClockContext, type UiClock } from "../state/clock";
import { QuestionCard } from "./question-card";
import { forgetDrafts } from "./question-state";
import { Composer } from "./composer";
import { ControlCards, ControlTrack, type RunActions } from "./run-control";

/** A single-choice question; the first option is recommended. */
const scope: AskedQuestion = {
  header: "范围",
  question: "这次重构改到哪为止？",
  multiSelect: false,
  options: [
    { label: "只改收件箱", description: "别处不动", preview: null, recommended: true },
    { label: "整个侧栏", description: "改动大", preview: null, recommended: false },
  ],
};

/** A multiple-choice question. */
const tests: AskedQuestion = {
  header: "测试",
  question: "要补哪些测试？",
  multiSelect: true,
  options: [
    { label: "单元", description: "纯函数", preview: null, recommended: false },
    { label: "组件", description: "展开收起", preview: null, recommended: false },
    { label: "端到端", description: "真实 Electron", preview: null, recommended: false },
  ],
};

/** A single-choice question whose options have previews. */
const place: AskedQuestion = {
  header: "位置",
  question: "收件箱放在哪？",
  multiSelect: false,
  options: [
    { label: "底部", description: "", preview: "<Inbox /> 在设置上面", recommended: false },
    { label: "顶部", description: "", preview: "<Inbox /> 在搜索下面", recommended: false },
  ],
};

/**
 * A call's questions.
 *
 * @param questions - What it asks.
 * @returns The pending questions.
 */
function asked(...questions: AskedQuestion[]): PendingQuestion {
  return { id: "call-1", askedAt: 0, questions };
}

/**
 * Answers sending with the given results in turn, then that it went.
 *
 * @param results - The results, used up in order.
 * @returns The answer to each send.
 */
function inTurn(results: Promise<boolean>[]): () => Promise<boolean> {
  return () => results.shift() ?? Promise.resolve(true);
}

/** A timer the held clock was asked for. */
interface HeldTimer {
  readonly ms: number;
  readonly run: () => void;
  cancelled: boolean;
}

/**
 * A clock whose timers wait to be fired by hand.
 *
 * @returns The clock and the timers it was asked for.
 */
function heldClock() {
  const timers: HeldTimer[] = [];
  const clock: UiClock = {
    now: () => 0,
    every: () => () => undefined,
    after: (ms, run) => {
      const timer: HeldTimer = { ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return { clock, timers };
}

/**
 * Renders the card for session s1, recording what it sends.
 *
 * @param question - The questions.
 * @param clock - The clock.
 * @returns The screen and what was sent.
 */
async function card(
  question: PendingQuestion,
  clock: UiClock = heldClock().clock,
  answer: () => Promise<boolean> = async () => true,
) {
  const sent: QuestionReply[] = [];
  const screen = await render(
    <ClockContext value={clock}>
      <QuestionCard
        sessionId="s1"
        question={question}
        onAnswer={(reply) => {
          sent.push(reply);
          return answer();
        }}
      />
    </ClockContext>,
  );
  return { screen, sent };
}

afterEach(() => forgetDrafts("s1", null));

describe("QuestionCard", () => {
  it("says the agent asks, how far you are, which kind each question is, and marks the recommendation", async () => {
    const { screen } = await card(asked(scope, tests));

    await expect.element(screen.getByText("agent 在问你")).toBeVisible();
    await expect.element(screen.getByText("· 已答 0 / 2")).toBeVisible();
    await expect.element(screen.getByRole("tab", { name: "范围" })).toHaveAttribute("aria-selected", "true");
    await expect.element(screen.getByText("这次重构改到哪为止？")).toBeVisible();
    await expect.element(screen.getByText("单选", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("radio", { name: /只改收件箱/ }))
      .toHaveTextContent("1只改收件箱推荐别处不动");
    await expect
      .element(screen.getByRole("radio", { name: /其他/ }))
      .toHaveTextContent("3其他都不合适？写你自己的回答");

    await screen.getByRole("tab", { name: "测试" }).click();

    await expect.element(screen.getByText("多选", { exact: true })).toBeVisible();
    expect(screen.getByRole("checkbox").elements()).toHaveLength(4);
    expect(screen.getByRole("radio").elements()).toHaveLength(0);
  });

  it("draws the numbers as the control: circles for one choice, rounded squares for several, a tick once picked", async () => {
    const { screen } = await card(asked(scope, tests));
    const disc = (name: RegExp) => screen.getByRole("radio", { name }).element().querySelector("[data-disc]");

    await screen.getByRole("radio", { name: /整个侧栏/ }).click();

    const picked = disc(/整个侧栏/);
    // A circle: rounded by at least half its 22px side.
    expect(Number.parseFloat(getComputedStyle(disc(/只改收件箱/) as Element).borderRadius)).toBeGreaterThanOrEqual(11);
    expect(picked?.textContent).toBe("");
    expect(picked?.querySelector("svg")).not.toBeNull();
    await expect.poll(() => getComputedStyle(picked as Element).backgroundColor).toBe(colorOf("var(--tint)"));
    await screen.getByRole("tab", { name: "测试" }).click();
    const square = screen
      .getByRole("checkbox", { name: /单元/ })
      .element()
      .querySelector("[data-disc]");
    expect(getComputedStyle(square as Element).borderRadius).toBe("7px");
  });

  it("picks one option of a single-choice question, and moves to the next unanswered one a moment later", async () => {
    const { clock, timers } = heldClock();
    const { screen } = await card(asked(scope, tests), clock);

    await screen.getByRole("radio", { name: /整个侧栏/ }).click();

    await expect.element(screen.getByRole("radio", { name: /整个侧栏/ })).toHaveAttribute("aria-checked", "true");
    expect(timers.map((timer) => timer.ms)).toStrictEqual([200]);
    timers[0]?.run();
    await expect.element(screen.getByRole("tab", { name: "测试" })).toHaveAttribute("aria-selected", "true");
    await expect.element(screen.getByText("· 已答 1 / 2")).toBeVisible();
  });

  it("toggles options of a multiple-choice question, counting them, and sends every answer once all have one", async () => {
    const { screen, sent } = await card(asked(tests, scope));
    const submit = screen.getByRole("button", { name: "提交回答" });

    await screen.getByRole("checkbox", { name: /单元/ }).click();
    await screen.getByRole("checkbox", { name: /端到端/ }).click();
    await expect.element(screen.getByText("多选 · 已选 2")).toBeVisible();
    await screen.getByRole("checkbox", { name: /单元/ }).click();
    await expect.element(screen.getByText("多选 · 已选 1")).toBeVisible();
    await expect.element(submit).toBeDisabled();
    await screen.getByRole("button", { name: "下一题" }).click();
    await screen.getByRole("radio", { name: /只改收件箱/ }).click();
    await submit.click();

    expect(sent).toStrictEqual([
      {
        answers: [
          { selected: [2], other: null },
          { selected: [0], other: null },
        ],
      },
    ]);
  });

  it("opens a box across the row for the other answer, focused, two lines high and growing; Enter confirms, Shift+Enter breaks the line", async () => {
    const { screen, sent } = await card(asked(scope));

    await screen.getByRole("radio", { name: /其他/ }).click();
    const box = screen.getByRole("textbox", { name: "其他回答" });
    await expect.element(box).toHaveFocus();
    const row = screen
      .getByRole("radio", { name: /其他/ })
      .element()
      .getBoundingClientRect();
    const first = box.element().getBoundingClientRect();
    expect(first.height).toBeGreaterThanOrEqual(62);
    expect(row.right - first.right).toBeLessThan(16);
    expect(screen.getByText("都不合适？写你自己的回答").elements()).toHaveLength(0);
    await userEvent.keyboard(
      "放在设置上面{Shift>}{Enter}{/Shift}第二行{Shift>}{Enter}{/Shift}第三行{Shift>}{Enter}{/Shift}第四行",
    );
    await expect.element(box).toHaveValue("放在设置上面\n第二行\n第三行\n第四行");
    expect(box.element().getBoundingClientRect().height).toBeGreaterThan(first.height);
    await userEvent.keyboard("{Enter}");

    expect(sent).toStrictEqual([{ answers: [{ selected: [], other: "放在设置上面\n第二行\n第三行\n第四行" }] }]);
  });

  it("chooses by number keys, which never type into the other answer, and moves between options with the arrows", async () => {
    const { screen } = await card(asked(scope));

    await screen.getByRole("radio", { name: /只改收件箱/ }).click();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(screen.getByRole("radio", { name: /整个侧栏/ })).toHaveFocus();
    await userEvent.keyboard("2");
    await expect.element(screen.getByRole("radio", { name: /整个侧栏/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("3");

    await expect.element(screen.getByRole("textbox", { name: "其他回答" })).toHaveFocus();
    await expect.element(screen.getByRole("textbox", { name: "其他回答" })).toHaveValue("");
  });

  it("changes question with the left and right arrows", async () => {
    const { screen } = await card(asked(scope, tests));

    await screen.getByRole("tab", { name: "范围" }).click();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(screen.getByRole("tab", { name: "测试" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowLeft}");

    await expect.element(screen.getByRole("tab", { name: "范围" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the focus in the card as it moves on to the next question, so the keys go on answering", async () => {
    const { clock, timers } = heldClock();
    const { screen, sent } = await card(asked(scope, tests), clock);

    await screen.getByRole("radio", { name: /整个侧栏/ }).click();
    timers[0]?.run();
    await expect.element(screen.getByRole("tab", { name: "测试" })).toHaveAttribute("aria-selected", "true");
    await expect.element(screen.getByRole("checkbox", { name: /单元/ })).toHaveFocus();
    await userEvent.keyboard("3");
    await userEvent.keyboard("{Enter}");

    expect(sent).toStrictEqual([
      {
        answers: [
          { selected: [1], other: null },
          { selected: [2], other: null },
        ],
      },
    ]);
  });

  it("moves the focus onto the next question's options as the arrows change question from an option", async () => {
    const { screen } = await card(asked(scope, tests));

    await screen.getByRole("radio", { name: /只改收件箱/ }).click();
    await userEvent.keyboard("{ArrowRight}");

    await expect.element(screen.getByRole("checkbox", { name: /单元/ })).toHaveFocus();
  });

  it("leaves keys held with ⌘, Ctrl or Alt to the app, as ⌘2 switching tabs", async () => {
    const { screen } = await card(asked(scope));

    await screen.getByRole("radio", { name: /只改收件箱/ }).click();
    await userEvent.keyboard("{Meta>}2{/Meta}{Control>}2{/Control}{Alt>}2{/Alt}");

    await expect.element(screen.getByRole("radio", { name: /整个侧栏/ })).toHaveAttribute("aria-checked", "false");
  });

  it("lets you send again when sending failed, and holds the buttons while it goes", async () => {
    const first = Promise.withResolvers<boolean>();
    const tries = [first.promise, Promise.resolve(true)];
    const { screen, sent } = await card(asked(scope), heldClock().clock, inTurn(tries));
    const skip = screen.getByRole("button", { name: "跳过" });

    await skip.click();
    await expect.element(skip).toBeDisabled();
    first.resolve(false);
    await expect.element(skip).toBeEnabled();
    await skip.click();

    expect(sent).toStrictEqual([{ skipped: true }, { skipped: true }]);
  });

  it("takes no more than 4000 characters in the other answer", async () => {
    const { screen } = await card(asked(scope));

    await screen.getByRole("radio", { name: /其他/ }).click();

    await expect.element(screen.getByRole("textbox", { name: "其他回答" })).toHaveAttribute("maxlength", "4000");
  });

  it("skips them all", async () => {
    const { screen, sent } = await card(asked(scope, tests));

    await screen.getByRole("button", { name: "跳过" }).click();

    expect(sent).toStrictEqual([{ skipped: true }]);
  });

  it("keeps what you picked when the card goes and comes back for the same questions", async () => {
    const first = await card(asked(scope, tests));
    await first.screen.getByRole("tab", { name: "测试" }).click();
    await first.screen.getByRole("checkbox", { name: /组件/ }).click();
    await first.screen.unmount();

    const again = await card(asked(scope, tests));

    await expect.element(again.screen.getByRole("tab", { name: "测试" })).toHaveAttribute("aria-selected", "true");
    await expect.element(again.screen.getByRole("checkbox", { name: /组件/ })).toHaveAttribute("aria-checked", "true");
  });

  it("shows beside the options the preview of the one pointed at, else the one picked, else the first", async () => {
    const { screen } = await card(asked(place));
    const preview = screen.getByLabelText("预览");

    await expect.element(preview).toHaveTextContent("预览 · 底部<Inbox /> 在设置上面");
    await screen.getByRole("radio", { name: /顶部/ }).hover();
    await expect.element(preview).toHaveTextContent("预览 · 顶部<Inbox /> 在搜索下面");
  });
});

describe("the questions with the input box", () => {
  it("sit between the capsule bar and the box, the capsules above the card, covering none of it", async () => {
    const actions = { answerQuestion: async () => true } as unknown as RunActions;
    const control = {
      ...IDLE_CONTROL,
      queue: [{ id: "q1", text: "排队的话", createdAt: 0, images: 0 }],
      question: asked(scope),
    };
    const screen = await render(
      <div style={{ paddingTop: 400 }}>
        <Composer
          draftKey="s1"
          onSend={() => undefined}
          running
          above={<ControlTrack control={control} running actions={actions} />}
          pinned={<ControlCards sessionId="s1" control={control} actions={actions} />}
        />
      </div>,
    );

    const capsule = screen
      .getByRole("button", { name: /排队 1/ })
      .element()
      .getBoundingClientRect();
    const question = screen.getByTestId("question").element().getBoundingClientRect();
    const box = screen.getByRole("textbox", { name: "消息" }).element().getBoundingClientRect();
    expect(capsule.bottom).toBeLessThanOrEqual(question.top);
    expect(question.bottom).toBeLessThanOrEqual(box.top);
  });
});

describe("ControlCards with the agent's questions", () => {
  it("keeps what you picked while the questions are away for a moment, as a direct reply pi refused or a view loading", async () => {
    const actions = { answerQuestion: async () => true } as unknown as RunActions;
    const shown = (question: PendingQuestion | null) => (
      <ControlCards sessionId="s1" control={{ ...IDLE_CONTROL, question }} actions={actions} />
    );
    const screen = await render(shown(asked(scope)));
    await screen.getByRole("radio", { name: /整个侧栏/ }).click();

    await screen.rerender(shown(null));
    await screen.rerender(shown(asked(scope)));

    await expect.element(screen.getByRole("radio", { name: /整个侧栏/ })).toHaveAttribute("aria-checked", "true");
  });

  it("shows the questions alone, with no dialog or failure", async () => {
    const actions = { answerQuestion: () => undefined } as unknown as RunActions;
    const screen = await render(
      <ControlCards sessionId="s1" control={{ ...IDLE_CONTROL, question: asked(scope) }} actions={actions} />,
    );

    await expect.element(screen.getByTestId("question")).toBeVisible();
  });

  it("shows them below an extension's dialog, nearest the box, and answers them for the session", async () => {
    const calls: unknown[][] = [];
    const actions = {
      answer: () => undefined,
      answerQuestion: (questionId: string, reply: QuestionReply) => calls.push([questionId, reply]),
      retry: () => undefined,
    } as unknown as RunActions;
    const control = {
      ...IDLE_CONTROL,
      interactions: [
        {
          id: "d1",
          kind: "confirm" as const,
          title: "删掉吗？",
          message: null,
          options: null,
          placeholder: null,
          prefill: null,
          deadline: null,
        },
      ],
      question: asked(scope),
    };
    const screen = await render(<ControlCards sessionId="s1" control={control} actions={actions} />);

    const cards = [...screen.container.querySelectorAll("[data-testid]")].map((one) => one.getAttribute("data-testid"));
    await screen.getByRole("button", { name: "跳过" }).click();

    expect(cards).toStrictEqual(["interaction", "question"]);
    expect(calls).toStrictEqual([["call-1", { skipped: true }]]);
  });
});

/**
 * The colour CSS gives `value`, as computed.
 *
 * @param value - A CSS colour.
 * @returns The computed colour.
 */
function colorOf(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
