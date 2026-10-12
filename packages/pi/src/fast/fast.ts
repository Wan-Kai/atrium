/** The command the host switches Fast with in a session's pi: `/atrium-fast on` or `/atrium-fast off` (ADR-0008). */
export const FAST_COMMAND = "atrium-fast";

/** What Fast asks of OpenAI: its priority service tier (SPEC-0001, "Fast"). */
export const FAST_SERVICE_TIER = "priority";

/** The provider of ChatGPT's subscription, the only one Atrium offers Fast with (SPEC-0001, "Fast"). */
const CODEX = "openai-codex";

/** The models with Fast, with their minor version captured, as `pi-codex-fast-mode` matches them. */
const FAST_MODEL = /^gpt-5\.([456])(?:$|-)/u;

/**
 * About how many times the credits a model uses with Fast, or `null` when it has no Fast.
 *
 * @remarks
 * Only ChatGPT's subscription (`openai-codex`) and its GPT-5.4, 5.5 and 5.6 models, variants
 * included; the API key `openai` provider is left out for now (SPEC-0001, "Fast", 2026-10-12). The
 * host and the extension share this rule, so the toggle shows exactly where the extension acts.
 *
 * @sideEffects none
 * @param model - The model, by its provider and id as pi names them.
 * @returns The credits multiplier, or `null`.
 */
export function fastCreditsOf(model: { readonly provider: string; readonly id: string }): number | null {
  if (model.provider !== CODEX) return null;
  const minor = FAST_MODEL.exec(model.id)?.[1];
  if (minor === undefined) return null;
  // OpenAI's figures: GPT-5.4 about twice, 5.5 and 5.6 about two and a half times.
  return minor === "4" ? 2 : 2.5;
}
