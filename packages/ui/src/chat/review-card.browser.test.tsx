import { IDLE_CONTROL, type PendingReview, type Verdict } from "@atrium/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { taskReviewEnv } from "../tasks/review-words";
import { forgetReviewDrafts } from "./review-state";
import { ReviewCard } from "./review-card";
import { ReviewEnvContext } from "./review-env";
import { ControlCards, type RunActions } from "./run-control";

const NAMES: Readonly<Record<string, string>> = {
  N1b: "迁移旧的分支名记录",
  N2: "核心实现与自检",
  N3: "测试",
  N4: "验收合并",
};

const opened: string[] = [];
const shown: number[] = [];
const ENV = taskReviewEnv({
  nodeName: (node) => NAMES[node],
  openChanges: (workspaceId) => void opened.push(workspaceId),
  showOnGraph: (version) => void shown.push(version),
});

afterEach(() => {
  opened.length = 0;
  shown.length = 0;
  forgetReviewDrafts("s1", []);
});

/** A human node's review: changes, a summary from N3, "通过并合并" and "打回". */
function human(changes: Partial<PendingReview> = {}): PendingReview {
  return {
    id: "rv_human",
    openedAt: 10,
    source: { kind: "gate", gate: "task_human" },
    subject: { code: "task_human_node", params: { taskId: "tsk_a", node: "N4", merge: true } },
    evidence: [
      { kind: "changes", workspaceId: "wks_000000000000000b", files: 3, added: 48, removed: 8 },
      { kind: "summary", by: { kind: "node", node: "N3" }, text: "12 项测试通过" },
    ],
    problem: null,
    actions: [
      { id: "pass", reason: "none", targets: [], recommended: true },
      { id: "send_back", reason: "required", targets: [{ id: "N2", remaining: 2 }], recommended: false },
    ],
    ...changes,
  };
}

/** A graph change's review. */
function graph(changes: Partial<PendingReview> = {}): PendingReview {
  return {
    id: "rv_graph",
    openedAt: 5,
    source: { kind: "gate", gate: "task_graph" },
    subject: { code: "task_graph_change", params: { taskId: "tsk_a", version: 3 } },
    evidence: [
      { kind: "graph_diff", from: 2, to: 3, added: ["N1b"], removed: [], changed: ["N2"] },
      { kind: "summary", by: { kind: "node", node: "N2" }, text: "旧的分支名记录不迁移，新规则读不到它们。" },
    ],
    problem: null,
    actions: [
      { id: "approve", reason: "none", targets: [], recommended: true },
      { id: "reject", reason: "optional", targets: [], recommended: false },
    ],
    ...changes,
  };
}

/** An archive question; merged or not decides what the host recommends. */
function archive(merged: boolean): PendingReview {
  return {
    id: "rv_archive",
    openedAt: 20,
    source: { kind: "gate", gate: "task_archive" },
    subject: { code: "task_archive", params: { taskId: "tsk_a" } },
    evidence: [
      {
        kind: "facts",
        facts: [
          { code: "commits_ahead", params: { name: "zh-branch-fallback", count: 3 }, status: "ok" },
          merged
            ? { code: "worktree_merged", params: { name: "main" }, status: "ok" }
            : { code: "worktree_not_merged", params: { name: "main" }, status: "warn" },
          { code: "worktree_clean", params: { name: "zh-branch-fallback" }, status: "ok" },
        ],
      },
    ],
    problem: null,
    actions: merged
      ? [
          { id: "archive", reason: "none", targets: [], recommended: true },
          { id: "keep", reason: "none", targets: [], recommended: false },
        ]
      : [
          { id: "archive", reason: "none", targets: [], recommended: false },
          { id: "keep", reason: "none", targets: [], recommended: true },
        ],
  };
}

/**
 * An answer that holds the first press until released and lets later ones go at once.
 *
 * @returns The answer for the card and the release of the first.
 */
function held() {
  const first = Promise.withResolvers<string | null>();
  const answers = [first.promise];
  return {
    release: first.resolve,
    next: (): Promise<string | null> => answers.shift() ?? Promise.resolve(null),
  };
}

