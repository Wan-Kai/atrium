import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { FakeClock } from "@atrium/testkit/clock";
import { Markdown } from "./markdown";
import { ClockContext, type UiClock } from "../state/clock";
import "../styles.css";

const SOURCE = "@startuml\nAlice -> Bob: hello\n@enduml";

describe("PlantUML Markdown blocks", () => {
  it.each(["plantuml", "puml"])(
    "draws %s locally, switches to original source and opens the approved canvas",
    async (language) => {
      const screen = await render(<Markdown text={`\`\`\`${language}\n${SOURCE}\n\`\`\``} streaming={false} />);
      await vi.waitFor(
        () =>
          expect(
            screen.container.querySelector<HTMLImageElement>('img[alt="PlantUML 图表"]')?.naturalWidth,
          ).toBeGreaterThan(0),
        { timeout: 15000 },
      );
      expect(screen.container.querySelector("svg[data-source-line]")).toBeNull();
      const src = screen.container.querySelector("img")?.getAttribute("src");
      expect(src?.startsWith("blob:")).toBe(true);
      await userEvent.click(screen.getByRole("button", { name: "看源码" }));
      expect([...screen.container.querySelectorAll("pre code > span")].map((line) => line.textContent)).toStrictEqual(
        SOURCE.split("\n"),
      );
      await userEvent.click(screen.getByRole("button", { name: "看图" }));
      await userEvent.click(screen.getByRole("button", { name: "放大", exact: true }));
      const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="图片预览"]');
      expect(dialog?.matches(":modal")).toBe(true);
      await userEvent.keyboard("{Escape}");
      expect(document.querySelector("dialog[open]")).toBeNull();
    },
  );

  it("does not start a drawing or deadline for an incomplete fence", async () => {
    const time = new FakeClock();
    const clock: UiClock = {
      now: () => time.now(),
      after: (ms, run) => time.setTimeout(run, ms),
      every: () => {
        throw new Error("unused");
      },
    };
    const screen = await render(
      <ClockContext value={clock}>
        <Markdown text={`\`\`\`plantuml\n${SOURCE}`} streaming />
      </ClockContext>,
    );
    expect([...screen.container.querySelectorAll("pre code > span")].map((line) => line.textContent)).toStrictEqual(
      SOURCE.split("\n"),
    );
    expect(screen.container.querySelector('[data-testid="plantuml"]')).toBeNull();
    expect(time.pendingTimers()).toBe(0);
  });

  it("keeps the original code and a retry after a syntax failure", async () => {
    const screen = await render(
      <Markdown text={"```plantuml\n@startuml\nnot a valid diagram @@@\n@enduml\n```"} streaming={false} />,
    );
    await expect.element(screen.getByRole("button", { name: "重试" })).toBeVisible();
    expect(screen.container.querySelector("pre")?.textContent).toContain("not a valid diagram @@@");
    expect(screen.container.querySelector("img")).toBeNull();
  });

  it("releases a drawing's deadline on unmount", async () => {
    const time = new FakeClock();
    const clock: UiClock = {
      now: () => time.now(),
      after: (ms, run) => time.setTimeout(run, ms),
      every: () => {
        throw new Error("unused");
      },
    };
    const screen = await render(
      <ClockContext value={clock}>
        <Markdown text={`\`\`\`plantuml\n${SOURCE}\n\`\`\``} streaming={false} />
      </ClockContext>,
    );
    await screen.unmount();
    expect(time.pendingTimers()).toBe(0);
  });
});
