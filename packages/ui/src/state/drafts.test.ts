import { describe, expect, it } from "vitest";
import { type DraftStorage, dropDrafts, loadDraft, saveDraft } from "./drafts";

/**
 * Storage in memory, with the keys it holds.
 *
 * @remarks
 * `full` makes every write fail, as a full localStorage does.
 *
 * @sideEffects none
 * @param full - Whether writes fail.
 * @returns The storage and its map.
 */
function memory(full = false): { readonly storage: DraftStorage; readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  const storage: DraftStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      if (full) throw new DOMException("full", "QuotaExceededError");
      store.set(key, value);
    },
    removeItem: (key) => void store.delete(key),
  };
  return { storage, store };
}

const DRAFT = { text: "half a thought", pastes: [{ id: "p1", text: "pasted" }], files: ["src/a.ts"] };

describe("drafts", () => {
  it("keeps a session's draft under its own key and gives it back", () => {
    const { storage, store } = memory();

    expect(saveDraft("s1", DRAFT, storage)).toBe(true);

    expect(loadDraft("s1", storage)).toStrictEqual(DRAFT);
    expect(loadDraft("s2", storage)).toBeNull();
    expect([...store.keys()]).toStrictEqual(["atrium-draft:s1"]);
  });

  it("forgets a draft once it is empty", () => {
    const { storage, store } = memory();
    saveDraft("s1", DRAFT, storage);

    saveDraft("s1", { text: "", pastes: [], files: [] }, storage);

    expect(store.size).toBe(0);
  });

  it("says when storage is full, so the draft stays only in memory", () => {
    const { storage } = memory(true);

    expect(saveDraft("s1", DRAFT, storage)).toBe(false);
    expect(loadDraft("s1", storage)).toBeNull();
  });

  it("reads a damaged draft as none", () => {
    const { storage, store } = memory();
    store.set("atrium-draft:s1", "{ not json");
    store.set("atrium-draft:s2", JSON.stringify({ text: 1 }));

    expect(loadDraft("s1", storage)).toBeNull();
    expect(loadDraft("s2", storage)).toBeNull();
  });

  it("drops the drafts of the sessions named, and nothing else", () => {
    const { storage, store } = memory();
    saveDraft("s1", DRAFT, storage);
    saveDraft("s2", DRAFT, storage);
    store.set("atrium-dot-seed", "7");

    dropDrafts(["s1", "s3"], storage);

    expect([...store.keys()].toSorted()).toStrictEqual(["atrium-dot-seed", "atrium-draft:s2"]);
  });
});