/** The names of the buttons in a screen, in order. */
function labels(screen: { container: HTMLElement }) {
  return [...screen.container.querySelectorAll("[data-action]")].map((button) => button.textContent);
}

/**
 * Renders a review card that records the verdicts it sends.
 *
 * @param review - The review.
 * @param result - What answering resolves with, per press.
 * @returns The screen and the verdicts.
 */
async function card(review: PendingReview, result: () => Promise<string | null> = () => Promise.resolve(null)) {
  const verdicts: Verdict[] = [];
  const screen = await render(
    <ReviewEnvContext value={ENV}>
      <ReviewCard
        sessionId="s1"
        review={review}
        onAnswer={(verdict) => {
          verdicts.push(verdict);
          return result();
        }}
      />
    </ReviewEnvContext>,
  );
  return { screen, verdicts };
}

describe("the review card's composition (SPEC-0006, 界面 · 审核卡片)", () => {
  it("heads the card with the source and what is reviewed, and writes a graph change's evidence", async () => {
    const { screen } = await card(graph());

    await expect.element(screen.getByTestId("review")).toHaveAttribute("aria-label", "审核：图 v3 等你批准");
    await expect.element(screen.getByTestId("review-subject")).toHaveTextContent("图 v3 等你批准");
    expect(screen.container.textContent).toContain("任务");
    const diff = screen.getByTestId("review-graph-diff").element();
    expect(diff.textContent).toContain("+N1b 迁移旧的分支名记录");
    expect(diff.textContent).toContain("~N2 核心实现与自检");
    expect(screen.getByTestId("review-summary").element().textContent).toContain("N2 核心实现与自检 说");
    await screen.getByRole("button", { name: "在图上看" }).click();
    expect(shown).toStrictEqual([3]);
  });

  it("shows a human node's change figures, opens the changes of its worktree, and quotes the upstream summary", async () => {
    const { screen } = await card(human());

    const changes = screen.getByTestId("review-changes").element();
    expect(changes.textContent).toContain("3 个文件");
    expect(changes.textContent).toContain("+48");
    expect(changes.textContent).toContain("−8");
    await screen.getByRole("button", { name: "查看改动" }).click();
    expect(opened).toStrictEqual(["wks_000000000000000b"]);
    expect(screen.getByTestId("review-summary").element().textContent).toContain("12 项测试通过");
  });

  it("puts the recommended button first and filled, whatever the order the host listed", async () => {
    const merged = await card(archive(true));
    const kept = await card(archive(false));

    expect(labels(merged.screen)).toStrictEqual(["归档", "先留着"]);
    expect(labels(kept.screen)).toStrictEqual(["先留着", "归档"]);
    expect(kept.screen.container.textContent).toContain("main 还没合并进主干，提交只在这个分支上");
    expect(kept.screen.container.querySelector('[data-status="warn"]')).not.toBeNull();
    expect(merged.screen.container.querySelector('[data-status="warn"]')).toBeNull();
  });

  it("words a blocked merge as a problem band with its files and swaps pass for a retry", async () => {
    const blocked = human({
      problem: { code: "merge_conflict", params: {}, files: ["src/a.ts", "src/b.ts"] },
      actions: [
        { id: "retry", reason: "none", targets: [], recommended: true },
        { id: "send_back", reason: "required", targets: [{ id: "N2", remaining: 2 }], recommended: false },
      ],
    });
    const { screen, verdicts } = await card(blocked);

    const band = screen.getByTestId("review-problem").element();
    expect(band.textContent).toContain("合并被挡住：2 个文件冲突");
    expect(band.textContent).toContain("src/a.ts");
    expect(band.getAttribute("data-danger")).toBe("false");
    await screen.getByRole("button", { name: "重试合并" }).click();
    expect(verdicts).toStrictEqual([{ action: "retry" }]);
  });

  it("paints the merge that could not be undone in the danger colour", async () => {
    const { screen } = await card(human({ problem: { code: "merge_abort_failed", params: {} } }));

    expect(screen.getByTestId("review-problem").element().getAttribute("data-danger")).toBe("true");
    expect(screen.getByTestId("review-problem").element().textContent).toContain("合并没能退回");
  });
});

