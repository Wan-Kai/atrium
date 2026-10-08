import { createTempDir } from "@atrium/testkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadIndexFile } from "./index-file";
import { PREFERENCES_FILE } from "./index-schema";
import { createPreferenceStore } from "./preferences";

describe("PreferenceStore", () => {
  it("follows the system and shows summaries until told otherwise, then keeps what it was told", async () => {
    const index = await createTempDir("preferences");
    onTestFinished(index.cleanup);
    const { file } = await loadIndexFile(index.path, PREFERENCES_FILE, 0);
    const store = createPreferenceStore(file);
    expect(store.read()).toStrictEqual({ appearance: "system", displayMode: "summary" });

    await store.set({ appearance: "dark" });
    await store.set({ displayMode: "detailed" });

    expect(store.read()).toStrictEqual({ appearance: "dark", displayMode: "detailed" });
    expect(JSON.parse(await readFile(join(index.path, "preferences.json"), "utf8"))).toStrictEqual({
      version: 1,
      appearance: "dark",
      displayMode: "detailed",
    });
  });
});
