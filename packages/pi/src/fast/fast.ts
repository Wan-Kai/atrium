import type { CatalogModel } from "@atrium/protocol";

/** The command the host switches Fast with in a session's pi: `/atrium-fast on` or `/atrium-fast off` (ADR-0008). */
export const FAST_COMMAND = "atrium-fast";

/** What Fast asks of OpenAI: its priority service tier (SPEC-0001, "Fast"). */
export const FAST_SERVICE_TIER = "priority";

/** The key of the status the extension reports Codex's model list under (ADR-0008, point 6). */
export const FAST_STATUS = "atrium-fast";

/** The provider of ChatGPT's subscription, the only one Atrium offers Fast with (SPEC-0001, "Fast"). */
export const CODEX = "openai-codex";

/** What Fast does for a model: about how many times as fast, and whether it uses more credits. */
export type FastInfo = NonNullable<CatalogModel["fast"]>;

/** Codex's model list, as far as Fast goes: each model it names, with its Fast or `null` for none. */
export type FastTiers = ReadonlyMap<string, FastInfo | null>;

/** What the extension reports to the host: Codex's model list, or why it has none. */
export type FastReport =
  | { readonly models: readonly { readonly id: string; readonly fast: FastInfo | null }[] }
  | { readonly failure: string };

/** The built-in rule, for when Codex's model list cannot be had: GPT-5.5, 5.6, 6 and 6.1, variants included. */
const FALLBACK_MODEL = /^gpt-(?:5\.[56]|6|6\.1)(?:$|-)/u;

/** What the built-in rule gives a model it matches: faster by an unknown amount, at more credits. */
const FALLBACK: FastInfo = { speed: null, moreUsage: true };

/** Most models a report may carry; Codex lists about ten. */
const MAX_MODELS = 500;

/** Longest model id a report may carry, as the protocol allows (`MODEL_LIMITS.modelId`). */
const MAX_ID = 200;

/** Longest failure code a report may carry. */
const MAX_FAILURE = 40;

/** Highest speed a report may carry, as the protocol allows. */
const MAX_SPEED = 100;

/**
 * What Fast does for a model, or `null` when it has none.
 *
 * @remarks
 * Only ChatGPT's subscription (`openai-codex`); the API key `openai` provider is left out for now
 * (SPEC-0001, "Fast"). Codex's model list decides for the models it names, with or without Fast;
 * a model it does not name, or every model when the list could not be had, goes by the built-in
 * rule, as measured on 2026-10-12 (ADR-0008, point 6). The host and the extension share this rule,
 * so the toggle shows exactly where the extension acts.
 *
 * @sideEffects none
 * @param model - The model, by its provider and id as pi names them.
 * @param tiers - Codex's model list, or `null` when it could not be had.
 * @returns What Fast does for it, or `null`.
 */
export function fastOf(
  model: { readonly provider: string; readonly id: string },
  tiers: FastTiers | null,
): FastInfo | null {
  if (model.provider !== CODEX) return null;
  const listed = tiers?.get(model.id);
  if (listed !== undefined) return listed;
  return FALLBACK_MODEL.test(model.id) ? FALLBACK : null;
}

/**
 * Reads what Fast does from a priority tier's description, such as "2x speed, increased usage".
 *
 * @remarks
 * Codex says it in English for its own UI (pi-internals.md §5); Atrium takes the multiplier and
 * whether usage goes up, and words them itself (SPEC-0001, "输入框"). A description it cannot read
 * still means the model has Fast, at an unknown speed.
 *
 * @sideEffects none
 * @param description - The tier's description, whatever its type.
 * @returns What Fast does.
 */
function infoOf(description: unknown): FastInfo {
  if (typeof description !== "string") return { speed: null, moreUsage: false };
  const speed = Number(/(\d+(?:\.\d+)?)\s*x\s+speed/iu.exec(description)?.[1]);
  return {
    speed: speed > 0 && speed <= MAX_SPEED ? speed : null,
    moreUsage: /increased usage/iu.test(description),
  };
}

