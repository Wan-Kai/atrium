import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";
import { send } from "./messages";

/** A visual that keeps drawing, as a demonstration does, and a reply long enough to scroll it away. */
const VISUAL = `<div id="demo"><canvas id="c" width="300" height="120"></canvas><button id="go">下一步</button></div>
<script>let step = 0; const draw = () => { const g = document.getElementById("c").getContext("2d"); g.clearRect(0, 0, 300, 120); g.fillText(String(step++), 10, 60); requestAnimationFrame(draw); }; draw();</script>`;

test("@leak scrolling a visual out of view and back unloads and reloads it without leaking DOM", async () => {
  const filler = Array.from({ length: 80 }, (_, line) => `第 ${line + 1} 段：演示下面的说明。`).join("\n\n");
  const pi = await fauxPiEnvironment({
    replies: [
      {
        blocks: [
          { type: "toolCall", id: "w1", name: "write", arguments: { path: "{{visuals}}/demo.html", content: VISUAL } },
        ],
      },
      {
        blocks: [
          {
            type: "text",
            text: `看演示：\n\n\`\`\`visual\n{"path":"{{visuals}}/demo.html","title":"演示"}\n\`\`\`\n\n${filler}`,
          },
        ],
      },
    ],
  });
  const launched = await launchApp(pi.env);
  const dir = await mkdtemp(join(tmpdir(), "atrium-heap-"));
  try {
    const { window } = launched;
    await send(window, "演示一下");
    const card = window.getByTestId("visual-card");
    const last = window.getByText("第 80 段：演示下面的说明。");
    await expect(last).toBeAttached({ timeout: 30_000 });
    /** Scrolls the visual into view and sees it loaded, then away and sees it unloaded. */
    const round = async () => {
      await card.scrollIntoViewIfNeeded();
      await expect(window.getByTestId("visual-frame")).toHaveCount(1);
      await expect(window.getByTestId("visual-frame").contentFrame().locator("#go")).toBeVisible();
      await last.scrollIntoViewIfNeeded();
      await expect(window.getByTestId("visual-frame")).toHaveCount(0);
      await expect(card.locator('[data-testid="visual-snapshot"], [data-testid="visual-placeholder"]')).toHaveCount(1);
    };
    await round();
    // Left alone a second in full view, the visual is captured; out of view its snapshot stands in.
    await card.scrollIntoViewIfNeeded();
    await expect(window.getByTestId("visual-frame").contentFrame().locator("#go")).toBeVisible();
    await window.waitForTimeout(1_500);
    await last.scrollIntoViewIfNeeded();
    await expect(card.getByTestId("visual-snapshot")).toHaveAttribute("src", /^data:image\/png;base64,/u);

    await takeHeapSnapshot(window, join(dir, "baseline.heapsnapshot"));
    for (let again = 0; again < 15; again++) await round();
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
