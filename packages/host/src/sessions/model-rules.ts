import type { CatalogModel, ModelRef, SetupLogin } from "@atrium/protocol";

/** Why a rule leaves models out (SPEC-0001, "输入框 · 模型选择"). */
type Reason = "paid" | "duplicate";

/**
 * When a rule leaves its models out: always; unless its provider is signed in this way; or
 * while the list has models of another provider, which reaches the same subscription.
 */
type Condition =
  | { readonly kind: "always" }
  | { readonly kind: "unless_signed_in"; readonly method: "oauth" | "api_key" }
  | { readonly kind: "beside"; readonly providerId: string };

/** One rule: the models it covers, when it leaves them out, and why. */
interface ModelRule {
  readonly providerId: string;
  /** Only models whose ids start with this, such as OpenRouter's `anthropic/`. */
  readonly modelPrefix?: string;
  readonly when: Condition;
  readonly reason: Reason;
}

/**
 * The models the host's list leaves out.
 *
 * @remarks
 * SPEC-0001 ("输入框 · 模型选择"): paid OpenAI and OpenRouter routes, and a second way to the same
 * ChatGPT subscription. Native `anthropic` models are allowed again at the user's request;
 * the UI still leaves them without a plan tag. Adding or dropping a rule is a line here.
 */
const MODEL_RULES: readonly ModelRule[] = [
  { providerId: "azure-openai-responses", when: { kind: "always" }, reason: "paid" },
  { providerId: "openai", when: { kind: "unless_signed_in", method: "oauth" }, reason: "paid" },
  // pi 1.1's "Sign in with ChatGPT": the same plan as `openai-codex`, which also shows its usage and has Fast.
  { providerId: "openai", when: { kind: "beside", providerId: "openai-codex" }, reason: "duplicate" },
  { providerId: "openrouter", modelPrefix: "anthropic/", when: { kind: "always" }, reason: "paid" },
  { providerId: "openrouter", modelPrefix: "openai/", when: { kind: "always" }, reason: "paid" },
];

/**
 * Whether a provider is signed in this way.
 *
 * @remarks
 * A login state that could not be read counts as not.
 *
 * @sideEffects none
 * @param login - pi's login state, if read.
 * @param providerId - The provider.
 * @param method - The way.
 * @returns Whether.
 */
function signedInWith(login: SetupLogin | null, providerId: string, method: "oauth" | "api_key"): boolean {
  if (login?.state !== "ready") return false;
  return login.providers.some((provider) => provider.providerId === providerId && provider.signedIn?.method === method);
}

/**
 * Whether a rule's condition holds.
 *
 * @remarks
 * See `MODEL_RULES`.
 *
 * @sideEffects none
 * @param rule - The rule.
 * @param models - Everything pi listed.
 * @param login - pi's login state, if read.
 * @returns Whether it leaves its models out.
 */
function applies(rule: ModelRule, models: readonly CatalogModel[], login: SetupLogin | null): boolean {
  const { when } = rule;
  if (when.kind === "always") return true;
  if (when.kind === "unless_signed_in") return !signedInWith(login, rule.providerId, when.method);
  return models.some((model) => model.providerId === when.providerId);
}

/**
 * The models pi lists that the host shows.
 *
 * @remarks
 * Without those `MODEL_RULES` leave out. The subscriptions (`claude-bridge`, `openai-codex`) stay.
 *
 * @sideEffects none
 * @param models - What pi listed.
 * @param login - pi's login state; `null` when it could not be read.
 * @returns The models kept.
 */
export function visibleModels(models: readonly CatalogModel[], login: SetupLogin | null): CatalogModel[] {
  const hiding = MODEL_RULES.filter((rule) => applies(rule, models, login));
  return models.filter(
    (model) =>
      !hiding.some(
        (rule) =>
          rule.providerId === model.providerId &&
          (rule.modelPrefix === undefined || model.modelId.startsWith(rule.modelPrefix)),
      ),
  );
}

/** pi's models and its default, as the catalog keeps them. */
interface ModelList {
  readonly models: readonly CatalogModel[];
  readonly defaultModel: ModelRef | null;
}

/**
 * A query for pi's models that leaves out what `MODEL_RULES` do.
 *
 * @remarks
 * See `visibleModels`; the login state is read alongside the models, and one that cannot be
 * read leaves out the paid OpenAI models too rather than fail the list. pi's default goes too when
 * it is left out, so nothing starts on it unasked.
 *
 * @sideEffects none; the query returned runs both.
 * @param query - pi's models for a directory.
 * @param login - Reads pi's login state.
 * @returns The query.
 */
export function withModelRules(
  query: (dir: string, signal: AbortSignal) => Promise<ModelList>,
  login: () => Promise<SetupLogin>,
): (dir: string, signal: AbortSignal) => Promise<ModelList> {
  return async (dir, signal) => {
    // Stryker disable next-line ArrowFunction: an unread state as `undefined` reads as `null` does.
    const [list, state] = await Promise.all([query(dir, signal), login().catch(() => null)]);
    const models = visibleModels(list.models, state);
    const chosen = list.defaultModel;
    const kept = models.some((model) => model.providerId === chosen?.providerId && model.modelId === chosen.modelId);
    return { models, defaultModel: kept ? chosen : null };
  };
}
