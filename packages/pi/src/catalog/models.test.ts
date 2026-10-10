import { describe, expect, it } from "vitest";
import { type PiModel, sessionModelOf, thinkingLevelsOf, toCatalogModel } from "./models";

/**
 * A model as pi lists it, with only the fields the catalog reads set apart from the defaults.
 *
 * @remarks
 * pi's `Model` has many more fields (costs, headers, compat); the catalog ignores them.
 *
 * @sideEffects none
 * @param fields - Fields to change.
 * @returns The model.
 */
function piModel(fields: Partial<PiModel>): PiModel {
  return {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    ...fields,
  };
}

describe("thinkingLevelsOf", () => {
  it("gives a model that does not think only off", () => {
    expect(thinkingLevelsOf(piModel({ reasoning: false, thinkingLevelMap: { high: "high" } }))).toStrictEqual(["off"]);
  });

  it("gives a thinking model off to high, but xhigh and max only when its map names them", () => {
    expect(thinkingLevelsOf(piModel({}))).toStrictEqual(["off", "minimal", "low", "medium", "high"]);
    expect(thinkingLevelsOf(piModel({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } }))).toStrictEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("leaves out the levels its map sets to null", () => {
    expect(
      thinkingLevelsOf(piModel({ thinkingLevelMap: { off: null, minimal: null, xhigh: "high", max: null } })),
    ).toStrictEqual(["low", "medium", "high", "xhigh"]);
  });
});

describe("toCatalogModel", () => {
  it("keeps what the model panel shows", () => {
    expect(toCatalogModel(piModel({ thinkingLevelMap: { max: "max" } }))).toStrictEqual({
      providerId: "anthropic",
      modelId: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      supportsImage: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "max"],
    });
  });

  it("says a text-only model takes no images", () => {
    expect(toCatalogModel(piModel({ input: ["text"] }))?.supportsImage).toBe(false);
  });

  it("names a model without a name by its id", () => {
    expect(toCatalogModel(piModel({ name: "" }))?.name).toBe("claude-opus-5-5");
  });

  it("cuts a name too long to send, and leaves out a model whose id or provider is", () => {
    expect(toCatalogModel(piModel({ name: "n".repeat(600) }))?.name).toBe("n".repeat(512));
    expect(toCatalogModel(piModel({ id: "i".repeat(512), provider: "p".repeat(256) }))).not.toBeNull();
    expect(toCatalogModel(piModel({ id: "i".repeat(513) }))).toBeNull();
    expect(toCatalogModel(piModel({ provider: "p".repeat(257) }))).toBeNull();
  });
});

describe("sessionModelOf", () => {
  it("takes the model and thinking level from pi's state", () => {
    expect(sessionModelOf({ model: piModel({}), thinkingLevel: "high" })).toStrictEqual({
      providerId: "anthropic",
      modelId: "claude-opus-5-5",
      thinkingLevel: "high",
    });
  });

  it("is null without a model", () => {
    expect(sessionModelOf({ thinkingLevel: "medium" })).toBeNull();
  });

  it("is null for pi's placeholder, which it uses when no provider has credentials", () => {
    const placeholder = piModel({ id: "unknown", name: "unknown", api: "unknown", provider: "unknown" });

    expect(sessionModelOf({ model: placeholder, thinkingLevel: "off" })).toBeNull();
    expect(sessionModelOf({ model: { ...placeholder, id: "real" }, thinkingLevel: "off" })).toMatchObject({
      modelId: "real",
    });
    expect(sessionModelOf({ model: { ...placeholder, provider: "real" }, thinkingLevel: "off" })).toMatchObject({
      providerId: "real",
    });
  });
});
