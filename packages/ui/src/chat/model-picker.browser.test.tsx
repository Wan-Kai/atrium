import type { ModelListView } from "@atrium/client";
import { CommandError, type CatalogModel, type ModelRef, type ThinkingLevel } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import type { ShownModel } from "./model-choice";
import { ModelPicker } from "./model-picker";

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

/** Renders a picker at the bottom of a page, recording what it asks for. */
async function picker(
  current: ShownModel | null,
  list: ModelListView = READY,
  options: { readonly disabled?: boolean } = {},
) {
  const calls: unknown[][] = [];
  const screen = await render(
    <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 520, width: 640 }}>
      <ModelPicker
        shown={current}
        list={list}
        disabled={options.disabled ?? false}
        onOpen={() => calls.push(["open"])}
        onRefresh={() => calls.push(["refresh"])}
        onChooseModel={(ref: ModelRef) => calls.push(["model", ref])}
        onChooseLevel={(level: ThinkingLevel) => calls.push(["level", level])}
      />
      <button type="button">outside</button>
    </div>,
  );
  return { screen, calls, chip: screen.getByRole("button", { name: /模型与推理强度/ }) };
}

describe("ModelPicker's button", () => {
  it("shows the model's provider icon, its name and the level", async () => {
    const { chip } = await picker(shown(SOL, "medium"));

    await expect.element(chip).toHaveTextContent("GPT-6 Sol中");
    await expect.element(chip).toHaveAttribute("title", "模型与推理强度：中（⌘⇧I / ⌘⇧E）");
    expect(chip.element().querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg|\.svg/);
    await expect.element(chip).not.toHaveAttribute("data-full");
  });

  it("glows at the model's top level", async () => {
    const { chip } = await picker(shown(SOL, "xhigh"));

    await expect.element(chip).toHaveAttribute("data-full");
    await expect.element(chip).toHaveTextContent("GPT-6 Sol极高");
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
  it("opens above the button, asks for the list, and lists the models by provider with their basics", async () => {
    const { screen, chip, calls } = await picker(shown(SOL, "medium"));

    await userEvent.click(chip);

    const panel = screen.getByRole("dialog", { name: "模型与推理强度" });
    await expect.element(panel).toBeVisible();
    expect(panel.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
      chip.element().getBoundingClientRect().top,
    );
    expect(calls).toStrictEqual([["open"]]);
    await expect.element(screen.getByRole("group", { name: "ChatGPT 订阅" })).toBeVisible();
    await expect.element(screen.getByRole("group", { name: "Anthropic" })).toBeVisible();
    const rows = screen.getByRole("menuitemradio");
    expect(rows.elements().map((row) => row.textContent)).toStrictEqual([
      "GPT-6 Sol上下文 400K · 输出 128K · 支持图片",
      "GPT-6 Astra上下文 1M · 输出 128K",
      "Claude Opus 5.5上下文 400K · 输出 64K · 支持图片",
    ]);
    await expect.element(rows.nth(0)).toHaveAttribute("aria-checked", "true");
    await expect.element(rows.nth(1)).toHaveAttribute("aria-checked", "false");
    await expect.element(screen.getByRole("slider", { name: "推理强度" })).toHaveAttribute("aria-valuetext", "中");
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
    expect(screen.getByRole("menuitemradio").elements()).toHaveLength(3);
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
    expect(screen.getByRole("menuitemradio").elements()).toHaveLength(3);
    await expect.element(screen.getByRole("slider")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await userEvent.keyboard("{Meta>}{Shift>}e{/Shift}{/Meta}");
    await expect.element(screen.getByRole("slider")).toHaveFocus();
    expect(screen.getByRole("menuitemradio").elements()).toHaveLength(0);
  });

  it("does not open from the keyboard while disabled", async () => {
    const { screen } = await picker(shown(SOL, "medium"), READY, { disabled: true });

    await userEvent.keyboard("{Meta>}{Shift>}i{/Shift}{/Meta}");

    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  });
});
