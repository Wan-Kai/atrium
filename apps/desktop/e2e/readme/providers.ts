import type { ReadmeFauxProvider } from "@atrium/testkit";

/**
 * The providers and models the README screenshots show, under the real providers' names.
 *
 * @remarks
 * The model panel and the status bar look as they do for a user signed in to Claude's and
 * ChatGPT's plans, with Copilot and two API keys besides. Claude's plan usage comes as the reply
 * headers Anthropic sends, counted from now so the reset times read the same on every run;
 * ChatGPT's goes to the stand-in backend.
 *
 * @sideEffects none
 * @param chatgptBase - The stand-in ChatGPT backend's address.
 * @returns The providers.
 */
export function providers(chatgptBase: string): ReadmeFauxProvider[] {
  const HOUR = 3600;
  const now = Math.floor(Date.now() / 1000);
  return [
    {
      id: "claude-bridge",
      headers: {
        "anthropic-ratelimit-unified-5h-utilization": "0.42",
        "anthropic-ratelimit-unified-5h-reset": String(now + 2 * HOUR + 13 * 60),
        "anthropic-ratelimit-unified-7d-utilization": "0.27",
        "anthropic-ratelimit-unified-7d-reset": String(now + 4 * 24 * HOUR),
      },
      models: [
        {
          id: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          contextWindow: 200_000,
          maxTokens: 128_000,
          thinkingLevelMap: { xhigh: "xhigh" },
        },
        {
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          thinkingLevelMap: { xhigh: "xhigh" },
        },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, maxTokens: 64_000 },
      ],
    },
    {
      id: "openai-codex",
      baseUrl: chatgptBase,
      models: [
        {
          id: "gpt-6.1-sol",
          name: "GPT-6.1 Sol",
          contextWindow: 400_000,
          maxTokens: 128_000,
          thinkingLevelMap: { xhigh: "xhigh" },
        },
        {
          id: "gpt-6-sol",
          name: "GPT-6 Sol",
          contextWindow: 400_000,
          maxTokens: 128_000,
          thinkingLevelMap: { xhigh: "xhigh" },
        },
        { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 400_000, maxTokens: 128_000 },
      ],
    },
    {
      id: "github-copilot",
      models: [
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", contextWindow: 128_000, maxTokens: 16_000 },
        { id: "gpt-5-mini", name: "GPT-5 mini", contextWindow: 128_000, maxTokens: 64_000 },
      ],
    },
    {
      id: "deepseek",
      models: [{ id: "deepseek-v4", name: "DeepSeek V4", input: ["text"], contextWindow: 128_000, maxTokens: 64_000 }],
    },
    {
      id: "moonshotai",
      models: [{ id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 256_000, maxTokens: 32_000 }],
    },
  ];
}