/**
 * Reads Codex's model list into each model's Fast.
 *
 * @remarks
 * The list is `{models: [{slug, service_tiers: [{id, description}]}]}` (pi-internals.md §5); a
 * model has Fast when one of its tiers is `priority`. Models without a usable `slug` are skipped;
 * a body without a `models` list is not Codex's list at all.
 *
 * @sideEffects none
 * @param body - The parsed response body.
 * @returns The models it names, by id, or `null` when it is not the list.
 */
export function tiersFromModelList(body: unknown): Map<string, FastInfo | null> | null {
  if (typeof body !== "object" || body === null || !("models" in body) || !Array.isArray(body.models)) return null;
  const tiers = new Map<string, FastInfo | null>();
  for (const model of body.models as unknown[]) {
    if (typeof model !== "object" || model === null || !("slug" in model)) continue;
    const { slug } = model;
    if (typeof slug !== "string" || slug === "" || slug.length > MAX_ID) continue;
    const listed =
      // Stryker disable next-line ArrayDeclaration: anything in an empty list is no tier object, so none is priority.
      "service_tiers" in model && Array.isArray(model.service_tiers) ? (model.service_tiers as unknown[]) : [];
    const priority = listed.find(
      (tier): tier is { readonly description?: unknown } =>
        typeof tier === "object" && tier !== null && "id" in tier && tier.id === FAST_SERVICE_TIER,
    );
    tiers.set(slug, priority === undefined ? null : infoOf(priority.description));
  }
  return tiers;
}

/**
 * Checks one model of a report.
 *
 * @remarks
 * Its `fast` must be exactly what the protocol takes, so a malformed report cannot reach a client.
 *
 * @sideEffects none
 * @param entry - The entry as parsed.
 * @returns The entry, or `null` when malformed.
 */
function reportedModel(entry: unknown): { readonly id: string; readonly fast: FastInfo | null } | null {
  if (typeof entry !== "object" || entry === null || !("id" in entry) || !("fast" in entry)) return null;
  const { id, fast } = entry;
  if (typeof id !== "string" || id === "" || id.length > MAX_ID) return null;
  if (fast === null) return { id, fast };
  if (typeof fast !== "object" || Object.keys(fast).length !== 2 || !("speed" in fast) || !("moreUsage" in fast)) {
    return null;
  }
  const { speed, moreUsage } = fast;
  if (typeof moreUsage !== "boolean") return null;
  if (speed !== null && (typeof speed !== "number" || !(speed > 0 && speed <= MAX_SPEED))) return null;
  return { id, fast: { speed, moreUsage } };
}

/**
 * Reads the extension's report from its status text.
 *
 * @remarks
 * The text comes from the pi process, so it is checked as untrusted (security.md): a report that
 * does not fit counts as none.
 *
 * @sideEffects none
 * @param text - The status text, or `undefined` when cleared.
 * @returns The report, or `null` when it is not one.
 */
export function readFastReport(text: string | undefined): FastReport | null {
  let parsed: unknown;
  try {
    // Stryker disable next-line StringLiteral: no text and text that is not JSON both throw into the catch.
    parsed = JSON.parse(text ?? "");
  } /* Stryker disable next-line BlockStatement: an empty catch leaves nothing parsed, which is no object either. */ catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if ("failure" in parsed) {
    const { failure } = parsed;
    return typeof failure === "string" && /^[a-z0-9_]+$/u.test(failure) && failure.length <= MAX_FAILURE
      ? { failure }
      : null;
  }
  if (!("models" in parsed) || !Array.isArray(parsed.models) || parsed.models.length > MAX_MODELS) return null;
  const models = (parsed.models as unknown[]).flatMap((entry) => reportedModel(entry) ?? []);
  return models.length === parsed.models.length ? { models } : null;
}
