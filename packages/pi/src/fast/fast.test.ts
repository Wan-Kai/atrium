import { describe, expect, it } from "vitest";
import { fastCreditsOf } from "./fast";

describe("fastCreditsOf", () => {
  it.each([
    ["gpt-5.4", 2],
    ["gpt-5.5", 2.5],
    ["gpt-5.6", 2.5],
    ["gpt-5.5-codex", 2.5],
    ["gpt-5.4-mini", 2],
  ])("gives ChatGPT's %s Fast at about %s times the credits", (id, credits) => {
    expect(fastCreditsOf({ provider: "openai-codex", id })).toBe(credits);
  });

  it.each([
    ["an older GPT", "openai-codex", "gpt-5.3-codex"],
    ["a newer GPT", "openai-codex", "gpt-5.7"],
    ["a version that only starts like one", "openai-codex", "gpt-5.55"],
    ["a name with the version inside", "openai-codex", "my-gpt-5.5"],
    ["the same model by API key", "openai", "gpt-5.5"],
    ["another provider", "anthropic", "claude-opus-5-5"],
  ])("gives %s no Fast", (_case, provider, id) => {
    expect(fastCreditsOf({ provider, id })).toBeNull();
  });
});
