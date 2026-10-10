import { type CatalogModel, MODEL_LIMITS, type SessionModel, type ThinkingLevel } from "@atrium/protocol";
import type { PiResponseData } from "../process/pi-process";

/** A model as pi's `get_available_models` lists it. */
export type PiModel = PiResponseData<"get_available_models">["models"][number];

/** pi's state, as far as the model goes. */
type PiModelState = Pick<PiResponseData<"get_state">, "model" | "thinkingLevel">;

/** Every level pi knows, lowest first (pi-ai's `EXTENDED_THINKING_LEVELS`). */
const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The thinking levels a model supports, lowest first.
 *
 * @remarks
 * Copied from pi-ai's `getSupportedThinkingLevels` (pi-internals.md §4), since only types of pi's
 * packages may be used at run time: a model that does not think has only `off`; a thinking one
 * has every level its `thinkingLevelMap` does not set to `null`, with `xhigh` and `max` only when
 * the map names them. pi's `get_available_thinking_levels` answers for the current model only, so
 * the catalog works them out from each model's own fields (SPEC-0001, "模型与输入框"). The pi
 * contract test catches pi changing the rule.
 *
 * @sideEffects none
 * @param model - The model.
 * @returns Its levels.
 */
export function thinkingLevelsOf(model: Pick<PiModel, "reasoning" | "thinkingLevelMap">): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * What the model panel shows of a model.
 *
 * @remarks
 * Only the basics: name, context, longest output, whether it takes images (SPEC-0001, "输入框").
 * A model without a name goes by its id. A name too long for the protocol is cut, so one model
 * cannot fail the whole list; a model whose id or provider is too long is left out, as it could
 * not be chosen by a cut one.
 *
 * @sideEffects none
 * @param model - The model as pi lists it.
 * @returns The catalog's model, or `null` for one left out.
 */
export function toCatalogModel(model: PiModel): CatalogModel | null {
  if (model.provider.length > MODEL_LIMITS.providerId || model.id.length > MODEL_LIMITS.modelId) return null;
  return {
    providerId: model.provider,
    modelId: model.id,
    name: (model.name === "" ? model.id : model.name).slice(0, MODEL_LIMITS.name),
    contextWindow: model.contextWindow,
    maxOutput: model.maxTokens,
    supportsImage: model.input.includes("image"),
    thinkingLevels: thinkingLevelsOf(model),
  };
}

/** The id and provider of the model pi-agent-core uses when it has none (pi-internals.md §3, "启动"). */
const PLACEHOLDER = "unknown";

/**
 * The model a session's pi uses, from its state.
 *
 * @remarks
 * pi may have no model; without any credentials it reports a placeholder named `unknown` by
 * `unknown`, which counts as none (SPEC-0001, "模型与输入框").
 *
 * @sideEffects none
 * @param state - pi's `get_state`.
 * @returns The session's model, or `null`.
 */
export function sessionModelOf(state: PiModelState): SessionModel | null {
  if (state.model === undefined) return null;
  if (state.model.provider === PLACEHOLDER && state.model.id === PLACEHOLDER) return null;
  return { providerId: state.model.provider, modelId: state.model.id, thinkingLevel: state.thinkingLevel };
}
