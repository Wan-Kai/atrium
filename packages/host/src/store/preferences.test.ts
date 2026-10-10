import { createTempDir } from "@atrium/testkit";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadIndexFile } from "./index-file";
import { PREFERENCES_FILE } from "./index-schema";
import { createPreferenceStore } from "./preferences";

/**
 * An index directory for one test.
 *
 * @remarks
 * Real files, as everywhere in the store's tests.
 *
 * @sideEffects Creates a temporary directory, removed when the test ends.
 * @returns Its path.
 */
async function indexDirectory(): Promise<string> {
  const index = await createTempDir("preferences");
  onTestFinished(index.cleanup);
  return index.path;
}

describe("PreferenceStore", () => {
  it("follows the system and shows summaries until told otherwise, then keeps what it was told", async () => {
    const index = await indexDirectory();
    const { file } = await loadIndexFile(index, PREFERENCES_FILE, 0);
    const store = createPreferenceStore(file);
    expect(store.read()).toStrictEqual({
      appearance: "system",
      displayMode: "summary",
      lastModel: null,
      thinkingByModel: {},
    });

    await store.set({ appearance: "dark" });
    await store.set({ displayMode: "detailed" });

    expect(store.read()).toStrictEqual({
      appearance: "dark",
      displayMode: "detailed",
      lastModel: null,
      thinkingByModel: {},
    });
    expect(JSON.parse(await readFile(join(index, "preferences.json"), "utf8"))).toStrictEqual({
      version: 2,
      appearance: "dark",
      displayMode: "detailed",
      lastModel: null,
      thinkingByModel: {},
    });
  });

  it("remembers the last model and each model's thinking level", async () => {
    const index = await indexDirectory();
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);

    await store.remember({ providerId: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" });
    await store.remember({ providerId: "openai", modelId: "gpt-6", thinkingLevel: "low" });
    await store.remember({ providerId: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "max" });

    expect(store.read()).toStrictEqual({
      appearance: "system",
      displayMode: "summary",
      lastModel: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      thinkingByModel: { "anthropic/claude-opus-5-5": "max", "openai/gpt-6": "low" },
    });
  });

  it("gives new sessions the model chosen last, with its thinking level if one was remembered", async () => {
    const index = await indexDirectory();
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);
    expect(store.preferred()).toBeNull();

    await store.remember({ providerId: "anthropic", modelId: "haiku", thinkingLevel: "low" });
    expect(store.preferred()).toStrictEqual({
      model: { providerId: "anthropic", modelId: "haiku" },
      thinkingLevel: "low",
    });
    await store.set({ lastModel: { providerId: "openai", modelId: "gpt-6" } });

    expect(store.preferred()).toStrictEqual({ model: { providerId: "openai", modelId: "gpt-6" }, thinkingLevel: null });
  });

  it("upgrades a file from before models were remembered", async () => {
    const index = await indexDirectory();
    await writeFile(
      join(index, "preferences.json"),
      JSON.stringify({ version: 1, appearance: "light", displayMode: "thinking" }),
    );

    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);

    expect(store.read()).toStrictEqual({
      appearance: "light",
      displayMode: "thinking",
      lastModel: null,
      thinkingByModel: {},
    });
  });
});
