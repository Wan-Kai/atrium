import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

test("sends a message and streams the reply, reasoning first, until the run settles", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      {
        blocks: [
          { type: "thinking", text: "先想一想怎么回答。" },
          { type: "text", text: "## 你好\n\n这是 **faux** 的回复，带一个列表：\n\n- 一\n- 二" },
        ],
      },
    ],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    await window.getByRole("textbox", { name: "消息" }).fill("你好");
    await window.getByRole("textbox", { name: "消息" }).press("Enter");

    await expect(window.getByTestId("user-message")).toHaveCount(1, { timeout: 30_000 });
    await expect(window.getByTestId("user-message")).toContainText("你好");
    const reply = window.locator('[data-testid="assistant-message"][data-streaming="false"]');
    await expect(reply).toContainText("这是 faux 的回复，带一个列表：", { timeout: 30_000 });
    await expect(reply.locator("h2")).toHaveText("你好");
    await expect(reply.locator("li")).toHaveText(["一", "二"]);
    await expect(window.getByRole("button", { name: "思考过程" })).toBeVisible();
    await expect(window.getByTestId("run-status")).toHaveCount(0);
    await expect(window.locator('[data-testid="user-message"][data-pending="true"]')).toHaveCount(0);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