describe("the verdicts (SPEC-0006, 审核卡片 4)", () => {
  it("sends a button that needs nothing at once", async () => {
    const { screen, verdicts } = await card(human());
    await screen.getByRole("button", { name: "通过并合并" }).click();

    expect(verdicts).toStrictEqual([{ action: "pass" }]);
  });

  it("opens a form for 打回, takes the lone target by itself, and waits for a reason", async () => {
    const { screen, verdicts } = await card(human());
    await screen.getByRole("button", { name: "打回到 N2 核心实现与自检…" }).click();

    const confirm = screen.getByTestId("review-confirm");
    await expect.element(confirm).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "原因（必填）" }), "  测试没有覆盖旧的分支名  ");
    await expect.element(confirm).toBeEnabled();
    await confirm.click();

    expect(verdicts).toStrictEqual([{ action: "send_back", target: "N2", reason: "测试没有覆盖旧的分支名" }]);
  });

  it("does not take a reason of blanks", async () => {
    const { screen, verdicts } = await card(human());
    await screen.getByRole("button", { name: /^打回到/ }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "原因（必填）" }), "   ");

    await expect.element(screen.getByTestId("review-confirm")).toBeDisabled();
    expect(verdicts).toStrictEqual([]);
  });

  it("greys a target with nothing left, makes you choose among several, and sends the one chosen", async () => {
    const several = human({
      actions: [
        { id: "pass", reason: "none", targets: [], recommended: true },
        {
          id: "send_back",
          reason: "required",
          targets: [
            { id: "N1b", remaining: 0 },
            { id: "N2", remaining: 1 },
            { id: "N3", remaining: 2 },
          ],
          recommended: false,
        },
      ],
    });
    const { screen, verdicts } = await card(several);
    await screen.getByRole("button", { name: "打回到…" }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "原因（必填）" }), "再试一次");

    await expect.element(screen.getByTestId("review-confirm")).toBeDisabled();
    const exhausted = screen.container.querySelector<HTMLButtonElement>('[data-target="N1b"]');
    expect(exhausted?.disabled).toBe(true);
    expect(exhausted?.textContent).toContain("已用完");
    expect(screen.container.querySelector('[data-target="N3"]')?.textContent).toContain("还能打回 2 次");
    screen.container.querySelector<HTMLButtonElement>('[data-target="N3"]')?.click();
    await screen.getByTestId("review-confirm").click();

    expect(verdicts).toStrictEqual([{ action: "send_back", target: "N3", reason: "再试一次" }]);
  });

  it("cannot send back when every target is used up", async () => {
    const spent = human({
      actions: [
        { id: "pass", reason: "none", targets: [], recommended: true },
        { id: "send_back", reason: "required", targets: [{ id: "N2", remaining: 0 }], recommended: false },
      ],
    });
    const { screen, verdicts } = await card(spent);
    await screen.getByRole("button", { name: /^打回到/ }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "原因（必填）" }), "原因");

    await expect.element(screen.getByTestId("review-confirm")).toBeDisabled();
    expect(verdicts).toStrictEqual([]);
  });

  it("takes a reason for 不批准 but does not need one", async () => {
    const without = await card(graph());
    await without.screen.getByRole("button", { name: "不批准…" }).click();
    await without.screen.getByTestId("review-confirm").click();
    expect(without.verdicts).toStrictEqual([{ action: "reject" }]);
    await without.screen.unmount();
    // The same review again is a new question: the list has long stopped carrying the one that was answered.
    forgetReviewDrafts("s1", []);

    const withReason = await card(graph());
    await withReason.screen.getByRole("button", { name: "不批准…" }).click();
    await userEvent.type(withReason.screen.getByRole("textbox", { name: "原因（可选）" }), "先别动旧记录");
    await withReason.screen.getByTestId("review-confirm").click();
    expect(withReason.verdicts).toStrictEqual([{ action: "reject", reason: "先别动旧记录" }]);
  });

  it("sends the reason with Enter, breaks the line with Shift Enter, and folds the form with Esc", async () => {
    const { screen, verdicts } = await card(human());
    await screen.getByRole("button", { name: /^打回到/ }).click();
    const box = screen.getByRole("textbox", { name: "原因（必填）" });
    await userEvent.type(box, "第一行");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}第二行");
    await userEvent.keyboard("{Escape}");
    expect(screen.container.querySelector('[data-testid="review-form"]')).toBeNull();

    await screen.getByRole("button", { name: /^打回到/ }).click();
    await expect.element(screen.getByRole("textbox", { name: "原因（必填）" })).toHaveValue("第一行\n第二行");
    await userEvent.keyboard("{Enter}");
    expect(verdicts).toStrictEqual([{ action: "send_back", target: "N2", reason: "第一行\n第二行" }]);
  });

  it("words a failure in the card and lets you press again; a second press while one is on its way sends nothing", async () => {
    const gate = held();
    const { screen, verdicts } = await card(human(), gate.next);
    const pass = screen.getByRole("button", { name: "通过并合并" });
    await pass.click();
    await pass.click({ force: true });
    expect(verdicts).toHaveLength(1);

    gate.release("这条审核已经处理过了");
    await expect.element(screen.getByTestId("review-failure")).toHaveTextContent("这条审核已经处理过了");
    await pass.click();
    expect(verdicts).toHaveLength(2);
  });

  it("sends a reason once when Enter is pressed twice while the answer is on its way", async () => {
    const gate = held();
    const { screen, verdicts } = await card(human(), gate.next);
    await screen.getByRole("button", { name: /^打回到/ }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "原因（必填）" }), "原因");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");

    expect(verdicts).toHaveLength(1);
    gate.release(null);
  });

  it("forgets what you wrote for a review once its verdict was taken, though the card is still drawn", async () => {
    const taken = await card(human());
    await taken.screen.getByRole("button", { name: /^打回到/ }).click();
    await userEvent.type(taken.screen.getByRole("textbox", { name: "原因（必填）" }), "打回去重做");
    await taken.screen.getByTestId("review-confirm").click();
    await expect.poll(() => taken.verdicts).toHaveLength(1);
    await taken.screen.unmount();

    // Drawn again while the list still carries the review: the written reason is of no use any more.
    const again = await card(human());
    expect(again.screen.container.querySelector('[data-testid="review-form"]')).toBeNull();
  });

  it("keeps what you wrote when the card is drawn again, and forgets it once the review is gone", async () => {
    const first = await card(human());
    await first.screen.getByRole("button", { name: /^打回到/ }).click();
    await userEvent.type(first.screen.getByRole("textbox", { name: "原因（必填）" }), "写了一半");
    await first.screen.unmount();

    const again = await card(human());
    await expect.element(again.screen.getByRole("textbox", { name: "原因（必填）" })).toHaveValue("写了一半");
    await again.screen.unmount();

    forgetReviewDrafts("s1", []);
    const gone = await card(human());
    expect(gone.screen.container.querySelector('[data-testid="review-form"]')).toBeNull();
  });
});

