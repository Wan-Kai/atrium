import type { ModelListView } from "@atrium/client";
import { CommandError, type CatalogModel, type ModelRef, type SetupLogin, type ThinkingLevel } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import catpawLogo from "../design/brand/catpaw.webp";
import fridayLogo from "../design/brand/friday.png";
import claudeLogo from "../design/brand/claude.svg";
import deepseekLogo from "../design/brand/deepseek.svg";
import "../styles.css";
import type { ShownModel } from "./model-choice";
import { ModelPicker, type PickerRequest } from "./model-picker";

/** A model as the catalog lists it. */
function model(providerId: string, modelId: string, name: string, fields: Partial<CatalogModel> = {}): CatalogModel {
  return {
    providerId,
    modelId,
    name,
    contextWindow: 400_000,
    maxOutput: 128_000,
    supportsImage: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    fast: null,
    ...fields,
  };
}

const SOL = model("openai-codex", "gpt-6-sol", "GPT-6 Sol");
const ASTRA = model("openai-codex", "gpt-6-astra", "GPT-6 Astra", { supportsImage: false, contextWindow: 1_000_000 });
const OPUS = model("anthropic", "claude-opus-5-5", "Claude Opus 5.5", { maxOutput: 64_000 });
const READY: ModelListView = { status: "ready", models: [SOL, ASTRA, OPUS], defaultModel: null, error: null };

/** What the button shows for `listed` at `level`. */
function shown(listed: CatalogModel, level: ThinkingLevel | null): ShownModel {
  return {
    providerId: listed.providerId,
    modelId: listed.modelId,
    name: listed.name,
    levels: listed.thinkingLevels,
    level,
    supportsImage: listed.supportsImage,
    fast: listed.fast,
  };
}

/**
 * Renders a picker at the bottom of a page, recording what it asks for.
 *
 * @sideEffects Renders.
 * @param current - The model shown.
 * @param list - The models.
 * @param options - Whether it is disabled, the request to open it there as it appears, and the
 * setup's login state (unknown unless given).
 * @returns The screen, the calls, the button, and a way to render it again with another request
 * and whether it is disabled.
 */
async function picker(
  current: ShownModel | null,
  list: ModelListView = READY,
  options: {
    readonly disabled?: boolean;
    readonly request?: PickerRequest | null;
    readonly login?: SetupLogin | null;
  } = {},
) {
  const calls: unknown[][] = [];
  /**
   * The picker in its page.
   *
   * @sideEffects none
   * @param request - The request to open it.
   * @param disabled - Whether it is disabled.
   * @returns The page.
   */
  const page = (request: PickerRequest | null, disabled: boolean) => (
    <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 520, width: 640 }}>
      <ModelPicker
        shown={current}
        list={list}
        login={options.login ?? null}
        disabled={disabled}
        onOpen={() => calls.push(["open"])}
        onRefresh={() => calls.push(["refresh"])}
        onChooseModel={(ref: ModelRef) => calls.push(["model", ref])}
        onChooseLevel={(level: ThinkingLevel) => calls.push(["level", level])}
        request={request}
      />
      <button type="button">outside</button>
    </div>
  );
  const screen = await render(page(options.request ?? null, options.disabled ?? false));
  return {
    screen,
    calls,
    chip: screen.getByRole("button", { name: /模型与推理强度/ }),
    again: async (request: PickerRequest | null, disabled = false) => screen.rerender(page(request, disabled)),
  };
}

