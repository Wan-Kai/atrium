import type { SetupProvider } from "@atrium/protocol";
import claudeLogo from "../design/brand/claude.svg";
import copilotLogo from "../design/brand/copilot.svg";
import kimiLogo from "../design/brand/kimi.png";
import openaiLogo from "../design/brand/openai.svg";
import openrouterLogo from "../design/brand/openrouter.svg";
import xaiLogo from "../design/brand/xai.png";

/** A provider as a row of the subscription list. */
export interface SubscriptionRow {
  readonly provider: SetupProvider;
  readonly title: string;
  /** What subscription it takes; `null` for a provider Atrium does not know. */
  readonly plan: string | null;
  /** Its official icon; `null` for the generic one. */
  readonly logo: string | null;
  /** Whether the icon fills its tile. */
  readonly fills: boolean;
}

/** The subscriptions SPEC-0001 names, in its order ("首次启动 · 第 2 步"). */
const KNOWN: readonly {
  readonly id: string;
  readonly title: string;
  readonly plan: string;
  readonly logo: string | null;
  readonly fills: boolean;
}[] = [
  { id: "openai", title: "ChatGPT", plan: "Plus / Pro 订阅，可用 Codex 模型", logo: openaiLogo, fills: true },
  { id: "anthropic", title: "Claude", plan: "Pro / Max 订阅", logo: claudeLogo, fills: false },
  { id: "github-copilot", title: "GitHub Copilot", plan: "Copilot 订阅", logo: copilotLogo, fills: false },
  { id: "kimi-coding", title: "Kimi Code", plan: "Kimi 会员", logo: kimiLogo, fills: true },
  { id: "xai", title: "Grok", plan: "SuperGrok / X Premium 订阅", logo: xaiLogo, fills: true },
  { id: "openrouter", title: "OpenRouter", plan: "用 OpenRouter 账号的额度", logo: openrouterLogo, fills: false },
  // No official icon yet; the row shows the generic one.
  { id: "meta", title: "Meta", plan: "Muse 订阅", logo: null, fills: false },
];

/**
 * The providers to sign in to with a subscription, in the order SPEC-0001 gives.
 *
 * @remarks
 * Only what pi offers: a named provider pi lacks is left out, and one pi added later that signs
 * in with OAuth comes after the named ones, under the label pi gives (SPEC-0001, "首次启动 · 第 2
 * 步"). The host already leaves out the providers not to show.
 *
 * @sideEffects none
 * @param providers - pi's providers, as `check_setup` lists them.
 * @returns The rows.
 */
export function subscriptionRows(providers: readonly SetupProvider[]): SubscriptionRow[] {
  const oauth = providers.filter((provider) => provider.oauth !== null);
  const known = KNOWN.flatMap(({ id, ...row }) => {
    const provider = oauth.find((candidate) => candidate.providerId === id);
    return provider === undefined ? [] : [{ provider, ...row }];
  });
  const added = oauth
    .filter((provider) => !KNOWN.some(({ id }) => id === provider.providerId))
    .map((provider) => ({
      provider,
      title: provider.oauth?.label ?? provider.name,
      plan: null,
      logo: null,
      fills: false,
    }));
  return [...known, ...added];
}

/**
 * The providers with an API key, stored or from the environment.
 *
 * @remarks
 * The settings list these without the key itself (SPEC-0001, "设置 · 模型与账户").
 *
 * @sideEffects none
 * @param providers - pi's providers.
 * @returns Those signed in with a key, by name.
 */
export function keyedProviders(providers: readonly SetupProvider[]): SetupProvider[] {
  return providers
    .filter((provider) => provider.signedIn?.method === "api_key")
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * The providers a key can be added for: pi can store one, and there is no credential yet.
 *
 * @remarks
 * For the "添加 API Key" choice (SPEC-0001, "设置 · 模型与账户").
 *
 * @sideEffects none
 * @param providers - pi's providers.
 * @returns Them, by name.
 */
export function keyCandidates(providers: readonly SetupProvider[]): SetupProvider[] {
  return providers
    .filter((provider) => provider.apiKey && provider.signedIn === null)
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether removing a provider's credential leaves none to use.
 *
 * @remarks
 * Only then do logging out and deleting a key ask first (SPEC-0001, "设置 · 模型与账户"). Keys from
 * the environment count, as pi uses them.
 *
 * @sideEffects none
 * @param providers - pi's providers.
 * @param providerId - The provider whose credential goes.
 * @returns Whether it is the last.
 */
export function isLastCredential(providers: readonly SetupProvider[], providerId: string): boolean {
  const signedIn = providers.filter((provider) => provider.signedIn !== null);
  return signedIn.length === 1 && signedIn[0]?.providerId === providerId;
}
