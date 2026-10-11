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
      setupDone: false,
      appearance: "system",
      displayMode: "summary",
      lastModel: null,
      thinkingByModel: {},
      statusBar: {},
      titleModel: null,
      proxy: null,
    });

    await store.set({ appearance: "dark" });
    await store.set({ displayMode: "detailed" });

    expect(store.read()).toStrictEqual({
      setupDone: false,
      appearance: "dark",
      displayMode: "detailed",
      lastModel: null,
      thinkingByModel: {},
      statusBar: {},
      titleModel: null,
      proxy: null,
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
      setupDone: false,
      appearance: "system",
      displayMode: "summary",
      lastModel: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      thinkingByModel: { "anthropic/claude-opus-5-5": "max", "openai/gpt-6": "low" },
      statusBar: {},
      titleModel: null,
      proxy: null,
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
      setupDone: false,
      appearance: "light",
      displayMode: "thinking",
      lastModel: null,
      thinkingByModel: {},
      statusBar: {},
      titleModel: null,
      proxy: null,
    });
  });

  it("keeps the status bar groups switched from their default, replacing them whole", async () => {
    const index = await indexDirectory();
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);

    await store.set({ statusBar: { cost: true, session: false } });
    await store.set({ statusBar: { tokens: false } });

    expect(store.read().statusBar).toStrictEqual({ tokens: false });
    expect(JSON.parse(await readFile(join(index, "preferences.json"), "utf8"))).toStrictEqual({
      version: 2,
      appearance: "system",
      displayMode: "summary",
      lastModel: null,
      thinkingByModel: {},
      statusBar: { tokens: false },
    });
  });

  it("reads a file from before the status bar could be set as all defaults, and leaves out ids no group could have", async () => {
    const index = await indexDirectory();
    const before = { version: 2, appearance: "light", displayMode: "summary", lastModel: null, thinkingByModel: {} };
    await writeFile(join(index, "preferences.json"), JSON.stringify(before));
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);
    expect(store.read().statusBar).toStrictEqual({});

    await writeFile(
      join(index, "preferences.json"),
      JSON.stringify({ ...before, statusBar: { "": true, ["g".repeat(65)]: false, later: true } }),
    );
    const again = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);

    expect(again.read().statusBar).toStrictEqual({ later: true });
  });

  it("has first launch to do and titles from the session's model until told otherwise, also in a file from before M1.10", async () => {
    const index = await indexDirectory();
    const before = { version: 2, appearance: "light", displayMode: "summary", lastModel: null, thinkingByModel: {} };
    await writeFile(join(index, "preferences.json"), JSON.stringify(before));
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);
    const old = store.read();

    await store.set({ setupDone: true, titleModel: { providerId: "anthropic", modelId: "claude-haiku-4-5" } });

    expect(old).toMatchObject({ setupDone: false, titleModel: null });
    expect(store.read()).toMatchObject({
      setupDone: true,
      titleModel: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    });
    expect(JSON.parse(await readFile(join(index, "preferences.json"), "utf8"))).toStrictEqual({
      ...before,
      setupDone: true,
      titleModel: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    });
  });

  it("has no proxy until one is set, also in a file from before it, and reads one the host would refuse as none", async () => {
    const index = await indexDirectory();
    const before = { version: 2, appearance: "light", displayMode: "summary", lastModel: null, thinkingByModel: {} };
    await writeFile(join(index, "preferences.json"), JSON.stringify(before));
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);
    const old = store.read();

    await store.set({ proxy: { url: "http://127.0.0.1:7897", noProxy: [".example.com"] } });

    expect(old.proxy).toBeNull();
    expect(store.read().proxy).toStrictEqual({ url: "http://127.0.0.1:7897", noProxy: [".example.com"] });
    expect(JSON.parse(await readFile(join(index, "preferences.json"), "utf8"))).toStrictEqual({
      ...before,
      proxy: { url: "http://127.0.0.1:7897", noProxy: [".example.com"] },
    });

    await writeFile(
      join(index, "preferences.json"),
      JSON.stringify({ ...before, proxy: { url: "http://me:secret@127.0.0.1:7897", noProxy: [] } }),
    );
    const handWritten = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);

    expect(handWritten.read().proxy).toBeNull();
  });
});