describe("ModelPicker's button", () => {
  it("shows the model's provider icon, its name and the level", async () => {
    const { chip } = await picker(shown(SOL, "medium"));

    await expect.element(chip).toHaveTextContent("套餐GPT-6 Sol中");
    await expect.element(chip).toHaveAttribute("title", "模型与推理强度：中（⌘⇧I / ⌘⇧E）");
    expect(chip.element().querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg|\.svg/);
    await expect.element(chip).not.toHaveAttribute("data-full");
  });

  it("shows Friday branding while selecting with the original sankuai-openai ID", async () => {
    const friday = model("sankuai-openai", "gpt-friday", "Friday Model");
    const { chip, screen, calls } = await picker(shown(friday, null), { ...READY, models: [friday, SOL] });
    expect(chip.element().querySelector("img")?.getAttribute("src")).toBe(fridayLogo);
    await expect.poll(() => chip.element().querySelector("img")?.naturalWidth).toBe(80);
    await userEvent.click(chip);
    const provider = screen.getByRole("tab", { name: "Friday", exact: true });
    await expect.element(provider).toHaveAttribute("aria-selected", "true");
    expect(provider.element().querySelector("img")?.getAttribute("src")).toBe(fridayLogo);
    await expect.element(screen.getByRole("tabpanel", { name: "Friday" })).toMatchTextContent(/^Friday1 个模型/);
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Friday Model/ }));
    expect(calls).toStrictEqual([["open"], ["model", { providerId: "sankuai-openai", modelId: "gpt-friday" }]]);
  });

  for (const theme of ["light", "dark"]) {
    it(`renders the supplied CatPaw image in the button and provider list in ${theme} mode`, async () => {
      const root = document.documentElement;
      const wasDark = root.classList.contains("dark");
      root.classList.toggle("dark", theme === "dark");
      try {
        const catpaw = model("catpaw-cli", "gemini-4-argon", "Gemini 4 Argon");
        const list: ModelListView = { ...READY, models: [catpaw, SOL] };
        const { chip, screen, calls } = await picker(shown(catpaw, null), list);

        await expect.element(chip).toHaveTextContent("Gemini 4 Argon");
        expect(chip.element().querySelector("img")?.getAttribute("src")).toBe(catpawLogo);
        await expect.poll(() => chip.element().querySelector("img")?.naturalWidth).toBe(512);
        expect([
          chip.element().querySelector("img")?.getBoundingClientRect().width,
          chip.element().querySelector("img")?.getBoundingClientRect().height,
        ]).toStrictEqual([20, 20]);

        await userEvent.click(chip);
        const provider = screen.getByRole("tab", { name: "catpaw-cli", exact: true });
        await expect.element(provider).toHaveAttribute("aria-selected", "true");
        expect(provider.element().querySelector("img")?.getAttribute("src")).toBe(catpawLogo);
        await expect.poll(() => provider.element().querySelector("img")?.naturalWidth).toBe(512);
        expect([
          provider.element().querySelector("img")?.getBoundingClientRect().width,
          provider.element().querySelector("img")?.getBoundingClientRect().height,
        ]).toStrictEqual([22, 22]);
        await expect
          .element(screen.getByRole("tabpanel", { name: "catpaw-cli" }))
          .toMatchTextContent(/^catpaw-cli1 个模型/);
        expect(calls).toStrictEqual([["open"]]);
      } finally {
        root.classList.toggle("dark", wasDark);
      }
    });
  }

  it.each(["light", "dark"])(
    "hides the off label on the button but keeps the effort control in %s mode",
    async (theme) => {
      const root = document.documentElement;
      const wasDark = root.classList.contains("dark");
      root.classList.toggle("dark", theme === "dark");
      try {
        const catpaw = model("catpaw-cli", "gemini-4-argon", "Gemini 4 Argon", {
          thinkingLevels: ["off", "low", "medium", "high"],
        });
        const { chip, screen, calls } = await picker(shown(catpaw, "off"), { ...READY, models: [catpaw] });

        expect(chip.element().querySelector(".atrium-model-level")).toBeNull();
        await expect.element(chip).toHaveTextContent("Gemini 4 Argon");
        await expect.element(chip).toHaveAccessibleName("模型与推理强度：Gemini 4 Argon，关闭");
        await expect.element(chip).toHaveAttribute("title", "模型与推理强度：关闭（⌘⇧I / ⌘⇧E）");
        await userEvent.click(chip);
        const slider = screen.getByRole("slider", { name: "推理强度" });
        await expect.element(slider).toHaveAttribute("aria-valuetext", "关闭");
        (slider.element() as HTMLElement).focus();
        await userEvent.keyboard("{ArrowRight}");
        expect(calls).toStrictEqual([["open"], ["level", "low"]]);
        await expect.element(screen.getByRole("dialog")).toBeVisible();
      } finally {
        root.classList.toggle("dark", wasDark);
      }
    },
  );

  it.each([
    ["minimal", "最低"],
    ["low", "低"],
    ["medium", "中"],
    ["high", "高"],
    ["xhigh", "极高"],
    ["max", "最高"],
  ] as const)("keeps the %s level label on the button", async (level, name) => {
    const reasoner = model("anthropic", "reasoner", "Reasoner", {
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    const { chip } = await picker(shown(reasoner, level), { ...READY, models: [reasoner] });
    expect(chip.element().querySelector(".atrium-model-level")?.textContent).toBe(name);
    await expect.element(chip).toHaveTextContent(`Reasoner${name}`);
  });

  it("glows at the model's top level", async () => {
    const { chip } = await picker(shown(SOL, "xhigh"));

    await expect.element(chip).toHaveAttribute("data-full");
    await expect.element(chip).toHaveTextContent("套餐GPT-6 Sol极高");
  });

  it("shows a provider it has no icon for by its first letter, and no level when unknown", async () => {
    const { chip } = await picker({ ...shown(SOL, null), providerId: "acme", name: "acme-1" });

    await expect.element(chip).toHaveTextContent("Aacme-1");
  });

  it("asks to choose a model when it knows none", async () => {
    const { chip } = await picker(null);

    await expect.element(chip).toHaveTextContent("选择模型");
  });

  it("cannot be used while it is disabled", async () => {
    const { chip } = await picker(shown(SOL, "low"), READY, { disabled: true });

    await expect.element(chip).toBeDisabled();
  });
});

