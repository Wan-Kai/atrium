import { CODEX_MODEL_LIST, FAUX_BASE_URL_ENV, startModelListServer } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

/** An hour, in milliseconds. */
const HOUR = 3_600_000;

/**
 * Answers as ChatGPT's backend does: the usage at `wham/usage`, Codex's model list otherwise.
 *
 * @remarks
 * The session's pi asks for both through Atrium's extension (ADR-0008, ADR-0010). The five-hour
 * window resets 4 h 30 min from now, the week's in three days.
 *
 * @sideEffects Writes the response.
 * @param response - The response.
 * @param request - The request.
 */
function chatgptBackend(response: ServerResponse, request: IncomingMessage): void {
  const usage = {
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 39,
        limit_window_seconds: 18_000,
        reset_at: Math.floor((Date.now() + 4 * HOUR + 30 * 60_000) / 1000),
      },
      secondary_window: {
        used_percent: 82,
        limit_window_seconds: 604_800,
        reset_at: Math.floor((Date.now() + 3 * 24 * HOUR) / 1000),
      },
    },
  };
  const body = request.url?.startsWith("/backend-api/wham/usage") === true ? usage : CODEX_MODEL_LIST;
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}

test("shows the ChatGPT subscription's usage in the status bar and the settings, asked through Atrium's extension with pi's login", async () => {
  const backend = await startModelListServer(chatgptBackend);
  const pi = await fauxPiEnvironment({
    // As ChatGPT's subscription.
    provider: "openai-codex",
    replies: [{ blocks: [{ type: "text" as const, text: "好的" }] }],
  });
  const launched = await launchApp({ ...pi.env, [FAUX_BASE_URL_ENV]: backend.baseUrl });
  try {
    const { window } = launched;
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("一");
    await box.press("Enter");
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["好的"], {
      timeout: 30_000,
    });

    const group = window.getByRole("button", { name: "套餐 82%" });
    await expect(group).toBeVisible({ timeout: 30_000 });
    await group.hover();
    const card = window.getByRole("tooltip").filter({ hasText: "套餐用量" });
    await expect(card).toBeVisible();
    const chatgpt = /ChatGPT Plus(当前)?刚刚5 小时窗口4 小时 (29|30) 分后重置39%每周周. \d\d:\d\d 重置82%/u;
    // The session's subscription, marked; Claude and Grok are not signed in, so not listed (ADR-0011).
    await expect(card).toHaveText(new RegExp(`^套餐用量${chatgpt.source}$`, "u"));
    await expect(card.getByText("当前", { exact: true })).toBeVisible();

    // The settings list the same usage, the session's not marked: the settings are no session's.
    await window.keyboard.press("Meta+Comma");
    const settings = window.getByRole("dialog", { name: "设置" });
    await settings.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "模型与账户" }).click();
    const listed = settings.getByRole("region", { name: "套餐用量" });
    await expect(listed.getByRole("region", { name: "ChatGPT Plus" })).toHaveText(chatgpt);
    await expect(listed.getByText("当前", { exact: true })).toHaveCount(0);

    const usage = backend.requests.filter(({ url }) => url.startsWith("/backend-api/wham/usage"));
    // Asked once the session's pi started; the run that followed within a minute did not ask again.
    expect(usage.map(({ headers }) => [headers["authorization"], headers["originator"]])).toStrictEqual([
      ["Bearer faux-key", "pi"],
    ]);
  } finally {
    await launched.close();
    await pi.cleanup();
    await backend.close();
  }
});
