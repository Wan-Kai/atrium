import type { ModelListView } from "@atrium/client";
import type { CatalogModel, ModelRef, Preferences, SessionModel, ThinkingLevel } from "@atrium/protocol";
import claudeLogo from "../design/brand/claude.svg";
import copilotLogo from "../design/brand/copilot.svg";
import kimiLogo from "../design/brand/kimi.png";
import openaiLogo from "../design/brand/openai.svg";
import openrouterLogo from "../design/brand/openrouter.svg";
import xaiLogo from "../design/brand/xai.png";

/** What the model button and panel show of a model. */
export interface ShownModel extends ModelRef {
  readonly name: string;
  /** The levels it supports, lowest first; empty when unknown. */
  readonly levels: readonly ThinkingLevel[];
  /** The level it thinks at; `null` when unknown. */
  readonly level: ThinkingLevel | null;
  /** Whether it takes images; `null` when the catalog does not list it. */
  readonly supportsImage: boolean | null;
  /** What Fast does for it; `null` without Fast or when the catalog does not list it. */
  readonly fast: CatalogModel["fast"];
}

/** Each level's name; the four common ones read 低 / 中 / 高 / 极高 (SPEC-0001, "输入框"). */
export const LEVEL_NAMES: Readonly<Record<ThinkingLevel, string>> = {
  off: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

/** What each level suits, below the thinking level box. */
const LEVEL_HINTS: Readonly<Record<ThinkingLevel, string>> = {
  off: "不推理，回答最快",
  minimal: "稍作思考，适合很简单的事",
  low: "想得少，适合简单、明确的小改动",
  medium: "默认，兼顾速度和质量",
  high: "想得更久，适合难排查的问题",
  xhigh: "想得很久，适合最难的问题",
  max: "最慢最贵，留给最难的任务",
};

/**
 * What a level suits.
 *
 * @remarks
 * The model's top level is always the slowest, whatever its name; a model that only has `off`
 * does not think at all.
 *
 * @sideEffects none
 * @param level - The level.
 * @param levels - The model's levels.
 * @returns The hint.
 */
export function levelHint(level: ThinkingLevel, levels: readonly ThinkingLevel[]): string {
  if (levels.length === 1 && level === "off") return "这个模型不推理";
  if (levels.at(-1) === level) return LEVEL_HINTS.max;
  return LEVEL_HINTS[level];
}

/**
 * How full the dots are at a level, from 0 to 1.
 *
 * @remarks
 * The model button's dots fill from the left as the level rises (SPEC-0001, "输入框"); `off` and
 * an unknown level leave them empty, the top level fills them.
 *
 * @sideEffects none
 * @param level - The level, or `null`.
 * @param levels - The model's levels.
 * @returns The coverage.
 */
export function coverageOf(level: ThinkingLevel | null, levels: readonly ThinkingLevel[]): number {
  if (level === "off") return 0;
  // Stryker disable next-line ConditionalExpression: a null level is not found among the levels either.
  const index = level === null ? -1 : levels.indexOf(level);
  return index === -1 ? 0 : (index + 1) / levels.length;
}

/**
 * The model to show on the button.
 *
 * @remarks
 * The session's own once its pi reports it; before that, the model a new session will start on:
 * the one chosen last, with its remembered level, or else pi's own default (SPEC-0001,
 * "模型与输入框"). The catalog fills in the name, levels, image support and Fast (SPEC-0001,
 * "Fast"); a model it does not list goes by its id, without Fast.
 *
 * @sideEffects none
 * @param session - The session's model, if known.
 * @param preferences - The model chosen last and the levels remembered.
 * @param list - The container's models.
 * @returns The model, or `null` when there is nothing to show.
 */
export function shownModel(
  session: SessionModel | null,
  preferences: Pick<Preferences, "lastModel" | "thinkingByModel">,
  list: ModelListView,
): ShownModel | null {
  let ref: ModelRef | null = session;
  let level: ThinkingLevel | null = session?.thinkingLevel ?? null;
  if (ref === null && preferences.lastModel !== null) {
    ref = preferences.lastModel;
    level = preferences.thinkingByModel[`${ref.providerId}/${ref.modelId}`] ?? null;
  }
  ref ??= list.defaultModel;
  if (ref === null) return null;
  const { providerId, modelId } = ref;
  const listed = list.models.find((model) => model.providerId === providerId && model.modelId === modelId);
  return {
    providerId,
    modelId,
    name: listed?.name ?? modelId,
    levels: listed?.thinkingLevels ?? (level === null ? [] : [level]),
    level,
    supportsImage: listed?.supportsImage ?? null,
    fast: listed?.fast ?? null,
  };
}

/**
 * Writes a token count the way the model panel does: 128K, 1M, 2.5M.
 *
 * @remarks
 * One decimal at most, dropped when it is 0.
 *
 * @sideEffects none
 * @param tokens - The count.
 * @returns The text.
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trim(tokens / 1_000)}K`;
  return String(tokens);
}

/**
 * A number with at most one decimal, without a trailing `.0`.
 *
 * @remarks
 * For `formatTokens`.
 *
 * @sideEffects none
 * @param value - The number.
 * @returns The text.
 */
function trim(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Providers the panel names and shows the official icon of (brand/SOURCES.md). */
const PROVIDERS: Readonly<Record<string, { readonly name: string; readonly logo: string }>> = {
  anthropic: { name: "Anthropic", logo: claudeLogo },
  openai: { name: "OpenAI", logo: openaiLogo },
  "openai-codex": { name: "ChatGPT 订阅", logo: openaiLogo },
  "azure-openai-responses": { name: "Azure OpenAI", logo: openaiLogo },
  "github-copilot": { name: "GitHub Copilot", logo: copilotLogo },
  openrouter: { name: "OpenRouter", logo: openrouterLogo },
  xai: { name: "xAI", logo: xaiLogo },
  moonshotai: { name: "Kimi", logo: kimiLogo },
  "moonshotai-cn": { name: "Kimi", logo: kimiLogo },
  "kimi-coding": { name: "Kimi Coding", logo: kimiLogo },
};

/**
 * A provider's name and icon.
 *
 * @remarks
 * pi names providers only by id; the ones Atrium knows get their own name and official icon,
 * others show their id and the first letter in place of an icon.
 *
 * @sideEffects none
 * @param providerId - pi's id for the provider.
 * @returns Its name and icon URL, or `null` for none.
 */
export function providerOf(providerId: string): { readonly name: string; readonly logo: string | null } {
  return PROVIDERS[providerId] ?? { name: providerId, logo: null };
}

/**
 * The models grouped by provider, in the order pi lists them.
 *
 * @remarks
 * The panel shows one group per logged-in provider (SPEC-0001, "输入框").
 *
 * @sideEffects none
 * @param models - The catalog's models.
 * @returns The groups.
 */
export function groupByProvider(
  models: readonly CatalogModel[],
): { readonly providerId: string; readonly models: CatalogModel[] }[] {
  const groups = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const group = groups.get(model.providerId);
    if (group === undefined) groups.set(model.providerId, [model]);
    else group.push(model);
  }
  return [...groups].map(([providerId, grouped]) => ({ providerId, models: grouped }));
}
