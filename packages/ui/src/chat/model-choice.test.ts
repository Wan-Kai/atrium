import type { ModelListView } from "@atrium/client";
import type { CatalogModel, SetupLogin, SetupProvider } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import catpawLogo from "../design/brand/catpaw.webp";
import claudeLogo from "../design/brand/claude.svg";
import copilotLogo from "../design/brand/copilot.svg";
import deepseekLogo from "../design/brand/deepseek.svg";
import kimiLogo from "../design/brand/kimi.png";
import openaiLogo from "../design/brand/openai.svg";
import openrouterLogo from "../design/brand/openrouter.svg";
import xaiLogo from "../design/brand/xai.png";
import {
  LEVEL_NAMES,
  coverageOf,
  formatTokens,
  groupByProvider,
  levelHint,
  onPlan,
  providerOf,
  shownModel,
} from "./model-choice";

/** A model as the catalog lists it. */
function model(providerId: string, modelId: string, fields: Partial<CatalogModel> = {}): CatalogModel {
  return {
    providerId,
    modelId,
    name: modelId.toUpperCase(),
    contextWindow: 400_000,
    maxOutput: 128_000,
    supportsImage: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    fast: null,
    ...fields,
  };
}

/** A ready list of these models, with pi's own default. */
function listed(models: CatalogModel[], defaultModel: ModelListView["defaultModel"] = null): ModelListView {
  return { status: "ready", models, defaultModel, error: null };
}

const NONE = { lastModel: null, thinkingByModel: {} };
const UNASKED: ModelListView = { status: "idle", models: [], defaultModel: null, error: null };

describe("shownModel", () => {
  it("shows the session's model, with what the catalog knows of it", () => {
    const gpt = model("openai", "gpt-6", {
      thinkingLevels: ["low", "medium", "high", "xhigh"],
      fast: { speed: 2, moreUsage: true },
    });

    expect(
      shownModel({ providerId: "openai", modelId: "gpt-6", thinkingLevel: "high" }, NONE, listed([gpt])),
    ).toStrictEqual({
      providerId: "openai",
      modelId: "gpt-6",
      name: "GPT-6",
      levels: ["low", "medium", "high", "xhigh"],
      level: "high",
      supportsImage: true,
      fast: { speed: 2, moreUsage: true },
    });
  });

  it("shows the session's model over the one chosen last", () => {
    const preferences = { lastModel: { providerId: "openai", modelId: "gpt-6" }, thinkingByModel: {} };

    expect(shownModel({ providerId: "x", modelId: "m", thinkingLevel: "low" }, preferences, UNASKED)).toMatchObject({
      providerId: "x",
      modelId: "m",
    });
  });

  it("finds the model in the catalog by both its provider and its id", () => {
    const list = listed([
      model("openai", "gpt-6", { name: "Wrong provider" }),
      model("azure", "other", { name: "Wrong model" }),
    ]);

    expect(shownModel({ providerId: "azure", modelId: "gpt-6", thinkingLevel: "low" }, NONE, list)).toMatchObject({
      name: "gpt-6",
      supportsImage: null,
    });
  });

  it("names a model the catalog does not list by its id, with only its own level", () => {
    expect(shownModel({ providerId: "x", modelId: "gone", thinkingLevel: "low" }, NONE, UNASKED)).toStrictEqual({
      providerId: "x",
      modelId: "gone",
      name: "gone",
      levels: ["low"],
      level: "low",
      supportsImage: null,
      fast: null,
    });
  });

  it("shows the model chosen last for a session whose pi has not started, with its remembered level", () => {
    const preferences = {
      lastModel: { providerId: "openai", modelId: "gpt-6" },
      thinkingByModel: { "openai/gpt-6": "medium" as const },
    };

    expect(shownModel(null, preferences, listed([model("openai", "gpt-6")]))).toMatchObject({
      modelId: "gpt-6",
      level: "medium",
    });
    expect(shownModel(null, { ...preferences, thinkingByModel: {} }, UNASKED)).toMatchObject({
      modelId: "gpt-6",
      levels: [],
      level: null,
    });
  });

  it("falls back to pi's own default, then to nothing", () => {
    const list = listed([model("anthropic", "opus")], { providerId: "anthropic", modelId: "opus" });

    expect(shownModel(null, NONE, list)).toMatchObject({ providerId: "anthropic", modelId: "opus", level: null });
    expect(shownModel(null, NONE, UNASKED)).toBeNull();
  });
});

describe("coverageOf", () => {
  it("fills the dots by level, off empty and the top level full", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

    expect(levels.map((level) => coverageOf(level, levels))).toStrictEqual([0, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1]);
    expect(coverageOf("medium", ["low", "medium", "high", "xhigh"])).toBe(0.5);
    expect(coverageOf("off", ["off"])).toBe(0);
    expect(coverageOf(null, ["low"])).toBe(0);
    expect(coverageOf("high", [])).toBe(0);
  });
});

describe("level names and hints", () => {
  it("names every level, the four common ones 低 / 中 / 高 / 极高", () => {
    expect(LEVEL_NAMES).toStrictEqual({
      off: "关闭",
      minimal: "最低",
      low: "低",
      medium: "中",
      high: "高",
      xhigh: "极高",
      max: "最高",
    });
  });

  it("says what each level suits, the top one always the slowest", () => {
    expect(levelHint("medium", ["low", "medium", "high"])).toBe("默认，兼顾速度和质量");
    expect(levelHint("high", ["low", "medium", "high"])).toBe("最慢最贵，留给最难的任务");
    expect(levelHint("high", ["low", "medium", "high", "xhigh"])).toBe("想得更久，适合难排查的问题");
    expect(levelHint("off", ["off"])).toBe("这个模型不推理");
    expect(levelHint("off", ["off", "low"])).toBe("不推理，回答最快");
    expect(levelHint("high", ["high"])).toBe("最慢最贵，留给最难的任务");
    const all = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    expect(all.map((level) => levelHint(level, all))).toStrictEqual([
      "不推理，回答最快",
      "稍作思考，适合很简单的事",
      "想得少，适合简单、明确的小改动",
      "默认，兼顾速度和质量",
      "想得更久，适合难排查的问题",
      "想得很久，适合最难的问题",
      "最慢最贵，留给最难的任务",
    ]);
  });
});

