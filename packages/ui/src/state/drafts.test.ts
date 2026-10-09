import { describe, expect, it } from "vitest";
import { type DraftStorage, dropDrafts, keepImages, keptImages, loadDraft, saveDraft } from "./drafts";

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

/** An uploaded image named `id`. */
function kept(id: string) {
  return { id, image: { mimeType: "image/webp" as const, data: id, preview: id }, attachmentId: id };
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

  it.each([
    ["only text", { text: "a", pastes: [], files: [] }],
    ["only a pasted text", { text: "", pastes: [{ id: "p1", text: "x" }], files: [] }],
    ["only a file", { text: "", pastes: [], files: ["a.ts"] }],
  ])("keeps a draft with %s", (_case, draft) => {
    const { storage } = memory();

    expect(saveDraft("s1", draft, storage)).toBe(true);

    expect(loadDraft("s1", storage)).toStrictEqual(draft);
  });

  it("forgets a draft once it is empty", () => {
    const { storage, store } = memory();
    saveDraft("s1", DRAFT, storage);

    expect(saveDraft("s1", { text: "", pastes: [], files: [] }, storage)).toBe(true);

    expect(store.size).toBe(0);
  });

  it("says when storage is full, so the draft stays only in memory", () => {
    const { storage } = memory(true);

    expect(saveDraft("s1", DRAFT, storage)).toBe(false);
    expect(loadDraft("s1", storage)).toBeNull();
  });

  it.each([
    ["text that is not JSON", "{ not json"],
    ["JSON null", "null"],
    ["a number", "7"],
    ["no text", JSON.stringify({ pastes: [], files: [] })],
    ["no pastes", JSON.stringify({ text: "", files: [] })],
    ["no files", JSON.stringify({ text: "", pastes: [] })],
    ["text that is not a string", JSON.stringify({ text: 1, pastes: [], files: [] })],
    ["pastes that are not a list", JSON.stringify({ text: "", pastes: {}, files: [] })],
    ["files that are not a list", JSON.stringify({ text: "", pastes: [], files: "a.ts" })],
    ["a paste that is null", JSON.stringify({ text: "", pastes: [{ id: "p", text: "x" }, null], files: [] })],
    ["a paste that is a string", JSON.stringify({ text: "", pastes: ["x"], files: [] })],
    ["a paste without an id", JSON.stringify({ text: "", pastes: [{ text: "x" }], files: [] })],
    ["a paste without text", JSON.stringify({ text: "", pastes: [{ id: "p" }], files: [] })],
    ["a paste whose id is a number", JSON.stringify({ text: "", pastes: [{ id: 1, text: "x" }], files: [] })],
    ["a paste whose text is a number", JSON.stringify({ text: "", pastes: [{ id: "p", text: 1 }], files: [] })],
    ["a file that is not a string", JSON.stringify({ text: "", pastes: [], files: ["a.ts", 1] })],
  ])("reads a draft with %s as none", (_case, stored) => {
    const { storage, store } = memory();
    store.set("atrium-draft:s1", stored);

    expect(loadDraft("s1", storage)).toBeNull();
  });

  it("drops the drafts of the sessions named, their images too, and nothing else", () => {
    const { storage, store } = memory();
    saveDraft("s1", DRAFT, storage);
    saveDraft("s2", DRAFT, storage);
    keepImages("s1", [kept("image")]);
    keepImages("s2", [kept("other")]);
    store.set("atrium-dot-seed", "7");

    dropDrafts(["s1", "s3"], storage);

    expect([...store.keys()].toSorted()).toStrictEqual(["atrium-dot-seed", "atrium-draft:s2"]);
    expect(keptImages("s1")).toStrictEqual([]);
    expect(keptImages("s2")).toStrictEqual([kept("other")]);
    dropDrafts(["s2"], storage);
  });

  it("keeps a session's images in memory only, forgetting them once none are left", () => {
    keepImages("s1", [kept("a"), kept("b")]);
    expect(keptImages("s1")).toStrictEqual([kept("a"), kept("b")]);

    keepImages("s1", []);

    expect(keptImages("s1")).toStrictEqual([]);
  });
});
