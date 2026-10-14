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

/** A file from before M1.11 took the display mode out, which still has it. */
const BEFORE = { version: 2, appearance: "light", displayMode: "summary", lastModel: null, thinkingByModel: {} };

/** `BEFORE` as saved again: the current version, without the display mode. */
const UPGRADED = { version: 3, appearance: "light", lastModel: null, thinkingByModel: {} };

describe("PreferenceStore", () => {
  it("follows the system until told otherwise, then keeps what it was told", async () => {
    const index = await indexDirectory();
    const { file } = await loadIndexFile(index, PREFERENCES_FILE, 0);
    const store = createPreferenceStore(file);
    expect(store.read()).toStrictEqual({
      setupDone: false,
      appearance: "system",
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: null,
      proxy: null,
      inbox: true,
    });

    await store.set({ appearance: "light" });
    await store.set({ appearance: "dark" });

    expect(store.read()).toStrictEqual({
      setupDone: false,
      appearance: "dark",
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: null,
      proxy: null,
      inbox: true,
    });
    expect(JSON.parse(await readFile(join(index, "preferences.json"), "utf8"))).toStrictEqual({
      version: 3,
      appearance: "dark",
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
      lastModel: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      thinkingByModel: { "anthropic/claude-opus-5-5": "max", "openai/gpt-6": "low" },
      lastFast: false,
      statusBar: {},
      titleModel: null,
      proxy: null,
      inbox: true,
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

  it("remembers Fast as last switched, off until then, also in a file from before it", async () => {
    const index = await indexDirectory();
    await writeFile(join(index, "preferences.json"), JSON.stringify(BEFORE));
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);
    const old = store.read().lastFast;

    await store.rememberFast(true);
    const on = store.read().lastFast;
    await store.rememberFast(false);

    expect([old, on, store.read().lastFast]).toStrictEqual([false, true, false]);
    expect(JSON.parse(await readFile(join(index, "preferences.json"), "utf8"))).toStrictEqual({
      ...UPGRADED,
      lastFast: false,
    });
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
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: null,
      proxy: null,
      inbox: true,
    });
  });

  it("keeps the status bar groups switched from their default, replacing them whole", async () => {
    const index = await indexDirectory();
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);

    await store.set({ statusBar: { cost: true, session: false } });
    await store.set({ statusBar: { tokens: false } });

    expect(store.read().statusBar).toStrictEqual({ tokens: false });
    expect(JSON.parse(await readFile(join(index, "preferences.json"), "utf8"))).toStrictEqual({
      version: 3,
      appearance: "system",
      lastModel: null,
      thinkingByModel: {},
      statusBar: { tokens: false },
    });
  });

  it("reads a file from before the status bar could be set as all defaults, and leaves out ids no group could have", async () => {
    const index = await indexDirectory();
    await writeFile(join(index, "preferences.json"), JSON.stringify(BEFORE));
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);
    expect(store.read().statusBar).toStrictEqual({});

    await writeFile(
      join(index, "preferences.json"),
      JSON.stringify({ ...BEFORE, statusBar: { "": true, ["g".repeat(65)]: false, later: true } }),
    );
    const again = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);

    expect(again.read().statusBar).toStrictEqual({ later: true });
  });

  it("has first launch to do and titles from the session's model until told otherwise, also in a file from before M1.10", async () => {
    const index = await indexDirectory();
    await writeFile(join(index, "preferences.json"), JSON.stringify(BEFORE));
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);
    const old = store.read();

    await store.set({ setupDone: true, titleModel: { providerId: "anthropic", modelId: "claude-haiku-4-5" } });

    expect(old).toMatchObject({ setupDone: false, titleModel: null });
    expect(store.read()).toMatchObject({
      setupDone: true,
      titleModel: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    });
    expect(JSON.parse(await readFile(join(index, "preferences.json"), "utf8"))).toStrictEqual({
      ...UPGRADED,
      setupDone: true,
      titleModel: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    });
  });

  it("has no proxy until one is set, also in a file from before it, and reads one the host would refuse as none", async () => {
    const index = await indexDirectory();
    await writeFile(join(index, "preferences.json"), JSON.stringify(BEFORE));
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);
    const old = store.read();

    await store.set({ proxy: { url: "http://127.0.0.1:7897", noProxy: [".example.com"] } });

    expect(old.proxy).toBeNull();
    expect(store.read().proxy).toStrictEqual({ url: "http://127.0.0.1:7897", noProxy: [".example.com"] });
    expect(JSON.parse(await readFile(join(index, "preferences.json"), "utf8"))).toStrictEqual({
      ...UPGRADED,
      proxy: { url: "http://127.0.0.1:7897", noProxy: [".example.com"] },
    });

    await writeFile(
      join(index, "preferences.json"),
      JSON.stringify({ ...BEFORE, proxy: { url: "http://me:secret@127.0.0.1:7897", noProxy: [] } }),
    );
    const handWritten = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);

    expect(handWritten.read().proxy).toBeNull();
  });

  it("shows 等你处理 until told not to, also from a file from before it", async () => {
    const index = await indexDirectory();
    await writeFile(join(index, "preferences.json"), JSON.stringify(BEFORE));
    const store = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);
    const old = store.read();

    await store.set({ inbox: false });

    expect(old.inbox).toBe(true);
    expect(store.read().inbox).toBe(false);
    expect(JSON.parse(await readFile(join(index, "preferences.json"), "utf8"))).toStrictEqual({
      ...UPGRADED,
      inbox: false,
    });
  });
});