describe("a verdict that went, and the buttons that stay put (T8 review fix 9)", () => {
  it("keeps the buttons off once the verdict went, until the review is no longer pending", async () => {
    const { screen, verdicts } = await card(human());
    await screen.getByRole("button", { name: "通过并合并" }).click();
    await expect.poll(() => verdicts).toHaveLength(1);

    // The host has taken it; the list learns of it with the next `control_updated`, so the card is still drawn.
    for (const button of screen.container.querySelectorAll<HTMLButtonElement>("[data-action]")) {
      expect(button.disabled).toBe(true);
    }
    await screen.getByRole("button", { name: "通过并合并" }).click({ force: true });
    expect(verdicts).toHaveLength(1);
  });

  it("keeps the lock of a verdict on its way when you switch to another card and back", async () => {
    const gate = held();
    const sent: string[] = [];
    const actions: RunActions = {
      resume: () => undefined,
      clear: () => undefined,
      update: () => undefined,
      remove: () => undefined,
      steerQueued: () => undefined,
      removeDelivery: () => undefined,
      resumeDeliveries: () => undefined,
      answer: () => undefined,
      answerQuestion: () => Promise.resolve(true),
      answerReview: (id) => {
        sent.push(id);
        return gate.next();
      },
      retry: () => undefined,
    };
    const control = { ...IDLE_CONTROL, reviews: [human(), graph()] };
    const screen = await render(
      <ReviewEnvContext value={ENV}>
        <ControlCards sessionId="s1" control={control} actions={actions} />
      </ReviewEnvContext>,
    );
    await screen.getByRole("button", { name: "批准，接着跑" }).click();
    await screen.getByRole("tab", { name: "N4 验收合并" }).click();
    await expect.element(screen.getByRole("button", { name: "通过并合并" })).toBeEnabled();
    await screen.getByRole("tab", { name: "图 v3 等你批准" }).click();

    for (const button of screen.container.querySelectorAll<HTMLButtonElement>("[data-action]")) {
      expect(button.disabled).toBe(true);
    }
    // The answer comes back while the other card is open, and the lock stays: the review is still pending.
    await screen.getByRole("tab", { name: "N4 验收合并" }).click();
    gate.release(null);
    await screen.getByRole("tab", { name: "图 v3 等你批准" }).click();
    for (const button of screen.container.querySelectorAll<HTMLButtonElement>("[data-action]")) {
      expect(button.disabled).toBe(true);
    }
    expect(sent).toStrictEqual(["rv_graph"]);

    // Once the host stops listing it the lock is let go, so a review that comes with the same id can be answered.
    await screen.rerender(
      <ReviewEnvContext value={ENV}>
        <ControlCards sessionId="s1" control={{ ...control, reviews: [human()] }} actions={actions} />
      </ReviewEnvContext>,
    );
    await screen.rerender(
      <ReviewEnvContext value={ENV}>
        <ControlCards sessionId="s1" control={control} actions={actions} />
      </ReviewEnvContext>,
    );
    await expect.element(screen.getByRole("button", { name: "批准，接着跑" })).toBeEnabled();
  });

  it("shows a failure that came while another card was open when you come back, with the buttons usable again", async () => {
    const gate = held();
    const actions: RunActions = {
      resume: () => undefined,
      clear: () => undefined,
      update: () => undefined,
      remove: () => undefined,
      steerQueued: () => undefined,
      removeDelivery: () => undefined,
      resumeDeliveries: () => undefined,
      answer: () => undefined,
      answerQuestion: () => Promise.resolve(true),
      answerReview: () => gate.next(),
      retry: () => undefined,
    };
    const screen = await render(
      <ReviewEnvContext value={ENV}>
        <ControlCards sessionId="s1" control={{ ...IDLE_CONTROL, reviews: [human(), graph()] }} actions={actions} />
      </ReviewEnvContext>,
    );
    await screen.getByRole("button", { name: "批准，接着跑" }).click();
    await screen.getByRole("tab", { name: "N4 验收合并" }).click();
    gate.release("这条审核已经处理过了");
    await screen.getByRole("tab", { name: "图 v3 等你批准" }).click();

    await expect.element(screen.getByTestId("review-failure")).toHaveTextContent("这条审核已经处理过了");
    await expect.element(screen.getByRole("button", { name: "批准，接着跑" })).toBeEnabled();
  });
});

