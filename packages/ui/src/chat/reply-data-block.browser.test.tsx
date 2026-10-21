import { code } from "@streamdown/code";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Streamdown, type PluginConfig } from "streamdown";
import { FakeClock } from "@atrium/testkit/clock";
import { ClockContext, type UiClock } from "../state/clock";
import { ReplyDataBlock } from "./reply-data-block";
import { OpenFileContext } from "./file-opener";
import { ReplyFile } from "./reply-file";
import "../styles.css";

const PLUGINS: PluginConfig = { code, renderers: [{ language: ["json", "csv"], component: ReplyDataBlock }] };

/** Renders the public component through Streamdown's actual code-plugin context.
 * @remarks This exercises source highlighting and renderer props without changing Markdown's registration.
 * @sideEffects none
 * @param props - Source, language and whether the fence is still streaming.
 * @returns A real Streamdown renderer.
 */
function Example({
  source,
  language = "json",
  incomplete = false,
}: {
  readonly source: string;
  readonly language?: string;
  readonly incomplete?: boolean;
}) {
  return (
    <Streamdown
      className="atrium-markdown"
      plugins={PLUGINS}
      translations={{ copyCode: "复制", copied: "已复制" }}
    >{`\`\`\`${language}\n${source}${incomplete ? "" : "\n```"}`}</Streamdown>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark");
});

/** Resolves relative luminance from computed sRGB channels.
 * @remarks Chromium resolves this surface's token and color-mix colors to these two forms.
 * @sideEffects none
 * @param color - A computed color.
 * @returns Its WCAG luminance.
 */
function luminance(color: string): number {
  if (!color.startsWith("rgb(") && !color.startsWith("color(srgb")) throw new Error("unexpected computed color");
  const divisor = color.startsWith("rgb(") ? 255 : 1;
  const values = (color.match(/[0-9.]+/gu) ?? [])
    .slice(0, 3)
    .map((part) => Number(part) / divisor)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return (values[0] ?? 0) * 0.2126 + (values[1] ?? 0) * 0.7152 + (values[2] ?? 0) * 0.0722;
}

/** Computes WCAG contrast for Chromium's resolved RGB or color(srgb) values.
 * @remarks The threshold comes from WCAG AA, independent of the chosen token or mix formula.
 * @sideEffects none
 * @param foreground - Computed text color.
 * @param background - Computed opaque background color.
 * @returns The relative-luminance contrast ratio.
 */