describe("ModelPicker's panel", () => {
  it("opens above the button, asks for the list, and lists the providers, then the current one's models with their basics", async () => {
    const { screen, chip, calls } = await picker(shown(SOL, "medium"));

    await userEvent.click(chip);

    const panel = screen.getByRole("dialog", { name: "模型与推理强度" });
    await expect.element(panel).toBeVisible();
    expect(panel.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
      chip.element().getBoundingClientRect().top,
    );
    expect(calls).toStrictEqual([["open"]]);
    const providers = screen.getByRole("tablist", { name: "服务商" }).getByRole("tab");
    expect(
      providers.elements().map((tab) => [tab.getAttribute("aria-label"), tab.getAttribute("aria-selected")]),
    ).toStrictEqual([
      ["ChatGPT 订阅", "true"],
      ["Anthropic", "false"],
    ]);
    await expect
      .element(screen.getByRole("tabpanel", { name: "ChatGPT 订阅" }))
      .toMatchTextContent(/^ChatGPT 订阅套餐2 个模型/);
    const rows = screen.getByRole("menuitemradio");
    expect(rows.elements().map((row) => row.textContent)).toStrictEqual([
      "GPT-6 Sol上下文 400K · 输出 128K · 支持图片",
      "GPT-6 Astra上下文 1M · 输出 128K",
    ]);
    await expect.element(rows.nth(0)).toHaveAttribute("aria-checked", "true");
    await expect.element(rows.nth(1)).toHaveAttribute("aria-checked", "false");
    await expect.element(screen.getByRole("slider", { name: "推理强度" })).toHaveAttribute("aria-valuetext", "中");
  });

  it("shows another provider's models on a click on its icon, not on hover, the panel keeping its size", async () => {
    const { screen, chip } = await picker(shown(SOL, "medium"));
    await userEvent.click(chip);
    const panel = screen.getByRole("dialog").element().getBoundingClientRect();
    const anthropic = screen.getByRole("tab", { name: "Anthropic" });

    await userEvent.hover(anthropic);
    await expect.element(screen.getByRole("tab", { name: "ChatGPT 订阅" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(anthropic);

    await expect.element(anthropic).toHaveAttribute("aria-selected", "true");
    await expect.element(screen.getByRole("tabpanel", { name: "Anthropic" })).toMatchTextContent(/^Anthropic1 个模型/);
    expect(
      screen
        .getByRole("menuitemradio")
        .elements()
        .map((row) => [row.textContent, row.getAttribute("aria-checked")]),
    ).toStrictEqual([["Claude Opus 5.5上下文 400K · 输出 64K · 支持图片", "false"]]);
    const after = screen.getByRole("dialog").element().getBoundingClientRect();
    expect([after.width, after.height]).toStrictEqual([panel.width, panel.height]);
  });

  it("opens on the current model's provider, marked", async () => {
    const { screen, chip } = await picker(shown(OPUS, "medium"));
    await userEvent.click(chip);

    await expect.element(screen.getByRole("tab", { name: "Anthropic" })).toHaveAttribute("aria-selected", "true");
    await expect
      .element(screen.getByRole("tab", { name: "Anthropic" }).getByRole("img", { name: "当前模型" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("tab", { name: "ChatGPT 订阅" }).getByRole("img", { name: "当前模型" }))
      .not.toBeInTheDocument();
  });

  it("opens on the first provider, unmarked, when there is no current model", async () => {
    const { screen, chip } = await picker(null);
    await userEvent.click(chip);

    await expect.element(screen.getByRole("tab", { name: "ChatGPT 订阅" })).toHaveAttribute("aria-selected", "true");
    await expect.element(screen.getByRole("img", { name: "当前模型" })).not.toBeInTheDocument();
  });

  it("lays the providers' icons in a narrow column beside a column of models that keeps its height", async () => {
    const { screen, chip } = await picker(shown(SOL, "medium"));
    await userEvent.click(chip);

    const panel = screen.getByRole("dialog").element().getBoundingClientRect();
    const tab = screen.getByRole("tab", { name: "ChatGPT 订阅" }).element();
    const icon = tab.querySelector("img")?.getBoundingClientRect();
    const models = screen.getByRole("tabpanel").element().getBoundingClientRect();
    expect([panel.width, tab.getBoundingClientRect().width, tab.getBoundingClientRect().height]).toStrictEqual([
      372, 44, 40,
    ]);
    expect([icon?.width, icon?.height]).toStrictEqual([22, 22]);
    expect([models.left - tab.getBoundingClientRect().right, models.height]).toStrictEqual([12, 320]);
    expect(getComputedStyle(tab).backgroundColor).toBe("rgba(0, 0, 0, 0.06)");
    const dot = screen.getByRole("img", { name: "当前模型" }).element().getBoundingClientRect();
    expect([
      dot.width,
      dot.top - tab.getBoundingClientRect().top,
      tab.getBoundingClientRect().right - dot.right,
    ]).toStrictEqual([6, 6, 7]);
  });

  it("says a provider's name to the left of its icon while hovered or focused", async () => {
    const { screen, chip } = await picker(shown(SOL, "medium"));
    await userEvent.click(chip);
    const anthropic = screen.getByRole("tab", { name: "Anthropic" });

    await userEvent.hover(anthropic);

    const tip = screen.getByRole("tooltip");
    await expect.element(tip).toHaveTextContent("Anthropic");
    const box = anthropic.element().getBoundingClientRect();
    const said = tip.element().getBoundingClientRect();
    expect([
      Math.round(box.left - said.right),
      Math.round(said.top + said.height / 2 - (box.top + box.height / 2)),
    ]).toStrictEqual([8, 0]);
    await userEvent.unhover(anthropic);
    await expect.element(screen.getByRole("tooltip")).not.toBeInTheDocument();

    (screen.getByRole("tab", { name: "ChatGPT 订阅" }).element() as HTMLElement).focus();
    await expect.element(screen.getByRole("tooltip")).toHaveTextContent("ChatGPT 订阅");
  });

  it("marks the models with Fast with a bolt after their names", async () => {
    const fast = model("openai-codex", "gpt-5.5", "GPT-5.5", { fast: { speed: 1.5, moreUsage: true } });
    const { screen, chip } = await picker(shown(fast, "high"), { ...READY, models: [fast, SOL] });

    await userEvent.click(chip);

    const rows = screen.getByRole("menuitemradio");
    await expect.element(rows.nth(0).getByRole("img", { name: "支持 Fast" })).toBeVisible();
    expect(rows.nth(1).element().querySelector('[aria-label="支持 Fast"]')).toBeNull();
  });

  it("switches the model on a click and closes", async () => {
    const { screen, chip, calls } = await picker(shown(SOL, "medium"));
    await userEvent.click(chip);

    await userEvent.click(screen.getByRole("tab", { name: "Anthropic" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Claude Opus 5.5/ }));

    expect(calls).toStrictEqual([["open"], ["model", { providerId: "anthropic", modelId: "claude-opus-5-5" }]]);
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("changes the thinking level without closing", async () => {
    const { screen, chip, calls } = await picker(shown(SOL, "medium"));
    await userEvent.click(chip);

    (screen.getByRole("slider").element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(calls).toStrictEqual([["open"], ["level", "high"]]);
    await expect.element(screen.getByRole("dialog")).toBeVisible();
  });

  it("says a model that does not think has no levels", async () => {
    const plain = model("anthropic", "haiku", "Haiku", { thinkingLevels: ["off"] });
    const { screen, chip } = await picker(shown(plain, "off"), { ...READY, models: [plain] });
    await expect.element(chip).toHaveTextContent("Haiku");
    expect(chip.element().querySelector(".atrium-model-level")).toBeNull();
    await userEvent.click(chip);

    await expect.element(screen.getByText("这个模型不推理")).toBeVisible();
    await expect.element(screen.getByRole("slider")).not.toBeInTheDocument();
  });

  it("asks pi again on 刷新", async () => {
    const { screen, chip, calls } = await picker(shown(SOL, "medium"));
    await userEvent.click(chip);

    await userEvent.click(screen.getByRole("button", { name: "刷新模型列表" }));

    expect(calls).toStrictEqual([["open"], ["refresh"]]);
  });

  it("shows the old list while asking again, and says so", async () => {
    const { screen, chip } = await picker(shown(SOL, "medium"), { ...READY, status: "loading" });
    await userEvent.click(chip);

    await expect.element(screen.getByRole("button", { name: "刷新模型列表" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("menuitemradio").elements()).toHaveLength(2);
  });

  it("says it is reading before the first list arrives", async () => {
    const { screen, chip } = await picker(null, { status: "loading", models: [], defaultModel: null, error: null });
    await userEvent.click(chip);

    await expect.element(screen.getByText("正在读取模型…")).toBeVisible();
  });

  it("explains a failed list, with pi's own words behind a fold, and retries", async () => {
    const failed: ModelListView = {
      status: "failed",
      models: [],
      defaultModel: null,
      error: new CommandError("models_unavailable", { detail: "pi crashed" }),
    };
    const { screen, chip, calls } = await picker(shown(SOL, "medium"), failed);
    await userEvent.click(chip);

    await expect.element(screen.getByText("读不到模型列表")).toBeVisible();
    await userEvent.click(screen.getByText("展开看原始报错"));
    await expect.element(screen.getByText("pi crashed")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(calls).toStrictEqual([["open"], ["refresh"]]);
  });

  it("says when no provider is logged in", async () => {
    const { screen, chip } = await picker(null, { status: "ready", models: [], defaultModel: null, error: null });
    await userEvent.click(chip);

    await expect.element(screen.getByText("没有可用的模型，先在 pi 里登录一个服务商")).toBeVisible();
  });

  it("closes on Escape and on a click outside", async () => {
    const { screen, chip } = await picker(shown(SOL, "medium"));
    await userEvent.click(chip);
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(chip);
    await userEvent.click(screen.getByRole("button", { name: "outside" }));
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens only the models on ⌘⇧I, and only the thinking level, focused, on ⌘⇧E", async () => {
    const { screen } = await picker(shown(SOL, "medium"));

    await userEvent.keyboard("{Meta>}{Shift>}i{/Shift}{/Meta}");
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("menuitemradio").elements()).toHaveLength(2);
    await expect.element(screen.getByRole("slider")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await userEvent.keyboard("{Meta>}{Shift>}e{/Shift}{/Meta}");
    await expect.element(screen.getByRole("slider")).toHaveFocus();
    expect(screen.getByRole("menuitemradio").elements()).toHaveLength(0);
  });

  it("opens a part on each new request as its shortcut does, but not on the one there as it appears", async () => {
    const { screen, calls, again } = await picker(shown(SOL, "medium"), READY, { request: { part: "model", id: 1 } });
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();

    await again({ part: "model", id: 2 });
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("menuitemradio").elements()).toHaveLength(2);
    await expect.element(screen.getByRole("slider")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await again({ part: "model", id: 2 });
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();

    await again({ part: "effort", id: 3 });
    await expect.element(screen.getByRole("slider")).toHaveFocus();
    expect(screen.getByRole("menuitemradio").elements()).toHaveLength(0);
    expect(calls).toStrictEqual([["open"], ["open"]]);
  });

  it("does not open on a request while disabled, nor on that request once enabled", async () => {
    const { screen, calls, again } = await picker(shown(SOL, "medium"), READY, { disabled: true });

    await again({ part: "model", id: 1 }, true);
    await again({ part: "model", id: 1 });

    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    expect(calls).toStrictEqual([]);
  });

  it("does not open from the keyboard while disabled", async () => {
    const { screen } = await picker(shown(SOL, "medium"), READY, { disabled: true });

    await userEvent.keyboard("{Meta>}{Shift>}i{/Shift}{/Meta}");

    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  });
});

const BRIDGED = model("claude-bridge", "claude-opus-5-5", "Claude Opus 5.5");
const DEEPSEEK = model("deepseek", "deepseek-v4", "DeepSeek V4");
const COPILOT = model("github-copilot", "gpt-5.5", "GPT-5.5");
const GPT = model("openai", "gpt-5.5", "GPT-5.5");
const GROK = model("xai", "grok-4.7", "Grok 4.7");

/**
 * Each provider tab's name and whether it carries the plan tag.
 *
 * @remarks
 * The tag is the "走套餐" image inside the tab.
 *
 * @sideEffects none
 * @param screen - The rendered picker, its panel open.
 * @returns The tabs' names and tags, in order.
 */
function tagged(screen: Awaited<ReturnType<typeof picker>>["screen"]): [string | null, boolean][] {
  return screen
    .getByRole("tablist", { name: "服务商" })
    .getByRole("tab")
    .elements()
    .map((tab) => [tab.getAttribute("aria-label"), tab.querySelector('[role="img"][aria-label="走套餐"]') !== null]);
}

describe("ModelPicker's plan tag", () => {
  it("tags the providers on a plan in the column, after the name above their models, and on the button", async () => {
    const list: ModelListView = { ...READY, models: [BRIDGED, OPUS, DEEPSEEK, SOL, COPILOT] };
    const { screen, chip } = await picker(shown(BRIDGED, "high"), list);

    const chipTag = chip.getByRole("img", { name: "走套餐" });
    await expect.element(chipTag).toHaveTextContent("套餐");
    const icon = chip.element().querySelector("img")?.getBoundingClientRect();
    const onChip = chipTag.element().getBoundingClientRect();
    expect([icon?.right, icon?.bottom, onChip.height]).toStrictEqual([onChip.right - 8, onChip.bottom - 4, 12]);
    await userEvent.click(chip);

    expect(tagged(screen)).toStrictEqual([
      ["Claude 订阅", true],
      ["Anthropic", false],
      ["DeepSeek", false],
      ["ChatGPT 订阅", true],
      ["GitHub Copilot", true],
    ]);
    const tab = screen.getByRole("tab", { name: "Claude 订阅" });
    const tag = tab.getByRole("img", { name: "走套餐" });
    await expect.element(tag).toHaveTextContent("套餐");
    const box = tab.element().getBoundingClientRect();
    const at = tag.element().getBoundingClientRect();
    const dot = tab.getByRole("img", { name: "当前模型" }).element().getBoundingClientRect();
    expect([box.right - at.right, box.bottom - at.bottom, at.height, at.top >= dot.bottom]).toStrictEqual([
      1,
      3,
      12,
      true,
    ]);
    const style = getComputedStyle(tag.element());
    expect([style.backgroundColor, style.color, style.fontSize, style.fontWeight]).toStrictEqual([
      "rgb(47, 111, 237)",
      "rgb(255, 255, 255)",
      "8px",
      "600",
    ]);
    const header = screen.getByRole("tabpanel", { name: "Claude 订阅" });
    await expect.element(header).toMatchTextContent(/^Claude 订阅套餐1 个模型/);
    const said = header.getByText("套餐", { exact: true }).element();
    expect([getComputedStyle(said).color, getComputedStyle(said).fontSize]).toStrictEqual([
      "rgb(47, 111, 237)",
      "11px",
    ]);
  });

  it("selects native Claude without a plan tag even with OAuth, on the button, tab or header", async () => {
    const login: SetupLogin = {
      state: "ready",
      providers: [
        {
          providerId: "anthropic",
          name: "Anthropic",
          oauth: { label: "Claude", subscription: true },
          apiKey: true,
          signedIn: { method: "oauth", stored: true },
        },
      ],
    };
    const { screen, chip, calls } = await picker(shown(OPUS, "high"), READY, { login });

    await expect.element(chip.getByRole("img", { name: "走套餐" })).not.toBeInTheDocument();
    await userEvent.click(chip);

    expect(tagged(screen)).toStrictEqual([
      ["ChatGPT 订阅", true],
      ["Anthropic", false],
    ]);
    const panel = screen.getByRole("tabpanel", { name: "Anthropic" });
    await expect.element(panel).toMatchTextContent(/^Anthropic1 个模型/);
    await expect.element(panel.getByText("套餐", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(panel.getByRole("menuitemradio", { name: /Claude Opus 5.5/ }));

    expect(calls).toStrictEqual([["open"], ["model", { providerId: "anthropic", modelId: "claude-opus-5-5" }]]);
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("tags OpenAI and xAI only while signed in to them through OAuth", async () => {
    const list: ModelListView = { ...READY, models: [GPT, GROK] };
    const login: SetupLogin = {
      state: "ready",
      providers: [
        {
          providerId: "openai",
          name: "OpenAI",
          oauth: null,
          apiKey: true,
          signedIn: { method: "oauth", stored: true },
        },
        { providerId: "xai", name: "xAI", oauth: null, apiKey: true, signedIn: { method: "api_key", stored: true } },
      ],
    };
    const { screen, chip } = await picker(shown(GPT, "high"), list, { login });

    await expect.element(chip.getByRole("img", { name: "走套餐" })).toBeVisible();
    await userEvent.click(chip);

    expect(tagged(screen)).toStrictEqual([
      ["OpenAI", true],
      ["xAI", false],
    ]);
    await expect.element(screen.getByRole("tabpanel", { name: "OpenAI" })).toMatchTextContent(/^OpenAI套餐1 个模型/);
  });

  it("does not tag OpenAI or xAI while the login state is unknown", async () => {
    const { screen, chip } = await picker(shown(GROK, "high"), { ...READY, models: [GPT, GROK] });

    await expect.element(chip.getByRole("img", { name: "走套餐" })).not.toBeInTheDocument();
    await userEvent.click(chip);

    expect(tagged(screen)).toStrictEqual([
      ["OpenAI", false],
      ["xAI", false],
    ]);
  });

  it("shows claude-bridge as Claude 订阅 with Claude's icon, and DeepSeek with its own icon, not a letter", async () => {
    const { screen, chip } = await picker(shown(DEEPSEEK, "high"), { ...READY, models: [BRIDGED, DEEPSEEK] });

    expect(chip.element().querySelector("img")?.getAttribute("src")).toBe(deepseekLogo);
    await expect.element(chip).toHaveTextContent("DeepSeek V4高");
    await userEvent.click(chip);

    const tabs = screen.getByRole("tab").elements();
    expect(
      tabs.map((tab) => [
        tab.getAttribute("aria-label"),
        tab.querySelector("img")?.getAttribute("src"),
        tab.textContent,
      ]),
    ).toStrictEqual([
      ["Claude 订阅", claudeLogo, "套餐"],
      ["DeepSeek", deepseekLogo, ""],
    ]);
  });
});