/** The background a button is painted with. */
const paint = (screen: { container: HTMLElement }, action: string) =>
  getComputedStyle(screen.container.querySelector(`[data-action="${action}"]`) as HTMLElement).backgroundColor;

describe("a card with nothing recommended (T8 review fix 10)", () => {
  it("paints the recommended button, and none when the host recommends none", async () => {
    const some = await card(graph());
    const none = await card(
      graph({
        actions: [
          { id: "approve", reason: "none", targets: [], recommended: false },
          { id: "reject", reason: "optional", targets: [], recommended: false },
        ],
      }),
    );

    expect(paint(some.screen, "approve")).not.toBe(paint(some.screen, "reject"));
    expect(paint(none.screen, "approve")).toBe(paint(none.screen, "reject"));
    // The host's order stands when none comes first.
    expect(labels(none.screen)).toStrictEqual(["批准，接着跑", "不批准…"]);
    expect(none.screen.container.querySelector('[data-action][data-recommended="true"]')).toBeNull();
  });
});

describe("a review an agent asked for (ADR-0018)", () => {
  const agent: PendingReview = {
    id: "rv_agent",
    openedAt: 1,
    source: { kind: "agent", toolCallId: "call-1" },
    subject: { text: "准备推送 <b>3 个提交</b>" },
    evidence: [
      { kind: "facts", facts: [{ code: "worktree_clean", params: {}, status: "ok" }] },
      { kind: "summary", by: { kind: "agent" }, text: "测试已通过 ✓ <img src=x onerror=alert(1)>" },
    ],
    problem: null,
    actions: [{ id: "approve", reason: "none", targets: [], recommended: true }],
  };

  it("quotes what the agent wrote as text, says it was the agent, and draws no fact it could have made up", async () => {
    const { screen } = await card(agent);

    expect(screen.container.querySelector("img")).toBeNull();
    expect(screen.container.querySelector("b")).toBeNull();
    await expect.element(screen.getByTestId("review-subject")).toHaveTextContent("准备推送 <b>3 个提交</b>");
    const quote = screen.getByTestId("review-summary").element().textContent;
    expect(quote).toContain("agent 说");
    expect(quote).toContain("<img src=x onerror=alert(1)>");
    expect(screen.container.querySelector('[data-testid="review-fact"]')).toBeNull();
  });
});

