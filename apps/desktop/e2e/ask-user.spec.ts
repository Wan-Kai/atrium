import { type FauxContext, createGitScene } from "@atrium/testkit";
import { type Page, expect, test } from "@playwright/test";
import { realpath } from "node:fs/promises";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { send } from "./messages";
import { addProject } from "./projects";

/** A single-choice question, as the model writes it. */
const SCOPE = {
  header: "范围",
  question: "这次重构改到哪为止？",
  options: [
    { label: "只改收件箱 (Recommended)", description: "别处不动" },
    { label: "整个侧栏", description: "改动大" },
  ],
};

/** A multiple-choice question. */
const TESTS = {
  header: "测试",
  question: "要补哪些测试？",
  multiSelect: true,
  options: [
    { label: "单元", description: "纯函数" },
    { label: "组件", description: "展开收起" },
    { label: "端到端", description: "真实 Electron" },
  ],
};

/**
 * Opens a session in the project's local workspace and sends it a first message.
 *
 * @remarks
 * The faux model answers it with `ask_user` (SPEC-0003).
 *
 * @sideEffects Opens the workspace and a session, and sends "重构收件箱".
 * @param window - The app's page.
 */
async function asked(window: Page): Promise<void> {
  await window.getByTestId("workspace-row").click({ timeout: 30_000 });
  await window.keyboard.press("Meta+T");
  await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
  await send(window, "重构收件箱");
  await expect(window.getByTestId("question")).toBeVisible({ timeout: 60_000 });
}

/**
 * Each message a request gave the model, as `role: text`, without the system message.
 *
 * @sideEffects none
 * @param request - The request.
 * @returns One line each.
 */
function spoken(request: FauxContext | undefined): string[] {
  return (request?.messages ?? []).flatMap((message) => {
    const role = String(Reflect.get(message as object, "role"));
    if (role === "system") return [];
    const content: unknown = Reflect.get(message as object, "content");
    const text = Array.isArray(content)
      ? content.map((block: unknown) => String(Reflect.get(block as object, "text") ?? "")).join("")
      : String(content);
    return [`${role}: ${text}`];
  });
}

test("the agent asks you two questions; you pick on the card and send, and it goes on with your answers in the same turn", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      { blocks: [{ type: "toolCall", id: "ask-1", name: "ask_user", arguments: { questions: [SCOPE, TESTS] } }] },
      { blocks: [{ type: "text", text: "按你选的来" }] },
    ],
  });
  const scene = await createGitScene("e2e-ask-user");
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, await realpath(scene.repo));
    await asked(window);
    const card = window.getByTestId("question");

    await expect(window.getByRole("tab").getByLabel("待回答")).toBeVisible();
    await expect(window.getByTestId("run-asking")).toBeVisible();
    await expect(card.getByRole("radio", { name: /只改收件箱/ })).toContainText("推荐");
    await card.getByRole("radio", { name: /整个侧栏/ }).click();
    await expect(card.getByRole("tab", { name: "测试" })).toHaveAttribute("aria-selected", "true");
    await card.getByRole("checkbox", { name: /单元/ }).click();
    await card.getByRole("checkbox", { name: /端到端/ }).click();
    await card.getByRole("button", { name: "提交回答" }).click();

    await expect(card).toHaveCount(0);
    await expect(window.getByTestId("reply")).toHaveText(["按你选的来"], { timeout: 60_000 });
    await expect(window.getByRole("tab").getByLabel("待回答")).toHaveCount(0);
    await expect(window.getByTestId("process-summary")).toHaveText("· 问了你 2 个问题");
    await window.getByTestId("process-header").click();
    await expect(window.getByTestId("question-record")).toHaveText("范围整个侧栏测试单元、端到端");
    const [, second] = await pi.contexts();
    expect(spoken(second).slice(-1)).toStrictEqual([
      [
        "toolResult: The user answered:",
        '"这次重构改到哪为止？" = "整个侧栏"',
        '"要补哪些测试？" = "单元", "端到端"',
        "Go on with these answers in mind.",
      ].join("\n"),
    ]);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("a message sent while the questions wait replies to them: the card goes, and the agent reads it right after in the same turn", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      { blocks: [{ type: "toolCall", id: "ask-1", name: "ask_user", arguments: { questions: [SCOPE] } }] },
      { blocks: [{ type: "text", text: "收到" }] },
    ],
  });
  const scene = await createGitScene("e2e-ask-user-reply");
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, await realpath(scene.repo));
    await asked(window);

    await expect(window.getByRole("textbox", { name: "消息" })).toHaveAttribute(
      "placeholder",
      "直接回复也行：发出后代替回答，agent 接着做",
    );
    await send(window, "先别动侧栏，只修跳动");

    await expect(window.getByTestId("question")).toHaveCount(0);
    await expect(window.getByTestId("reply")).toHaveText(["收到"], { timeout: 60_000 });
    const contexts = await pi.contexts();
    expect(contexts).toHaveLength(2);
    expect(spoken(contexts[1]).slice(-2)).toStrictEqual([
      "toolResult: The user did not pick an answer and replied directly; their message follows.",
      "user: 先别动侧栏，只修跳动",
    ]);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