describe("formatTokens", () => {
  it("writes token counts as the model panel does", () => {
    expect([999, 1_000, 128_000, 400_000, 1_000_000, 1_048_576, 2_500_000].map(formatTokens)).toStrictEqual([
      "999",
      "1K",
      "128K",
      "400K",
      "1M",
      "1M",
      "2.5M",
    ]);
  });
});

describe("providers", () => {
  it("names the providers it knows, with their icon, and others by their id", () => {
    expect(
      [
        "anthropic",
        "openai",
        "openai-codex",
        "azure-openai-responses",
        "github-copilot",
        "openrouter",
        "xai",
        "moonshotai",
        "moonshotai-cn",
        "kimi-coding",
        "claude-bridge",
        "deepseek",
      ].map(providerOf),
    ).toStrictEqual([
      { name: "Anthropic", logo: claudeLogo },
      { name: "OpenAI", logo: openaiLogo },
      { name: "ChatGPT 订阅", logo: openaiLogo },
      { name: "Azure OpenAI", logo: openaiLogo },
      { name: "GitHub Copilot", logo: copilotLogo },
      { name: "OpenRouter", logo: openrouterLogo },
      { name: "xAI", logo: xaiLogo },
      { name: "Kimi", logo: kimiLogo },
      { name: "Kimi", logo: kimiLogo },
      { name: "Kimi Coding", logo: kimiLogo },
      { name: "Claude 订阅", logo: claudeLogo },
      { name: "DeepSeek", logo: deepseekLogo },
    ]);
    expect(providerOf("acme")).toStrictEqual({ name: "acme", logo: null });
  });

  it("uses the supplied image only for catpaw-cli without changing internal provider names", () => {
    expect([providerOf("catpaw-cli"), providerOf("sankuai-openai")]).toStrictEqual([
      { name: "catpaw-cli", logo: catpawLogo },
      { name: "sankuai-openai", logo: null },
    ]);
  });

  it("groups models by provider in the order pi lists them", () => {
    const models = [model("openai", "a"), model("anthropic", "b"), model("openai", "c")];

    expect(groupByProvider(models)).toStrictEqual([
      { providerId: "openai", models: [models[0], models[2]] },
      { providerId: "anthropic", models: [models[1]] },
    ]);
  });
});

/**
 * A provider as the setup's login state lists it.
 *
 * @remarks
 * Only the id and how it is signed in matter to `onPlan`.
 *
 * @sideEffects none
 * @param providerId - pi's id for it.
 * @param method - How it is signed in, or `null` for not at all.
 * @returns The provider.
 */
function provider(providerId: string, method: "oauth" | "api_key" | null): SetupProvider {
  return {
    providerId,
    name: providerId,
    oauth: null,
    apiKey: true,
    signedIn: method === null ? null : { method, stored: true },
  };
}

/**
 * A login state that lists these providers.
 *
 * @remarks
 * For `onPlan`.
 *
 * @sideEffects none
 * @param providers - The providers.
 * @returns The login state.
 */
function ready(...providers: SetupProvider[]): SetupLogin {
  return { state: "ready", providers };
}

describe("onPlan", () => {
  const ALWAYS = ["claude-bridge", "openai-codex", "github-copilot"];

  it("counts claude-bridge, openai-codex and github-copilot as on a plan whatever the login state", () => {
    const logins: (SetupLogin | null)[] = [
      null,
      { state: "unavailable" },
      ready(),
      ready(...ALWAYS.map((id) => provider(id, "api_key"))),
    ];

    expect(logins.map((login) => ALWAYS.map((id) => onPlan(id, login)))).toStrictEqual([
      [true, true, true],
      [true, true, true],
      [true, true, true],
      [true, true, true],
    ]);
  });

  it("counts openai and xai only while signed in to that provider through OAuth", () => {
    const logins: (SetupLogin | null)[] = [
      ready(provider("openai", "oauth"), provider("xai", "oauth")),
      ready(provider("openai", "oauth"), provider("xai", "api_key")),
      ready(provider("openai", null), provider("xai", "oauth")),
      ready(provider("openai", "api_key"), provider("xai", null)),
      ready(provider("anthropic", "oauth"), provider("openai-codex", "oauth")),
      ready(),
      { state: "unavailable" },
      null,
    ];

    expect(logins.map((login) => [onPlan("openai", login), onPlan("xai", login)])).toStrictEqual([
      [true, true],
      [true, false],
      [false, true],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
    ]);
  });

  it("never counts anthropic, deepseek or any other provider, even signed in through OAuth", () => {
    const others = ["anthropic", "deepseek", "openrouter", "azure-openai-responses", "kimi-coding", "acme"];
    const login = ready(...others.map((id) => provider(id, "oauth")));

    expect([...others.map((id) => onPlan(id, login)), ...others.map((id) => onPlan(id, null))]).toStrictEqual(
      Array.from({ length: others.length * 2 }, () => false),
    );
  });
});
