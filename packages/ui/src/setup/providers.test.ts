import type { SetupProvider } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { isLastCredential, keyCandidates, keyedProviders, subscriptionRows } from "./providers";

/**
 * A provider of pi's.
 *
 * @remarks
 * Signs in with a key only, and is signed out, unless `fields` say otherwise.
 *
 * @sideEffects none
 * @param providerId - Its id.
 * @param fields - Fields to set.
 * @returns The provider.
 */
function provider(providerId: string, fields: Partial<SetupProvider> = {}): SetupProvider {
  return { providerId, name: providerId.toUpperCase(), oauth: null, apiKey: true, signedIn: null, ...fields };
}

const OAUTH = { label: "Sign in", subscription: true };

describe("subscriptionRows", () => {
  it("lists the named subscriptions pi offers in the SPEC's order, then those pi added under pi's label", () => {
    const rows = subscriptionRows([
      provider("acme", { oauth: { label: "Acme Pro", subscription: true } }),
      provider("meta", { oauth: OAUTH }),
      provider("xai", { oauth: OAUTH }),
      provider("deepseek"),
      provider("anthropic", { oauth: OAUTH }),
      provider("openai", { oauth: OAUTH }),
      provider("kimi-coding", { oauth: OAUTH }),
      provider("github-copilot", { oauth: OAUTH }),
      provider("openrouter", { oauth: OAUTH }),
    ]);

    expect(
      rows.map(({ provider: { providerId }, title, plan, logo, fills }) => [
        providerId,
        title,
        plan,
        logo !== null,
        fills,
      ]),
    ).toStrictEqual([
      ["openai", "ChatGPT", "Plus / Pro 订阅，可用 Codex 模型", true, true],
      ["anthropic", "Claude", "Pro / Max 订阅", true, false],
      ["github-copilot", "GitHub Copilot", "Copilot 订阅", true, false],
      ["kimi-coding", "Kimi Code", "Kimi 会员", true, true],
      ["xai", "Grok", "SuperGrok / X Premium 订阅", true, true],
      ["openrouter", "OpenRouter", "用 OpenRouter 账号的额度", true, false],
      ["meta", "Meta", "Muse 订阅", false, false],
      ["acme", "Acme Pro", null, false, false],
    ]);
  });

  it("leaves out a named subscription pi does not offer", () => {
    expect(
      subscriptionRows([provider("anthropic"), provider("xai", { oauth: OAUTH })]).map((row) => row.title),
    ).toStrictEqual(["Grok"]);
  });
});

describe("credentials", () => {
  const providers = [
    provider("openai", { oauth: OAUTH, signedIn: { method: "oauth", stored: true } }),
    provider("zeta", { signedIn: { method: "api_key", stored: true } }),
    provider("groq", { signedIn: { method: "api_key", stored: false } }),
    provider("mistral"),
    provider("radius", { apiKey: false }),
    provider("bedrock"),
  ];

  it("lists the providers with a key, stored or from the environment, by name", () => {
    expect(keyedProviders(providers).map((one) => one.providerId)).toStrictEqual(["groq", "zeta"]);
  });

  it("offers a key for the providers pi can store one for that have no credential, by name", () => {
    expect(keyCandidates(providers).map((one) => one.providerId)).toStrictEqual(["bedrock", "mistral"]);
  });

  it("tells the last credential, counting keys from the environment", () => {
    const last = [provider("openai", { signedIn: { method: "oauth", stored: true } }), provider("mistral")];

    expect([
      isLastCredential(last, "openai"),
      isLastCredential(last, "mistral"),
      isLastCredential(providers, "openai"),
      isLastCredential([], "openai"),
    ]).toStrictEqual([true, false, false, false]);
  });
});