describe("cards stacked above the box (SPEC-0006, 几张同时在)", () => {
  const actions: RunActions = {
    resume: () => undefined,
    clear: () => undefined,
    update: () => undefined,
    remove: () => undefined,
    steerQueued: () => undefined,
    removeDelivery: () => undefined,
    resumeDeliveries: () => undefined,
    answer: () => undefined,
    answerQuestion: () => Promise.resolve(true),
    answerReview: () => Promise.resolve(null),
    retry: () => undefined,
  };
  const question = {
    id: "call-1",
    askedAt: 15,
    questions: [
      {
        header: "范围",
        question: "这次改到哪为止？",
        multiSelect: false,
        options: [{ label: "只改一处", description: "", preview: null, recommended: true }],
      },
    ],
  };

  it("opens one card at a time with the others as capsules in the order they came, and switches on a press", async () => {
    const screen = await render(
      <ReviewEnvContext value={ENV}>
        <ControlCards
          sessionId="s1"
          control={{ ...IDLE_CONTROL, question, reviews: [human(), graph()] }}
          actions={actions}
        />
      </ReviewEnvContext>,
    );

    const tabs = screen.getByRole("tablist", { name: "等你处理的卡片" }).element();
    expect([...tabs.querySelectorAll("[role=tab]")].map((tab) => tab.textContent)).toStrictEqual([
      "图 v3 等你批准",
      "N4 验收合并",
      "agent 在问你",
    ]);
    // The earliest is open; the others are only capsules.
    expect(screen.container.querySelectorAll('[data-testid="review"]')).toHaveLength(1);
    expect(screen.container.querySelector('[data-testid="question"]')).toBeNull();
    await expect.element(screen.getByTestId("review-subject")).toHaveTextContent("图 v3 等你批准");

    await screen.getByRole("tab", { name: "agent 在问你" }).click();
    await expect.element(screen.getByTestId("question")).toBeVisible();
    expect(screen.container.querySelector('[data-testid="review"]')).toBeNull();

    await screen.getByRole("tab", { name: "N4 验收合并" }).click();
    await expect.element(screen.getByTestId("review-subject")).toHaveTextContent("N4 验收合并");
  });

  it("draws no capsule for one card, and the question card is the same shell as before", async () => {
    const screen = await render(
      <ControlCards sessionId="s1" control={{ ...IDLE_CONTROL, question }} actions={actions} />,
    );

    expect(screen.container.querySelector('[role="tablist"][aria-label="等你处理的卡片"]')).toBeNull();
    await expect.element(screen.getByTestId("question")).toBeVisible();
  });
});
