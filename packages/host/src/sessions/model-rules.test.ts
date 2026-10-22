import type { CatalogModel, SetupLogin, SetupProvider } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { visibleModels, withModelRules } from "./model-rules";

/**
 * A model of a provider, with the rest of its fields made up.
 *
 * @sideEffects none
 * @param providerId - Its provider.
 * @param modelId - Its id.
 * @returns The model.
 */
function model(providerId: string, modelId: string): CatalogModel {
  return {
    providerId,
    modelId,
    name: modelId,
    contextWindow: 200_000,
    maxOutput: 64_000,
    supportsImage: true,
    thinkingLevels: ["off", "high"],
    fast: null,
  };
}

/**
 * pi's login state with `openai` signed in as said.
 *
 * @sideEffects none
 * @param method - How `openai` is signed in; `null` for not at all.
 * @returns The state.
 */
function openaiSignedIn(method: "oauth" | "api_key" | null): SetupLogin {
  const openai: SetupProvider = {
    providerId: "openai",
    name: "OpenAI",
    oauth: { label: "ChatGPT", subscription: true },
    apiKey: true,
    signedIn: method === null ? null : { method, stored: true },
  };
  const xai: SetupProvider = { ...openai, providerId: "xai", name: "xAI", signedIn: { method: "oauth", stored: true } };
  return { state: "ready", providers: [xai, openai] };
}

/**
 * Each model's `provider/modelId`.
 *
 * @sideEffects none
 * @param models - The models.
 * @returns Their ids.
 */
function ids(models: readonly CatalogModel[]): string[] {
  return models.map((one) => `${one.providerId}/${one.modelId}`);
}

const LISTED = [
  model("claude-bridge", "claude-opus-5-5"),
  model("anthropic", "claude-opus-5-5"),
  model("openai-codex", "gpt-6-astra"),
  model("openai", "gpt-6-astra"),
  model("azure-openai-responses", "gpt-6"),
  model("openrouter", "anthropic/claude-opus-5.5"),
  model("openrouter", "openai/gpt-6"),
  model("openrouter", "moonshotai/kimi-k3"),
  model("openrouter", "deepseek/openai/compat"),
  model("deepseek", "deepseek-v4"),
  model("github-copilot", "claude-opus-5.5"),
  model("xai", "grok-4.7"),
  model("groq", "openai/gpt-oss-120b"),
];

/** What stays whatever the login, excluding non-plan Claude routes. */
const KEPT = [
  "claude-bridge/claude-opus-5-5",
  "openai-codex/gpt-6-astra",
  "openrouter/moonshotai/kimi-k3",
  "openrouter/deepseek/openai/compat",
  "deepseek/deepseek-v4",
  "github-copilot/claude-opus-5.5",
  "xai/grok-4.7",
  "groq/openai/gpt-oss-120b",
];

describe("visibleModels", () => {
  it("drops non-plan Claude, other paid routes and duplicate OpenAI models however signed in", () => {
    expect([
      ids(visibleModels(LISTED, openaiSignedIn("oauth"))),
      ids(visibleModels(LISTED, openaiSignedIn("api_key"))),
      ids(visibleModels(LISTED, openaiSignedIn(null))),
      ids(visibleModels(LISTED, { state: "unavailable" })),
      ids(visibleModels(LISTED, null)),
    ]).toStrictEqual([KEPT, KEPT, KEPT, KEPT, KEPT]);
  });
});

/**
 * pi's login state with nothing signed in to `openai`.
 *
 * @sideEffects none
 * @returns The state.
 */
function signedOut(): Promise<SetupLogin> {
  return Promise.resolve(openaiSignedIn(null));
}

describe("visibleModels, without openai-codex", () => {
  it("keeps openai's models signed in with ChatGPT when openai-codex lists none, but not with a key, an unread login or none at all", () => {
    const listed = LISTED.filter((one) => one.providerId !== "openai-codex");
    const kept = KEPT.filter((id) => !id.startsWith("openai-codex/"));

    expect([
      ids(visibleModels(listed, openaiSignedIn("oauth"))),
      ids(visibleModels(listed, openaiSignedIn("api_key"))),
      ids(visibleModels(listed, null)),
      ids(visibleModels(listed, { state: "unavailable" })),
    ]).toStrictEqual([[...kept.slice(0, 1), "openai/gpt-6-astra", ...kept.slice(1)], kept, kept, kept]);
  });
});

describe("withModelRules", () => {
  it("lists what pi listed without the paid models, by the login state read alongside, or none when it cannot be read", async () => {
    const asked: string[] = [];
    const signal = new AbortController().signal;
    /**
     * pi's models for a directory, its default the bridge's, noting which directory.
     *
     * @sideEffects Notes the directory.
     * @param dir - The directory.
     * @returns The models.
     */
    const query = (dir: string) => {
      asked.push(dir);
      return Promise.resolve({
        models: LISTED,
        defaultModel: { providerId: "claude-bridge", modelId: "claude-opus-5-5" },
      });
    };
    const read = await withModelRules(query, () => Promise.resolve(openaiSignedIn("oauth")))("/a", signal);
    const unread = await withModelRules(query, () => Promise.reject(new Error("no login program")))("/b", signal);

    expect([ids(read.models), read.defaultModel, ids(unread.models), asked]).toStrictEqual([
      KEPT,
      { providerId: "claude-bridge", modelId: "claude-opus-5-5" },
      KEPT,
      ["/a", "/b"],
    ]);
  });

  it.each(["oauth", "api_key"] as const)(
    "hides native Claude models and clears pi's default with %s credentials",
    async (method) => {
      const native = model("anthropic", "claude-opus-5-5");
      const defaultModel = { providerId: native.providerId, modelId: native.modelId };
      const login: SetupLogin = {
        state: "ready",
        providers: [
          {
            providerId: "anthropic",
            name: "Anthropic",
            oauth: { label: "Claude", subscription: true },
            apiKey: true,
            signedIn: { method, stored: true },
          },
        ],
      };
      const query = withModelRules(
        () => Promise.resolve({ models: [native], defaultModel }),
        () => Promise.resolve(login),
      );

      expect(await query("/a", new AbortController().signal)).toStrictEqual({ models: [], defaultModel: null });
    },
  );

  it("drops pi's default when it is not among what is kept, though its provider or its id is, and keeps none as none", async () => {
    const signal = new AbortController().signal;
    const defaults = [
      { providerId: "azure-openai-responses", modelId: "gpt-6" },
      { providerId: "claude-bridge", modelId: "claude-retired" },
      null,
    ];
    const found = await Promise.all(
      defaults.map((defaultModel) =>
        withModelRules(() => Promise.resolve({ models: LISTED, defaultModel }), signedOut)("/a", signal),
      ),
    );

    expect(found.map((list) => list.defaultModel)).toStrictEqual([null, null, null]);
  });
});
