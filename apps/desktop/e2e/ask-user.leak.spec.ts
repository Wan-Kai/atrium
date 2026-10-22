import { createGitScene } from "@atrium/testkit";
import { type Page, expect, test } from "@playwright/test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";
import { send } from "./messages";
import { addProject } from "./projects";

/** How many times the card comes and goes after the first, which loads it. */
const ROUNDS = 8;

/**
 * One round: send a message, answer the questions it brings by choosing or skip, and wait for the reply.
 *
 * @remarks
 * Even rounds skip, odd ones choose and send, so both ends of the card are walked.
 *
 * @sideEffects Drives the page.
 * @param window - The app's page.
 * @param index - The round, from 0.
 */
async function round(window: Page, index: number): Promise<void> {
  const card = window.getByTestId("question");
  await send(window, `第 ${String(index)} 轮`);
  await expect(card).toBeVisible({ timeout: 60_000 });
  const skip = index % 2 === 0;
  await (skip ? card.getByRole("button", { name: "跳过" }) : card.getByRole("radio", { name: /侧栏/ })).click();
  await (skip ? Promise.resolve() : card.getByRole("button", { name: "提交回答" }).click());
  await expect(card).toHaveCount(0);
  await expect(window.getByTestId("reply")).toHaveCount(index + 1, { timeout: 60_000 });
}

test("@leak the agent's questions coming and going, answered or skipped, leak no DOM (SPEC-0003)", async () => {
  const question = {
    header: "范围",
    question: "改到哪？",
    options: [
      { label: "收件箱", description: "" },
      { label: "侧栏", description: "" },
    ],
  };
  const pi = await fauxPiEnvironment({
    replies: Array.from({ length: ROUNDS + 1 }).flatMap((_, at) => [
      {
        blocks: [{ type: "toolCall", id: `ask-${String(at)}`, name: "ask_user", arguments: { questions: [question] } }],
      },
      { blocks: [{ type: "text", text: "好" }] },
    ]),
  });
  const scene = await createGitScene("e2e-ask-user-leak");
  const launched = await launchApp(pi.env);
  const dir = await mkdtemp(join(tmpdir(), "atrium-heap-"));
  try {
    const { window, app } = launched;
    await addProject(app, window, await realpath(scene.repo));
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    // The new session's tab first: typed sooner, the message is lost and no question comes.
    await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
    await round(window, 0);
    await takeHeapSnapshot(window, join(dir, "baseline.heapsnapshot"));
    for (let index = 1; index <= ROUNDS; index += 1) await round(window, index);
    await takeHeapSnapshot(window, join(dir, "final.heapsnapshot"));
    const leaks = await findDetachedDomLeaks(join(dir, "baseline.heapsnapshot"), join(dir, "final.heapsnapshot"));

    expect(leaks).toStrictEqual([]);
  } finally {
    await launched.close();
    await pi.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
