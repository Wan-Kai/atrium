import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";
import { send, sentAs } from "./messages";

test("@leak switching between three sessions back and forth leaks no DOM", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      { blocks: [{ type: "text", text: "## 回复\n\n带一个列表：\n\n- 一\n- 二\n\n```ts\nconst a = 1;\n```" }] },
    ],
  });
  const launched = await launchApp(pi.env);
  const dir = await mkdtemp(join(tmpdir(), "atrium-heap-"));
  try {
    const { window } = launched;
    const tabs = window.getByRole("tab");
    const replies = window.locator('[data-testid="reply"][data-streaming="false"]');
    await send(window, "一");
    await expect(replies).toHaveCount(1, { timeout: 30_000 });
    for (const [at, text] of ["二", "三"].entries()) {
      await window.keyboard.press("Meta+T");
      await expect(tabs).toHaveCount(at + 2);
      await expect(replies).toHaveCount(0);
      await send(window, text);
      await expect(replies).toHaveCount(1, { timeout: 30_000 });
    }
    await expect(tabs).toHaveText(["一", "二", "三"], { timeout: 30_000 });
    /** Shows a session and waits until its transcript is on screen. */
    const show = async (text: string) => {
      await tabs.filter({ hasText: text }).click();
      await expect(window.getByTestId("user-message")).toHaveText([sentAs(text)]);
      await expect(replies).toHaveCount(1);
    };
    // Every session has been shown once, so what stays cached for them is in the baseline.
    for (const text of ["一", "二", "三"]) await show(text);

    await takeHeapSnapshot(window, join(dir, "baseline.heapsnapshot"));
    for (let round = 0; round < 15; round++) for (const text of ["一", "二", "三"]) await show(text);
    await takeHeapSnapshot(window, join(dir, "final.heapsnapshot"));

    expect(
      await findDetachedDomLeaks(join(dir, "baseline.heapsnapshot"), join(dir, "final.heapsnapshot")),
    ).toStrictEqual([]);
  } finally {
    await launched.close();
    await pi.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
