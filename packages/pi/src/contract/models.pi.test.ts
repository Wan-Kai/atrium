import { FAUX_MODEL, FAUX_PROVIDER, present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";
import { sessionModelOf, thinkingLevelsOf, toCatalogModel } from "../catalog/models";

describe("pi contract: models", () => {
  it("models: lists the models with credentials, switches model and thinking level, and refuses an unknown model", async () => {
    await runScenario(
      {
        scenario: "models",
        script: {
          replies: [],
          models: [
            { id: "faux-plain", name: "Faux Plain", reasoning: false, input: ["text"] },
            { id: "faux-deep", reasoning: true, thinkingLevelMap: { minimal: null, max: "max" } },
          ],
        },
      },
      async ({ pi, events, until }) => {
        const { models } = await pi.request({ type: "get_available_models" });
        const before = await pi.request({ type: "get_state" });
        const levelsBefore = await pi.request({ type: "get_available_thinking_levels" });
        await pi.request({ type: "set_model", provider: FAUX_PROVIDER, modelId: "faux-deep" });
        const deepLevels = await pi.request({ type: "get_available_thinking_levels" });
        await pi.request({ type: "set_thinking_level", level: "max" });
        await until((event) => event.type === "thinking_level_changed");
        const deep = await pi.request({ type: "get_state" });
        await pi.request({ type: "set_model", provider: FAUX_PROVIDER, modelId: "faux-plain" });
        const plain = await pi.request({ type: "get_state" });
        const plainLevels = await pi.request({ type: "get_available_thinking_levels" });
        const unknown = await pi
          .request({ type: "set_model", provider: FAUX_PROVIDER, modelId: "faux-none" })
          .catch((error: unknown) => error);

        expect(models.map(toCatalogModel)).toStrictEqual([
          {
            providerId: FAUX_PROVIDER,
            modelId: FAUX_MODEL,
            name: expect.any(String),
            contextWindow: expect.any(Number),
            maxOutput: expect.any(Number),
            supportsImage: true,
            thinkingLevels: ["off", "minimal", "low", "medium", "high"],
            fastCredits: null,
          },
          {
            providerId: FAUX_PROVIDER,
            modelId: "faux-plain",
            name: "Faux Plain",
            contextWindow: expect.any(Number),
            maxOutput: expect.any(Number),
            supportsImage: false,
            thinkingLevels: ["off"],
            fastCredits: null,
          },
          {
            providerId: FAUX_PROVIDER,
            modelId: "faux-deep",
            name: expect.any(String),
            contextWindow: expect.any(Number),
            maxOutput: expect.any(Number),
            supportsImage: true,
            thinkingLevels: ["off", "low", "medium", "high", "max"],
            fastCredits: null,
          },
        ]);
        // Atrium's copy of pi's rule agrees with pi itself for each model it switched to.
        expect(levelsBefore.levels).toStrictEqual(thinkingLevelsOf(present(models[0], "the first model")));
        expect(deepLevels.levels).toStrictEqual(["off", "low", "medium", "high", "max"]);
        expect(plainLevels.levels).toStrictEqual(["off"]);
        expect(sessionModelOf(before)).toStrictEqual({
          providerId: FAUX_PROVIDER,
          modelId: FAUX_MODEL,
          thinkingLevel: "medium",
        });
        expect(sessionModelOf(deep)).toStrictEqual({
          providerId: FAUX_PROVIDER,
          modelId: "faux-deep",
          thinkingLevel: "max",
        });
        // Switching to a model that does not think brings the level down to what it supports.
        expect(sessionModelOf(plain)).toStrictEqual({
          providerId: FAUX_PROVIDER,
          modelId: "faux-plain",
          thinkingLevel: "off",
        });
        expect(unknown).toMatchObject({ reason: "rejected", detail: "Model not found: faux/faux-none" });
        expect(events.filter((event) => event.type === "thinking_level_changed")).toStrictEqual([
          { type: "thinking_level_changed", level: "max" },
          { type: "thinking_level_changed", level: "off" },
        ]);
      },
    );
  });
});