function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("reply data blocks", () => {
  it("keeps data values and inline file references at WCAG AA in both appearances", async () => {
    document.documentElement.classList.remove("dark");
    const screen = await render(
      <OpenFileContext value={() => () => undefined}>
        <Example source={'{"label":"visible string","count":42,"enabled":true}'} />
        <ReplyFile source="src/auth.ts:42" inline="true">
          src/auth.ts:42
        </ReplyFile>
      </OpenFileContext>,
    );
    await screen.getByRole("button", { name: "查看数据" }).click();
    const file = screen.getByRole("button", { name: "src/auth.ts:42" }).element();
    const values = [...screen.container.querySelectorAll(".atrium-reply-data-value"), file];
    const surface = screen.container.querySelector(".atrium-reply-data")!;
    expect(values).toHaveLength(4);
    expect(getComputedStyle(file).backgroundColor).toBe(getComputedStyle(surface).backgroundColor);
    values.forEach((value) =>
      expect(contrast(getComputedStyle(value).color, getComputedStyle(surface).backgroundColor)).toBeGreaterThanOrEqual(
        4.5,
      ),
    );
    document.documentElement.classList.add("dark");
    expect(getComputedStyle(file).backgroundColor).toBe(getComputedStyle(surface).backgroundColor);
    values.forEach((value) =>
      expect(contrast(getComputedStyle(value).color, getComputedStyle(surface).backgroundColor)).toBeGreaterThanOrEqual(
        4.5,
      ),
    );
  });
  it("keeps JSON as highlighted source until requested, opens only the root and retains exact values", async () => {
    const source = '{"id":9223372036854775807,"id":-0,"nested":{"safe":"<b>hello</b>"},"list":[false,null]}';
    const screen = await render(<Example source={source} />);
    await expect.element(screen.getByRole("button", { name: "查看数据" })).toBeVisible();
    expect(screen.getByRole("button", { name: "查看数据" }).element().getBoundingClientRect().width).toBeGreaterThan(
      50,
    );
    await vi.waitFor(() => expect(screen.container.querySelector("pre")?.textContent).toContain(source));
    await vi.waitFor(() => expect(screen.container.querySelectorAll("pre span[style]").length).toBeGreaterThan(0));
    expect(screen.container.querySelector("details")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "查看数据" }));
    expect(screen.container.querySelector("pre")).toBeNull();
    const details = screen.container.querySelectorAll("details");
    expect([...details].map((detail) => detail.open)).toStrictEqual([true, false, false]);
    expect(screen.container.textContent).toContain("9223372036854775807");
    expect(screen.container.textContent).toContain("-0");
    expect(screen.container.querySelector("b")).toBeNull();
    await userEvent.click(screen.getByText('"nested"', { exact: true }));
    expect(details[1]?.open).toBe(true);
    expect(screen.container.textContent).toContain("<b>hello</b>");
    await userEvent.click(screen.getByRole("button", { name: "源码", exact: true }));
    await vi.waitFor(() => expect(screen.container.querySelector("pre")?.textContent).toContain(source));
  });

  it("defaults complete CSV to a semantic table without evaluating or linking cells", async () => {
    const source = 'name,note\nalpha,"two, parts"\nbeta,"two\nlines"\n=1+2,<img src=x>';
    const screen = await render(<Example language="csv" source={source} />);
    expect([...screen.container.querySelectorAll("th")].map((cell) => [cell.scope, cell.textContent])).toStrictEqual([
      ["col", "name"],
      ["col", "note"],
    ]);
    expect([...screen.container.querySelectorAll("td")].map((cell) => cell.textContent)).toStrictEqual([
      "alpha",
      "two, parts",
      "beta",
      "two\nlines",
      "=1+2",
      "<img src=x>",
    ]);
    expect(screen.container.querySelector("pre, img, a, script")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "源码", exact: true }));
    expect(screen.container.querySelector("table")).toBeNull();
    await vi.waitFor(() => expect(screen.container.querySelector("pre")?.textContent).toContain("<img src=x>"));
    await userEvent.click(screen.getByRole("button", { name: "查看数据" }));
    expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it.each(["false", "null", "9223372036854775807", '"<img src=x>"'])(
    "renders top-level JSON %s as inert exact text",
    async (source) => {
      const screen = await render(<Example source={source} />);
      await userEvent.click(screen.getByRole("button", { name: "查看数据" }));
      expect(screen.container.querySelector('[aria-label="JSON 数据"]')?.textContent).toBe(source);
      expect(screen.container.querySelector("img, a, script, details")).toBeNull();
    },
  );

  it.each([
    ['{"x":}', "数据无法解析，保留源码。"],
    ["[".repeat(65) + "0" + "]".repeat(65), "JSON 超过 64 层，保留源码。"],
    ['"' + "中".repeat(21845) + '"', "内容超过 64 KiB，保留源码。"],
  ])("does not eagerly parse JSON and retains original code on failure", async (source, explanation) => {
    const screen = await render(<ReplyDataBlock code={source} language="json" isIncomplete={false} />);
    expect(screen.container.querySelector('[role="status"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "查看数据" }));
    await expect.element(screen.getByRole("status")).toHaveTextContent(explanation);
    expect(screen.container.querySelector('[aria-label="JSON 数据"]')).toBeNull();
    expect(screen.container.querySelector("pre")?.textContent).toBe(source);
  });

  it("falls back from malformed CSV without exposing partial rows", async () => {
    const source = 'a,b\n1,2\n"unfinished';
    const screen = await render(<ReplyDataBlock code={source} language="csv" isIncomplete={false} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("数据无法解析，保留源码。");
    expect(screen.container.querySelector("table")).toBeNull();
    expect([...screen.container.querySelectorAll("pre code > span")].map((line) => line.textContent)).toStrictEqual([
      "a,b",
      "1,2",
      '"unfinished',
    ]);
  });

  it.each([
    ["json", '{"a":1}', 0, 1],
    ["csv", "a,b\n1,2", 1, 0],
  ] as const)(
    "never parses an incomplete %s fence and applies its default only after completion",
    async (language, source, tables, viewButtons) => {
      const screen = await render(<ReplyDataBlock code={source} language={language} isIncomplete />);
      expect(screen.container.querySelector("table, details")).toBeNull();
      expect(screen.getByRole("button", { name: "查看数据" }).elements()).toHaveLength(0);
      await expect.element(screen.getByRole("status")).toHaveTextContent("代码块未闭合，保留源码。");
      await screen.rerender(<ReplyDataBlock code={source} language={language} isIncomplete={false} />);
      expect(screen.container.querySelector('[role="status"]')).toBeNull();
      expect(screen.container.querySelectorAll("table")).toHaveLength(tables);
      expect(screen.getByRole("button", { name: "查看数据" }).elements()).toHaveLength(viewButtons);
    },
  );

  it.each(["json", "csv"])("keeps empty %s as source with a short explanation", async (language) => {
    const screen = await render(<ReplyDataBlock code="" language={language} isIncomplete={false} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("内容为空，保留源码。");
    expect(screen.container.querySelector("table, details")).toBeNull();
    expect(screen.container.querySelector("pre")).not.toBeNull();
  });

  it("resets parse errors, view choice and expansion on source or language changes without a Markdown remount", async () => {
    const screen = await render(<ReplyDataBlock code='{"bad":}' language="json" isIncomplete={false} />);
    await userEvent.click(screen.getByRole("button", { name: "查看数据" }));
    await expect.element(screen.getByRole("status")).toHaveTextContent("数据无法解析，保留源码。");
    const source = '{"nested":{"x":1}}';
    await screen.rerender(<ReplyDataBlock code={source} language="json" isIncomplete={false} />);
    expect(screen.container.querySelector('[role="status"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "查看数据" }));
    await userEvent.click(screen.getByText('"nested"', { exact: true }));
    expect([...screen.container.querySelectorAll("details")].map((detail) => detail.open)).toStrictEqual([true, true]);
    await screen.rerender(<ReplyDataBlock code='{"nested":{"x":2}}' language="json" isIncomplete={false} />);
    expect(screen.container.querySelector("details")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "查看数据" }));
    expect([...screen.container.querySelectorAll("details")].map((detail) => detail.open)).toStrictEqual([true, false]);
    await screen.rerender(<ReplyDataBlock code="false" language="json" isIncomplete={false} />);
    await screen.rerender(<ReplyDataBlock code="false" language="csv" isIncomplete={false} />);
    expect(screen.container.querySelector("th")?.textContent).toBe("false");
    await screen.rerender(<ReplyDataBlock code="false" language="json" isIncomplete={false} />);
    expect(screen.container.querySelector("table")).toBeNull();
    await expect.element(screen.getByRole("button", { name: "查看数据" })).toBeVisible();
  });

  it("keeps a CSV source choice and JSON expansion through theme changes", async () => {
    const source = "a,b\n1,2";
    const screen = await render(<Example language="csv" source={source} />);
    await userEvent.click(screen.getByRole("button", { name: "源码", exact: true }));
    document.documentElement.classList.add("dark");
    await screen.rerender(<Example language="csv" source={source} />);
    expect(screen.container.querySelector("table")).toBeNull();
    await expect.element(screen.getByRole("button", { name: "查看数据" })).toBeVisible();
    await screen.rerender(<Example source='{"nested":{"x":1}}' />);
    await userEvent.click(screen.getByRole("button", { name: "查看数据" }));
    await userEvent.click(screen.getByText('"nested"', { exact: true }));
    document.documentElement.classList.remove("dark");
    await screen.rerender(<Example source='{"nested":{"x":1}}' />);
    expect([...screen.container.querySelectorAll("details")].map((detail) => detail.open)).toStrictEqual([true, true]);
  });

  it("copies complete original source in both views and releases UiClock feedback on unmount", async () => {
    const time = new FakeClock();
    const clock: UiClock = {
      now: () => time.now(),
      every: () => {
        throw new Error("unused");
      },
      after: (ms, run) => time.setTimeout(run, ms),
    };
    const written = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const source = '\uFEFFa,b\r\n"x,y",=1+2\r\n';
    const screen = await render(
      <ClockContext value={clock}>
        <ReplyDataBlock code={source} language="csv" isIncomplete={false} />
      </ClockContext>,
    );
    await userEvent.click(screen.getByRole("button", { name: "复制原文" }));
    expect(written).toHaveBeenLastCalledWith(source);
    await expect.element(screen.getByRole("button", { name: "复制原文" })).toHaveAttribute("data-copied", "true");
    expect(time.pendingTimers()).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "源码", exact: true }));
    expect(time.pendingTimers()).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "复制原文" }));
    expect(written).toHaveBeenCalledTimes(2);
    expect(written).toHaveBeenLastCalledWith(source);
    expect(time.pendingTimers()).toBe(1);
    await screen.unmount();
    expect(time.pendingTimers()).toBe(0);
  });
});
