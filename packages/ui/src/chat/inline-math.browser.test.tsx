import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import { Markdown } from "./markdown";

/**
 * The only render in this file, so KaTeX starts unloaded here: `$…$` alone has to ask for it.
 *
 * @remarks
 * SPEC-0001 ("回复渲染") loads KaTeX the first time a reply has a formula. The text is normalized
 * before that check, so a single-dollar formula counts; were the check to look at the reply as
 * written, nothing would load and the formula would stay as text.
 *
 * @sideEffects Renders into the test page and imports the math plugin.
 */
it("loads KaTeX for a reply whose only formula is written with single dollars", async () => {
  const screen = await render(<Markdown text="斜率 $m$ 是公式" streaming={false} />);

  await vi.waitFor(() => expect(screen.container.querySelectorAll(".katex")).toHaveLength(1), { timeout: 10_000 });
  expect(screen.container.textContent).toContain("是公式");
});
