import { describe, expect, it } from "vitest";
import { type DraftStorage, type KeptImage, createDrafts } from "./drafts";

/**
 * Storage in memory, with the keys it holds.
 *
 * @remarks
 * `fill` makes every later write fail, as a full localStorage does.
 *
 * @sideEffects none
 * @returns The storage, its map, and how to fill it.
 */
function memory() {
  const store = new Map<string, string>();
  let full = false;
  const storage: DraftStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      if (full) throw new DOMException("full", "QuotaExceededError");
      store.set(key, value);
    },
    removeItem: (key) => void store.delete(key),
  };
  return {
    storage,
    store,
    fill: () => {
      full = true;
    },
  };
}

/** An image named `id`, uploaded as `attachmentId`. */
function kept(id: string, attachmentId: string | null = id): KeptImage {
  return { id, image: { mimeType: "image/webp", data: id, preview: id }, attachmentId };
}

const TEXT = { text: "half a thought", pastes: [{ id: "p1", text: "pasted" }], files: ["src/a.ts"] };
const DRAFT = { ...TEXT, images: [] };
const EMPTY = { text: "", pastes: [], files: [], images: [] };

describe("createDrafts", () => {
  it("keeps a session's draft under its own key, in memory and in storage, telling those listening", () => {
    const { storage, store } = memory();
    const drafts = createDrafts(storage);
    const heard: string[] = [];
    drafts.subscribe("s1", () => heard.push("s1"));
    drafts.subscribe("s2", () => heard.push("s2"));

    drafts.update("s1", () => DRAFT);

    expect(drafts.read("s1")).toStrictEqual(DRAFT);
    expect(drafts.read("s2")).toStrictEqual(EMPTY);
    expect(store).toStrictEqual(new Map([["atrium-draft:s1", JSON.stringify(TEXT)]]));
    expect(heard).toStrictEqual(["s1"]);
  });

  it("gives back the same draft until it changes, and stops telling a listener gone", () => {
    const drafts = createDrafts(memory().storage);
    const heard: number[] = [];
    const stop = drafts.subscribe("s1", () => heard.push(1));
    const before = drafts.read("s1");

    expect(drafts.read("s1")).toBe(before);
    drafts.update("s1", (draft) => draft);
    stop();
    drafts.update("s1", () => DRAFT);

    expect(heard).toStrictEqual([]);
    expect(drafts.read("s1")).toStrictEqual(DRAFT);
  });

  it("reads a draft an earlier page left in storage", () => {
    const { storage, store } = memory();
    store.set("atrium-draft:s1", JSON.stringify(TEXT));

    expect(createDrafts(storage).read("s1")).toStrictEqual(DRAFT);
  });

  it.each([
    ["only text", { text: "a", pastes: [], files: [] }],
    ["only a pasted text", { text: "", pastes: [{ id: "p1", text: "x" }], files: [] }],
    ["only a file", { text: "", pastes: [], files: ["a.ts"] }],
  ])("stores a draft with %s", (_case, text) => {
    const { storage, store } = memory();

    createDrafts(storage).update("s1", () => ({ ...text, images: [] }));

    expect(createDrafts(storage).read("s1")).toStrictEqual({ ...text, images: [] });
    expect(store.size).toBe(1);
  });

  it("lets the stored copy go once the draft is empty, images or not", () => {
    const { storage, store } = memory();
    const drafts = createDrafts(storage);
    drafts.update("s1", () => DRAFT);

    drafts.update("s1", () => ({ ...EMPTY, images: [kept("a")] }));

    expect(store.size).toBe(0);
    expect(drafts.read("s1")).toStrictEqual({ ...EMPTY, images: [kept("a")] });
  });

  it("keeps a draft in memory when storage is full, letting the older stored copy go", () => {
    const { storage, store, fill } = memory();
    const drafts = createDrafts(storage);
    drafts.update("s1", () => ({ ...EMPTY, text: "older" }));
    fill();

    drafts.update("s1", () => DRAFT);

    expect(drafts.read("s1")).toStrictEqual(DRAFT);
    expect(store.size).toBe(0);
  });

  it("reads storage again once it changed elsewhere, keeping the images", () => {
    const { storage, store } = memory();
    const drafts = createDrafts(storage);
    drafts.update("s1", () => ({ ...DRAFT, images: [kept("a")] }));

    store.clear();

    expect(drafts.read("s1")).toStrictEqual({ ...EMPTY, images: [kept("a")] });
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
  ])("reads a draft with %s as empty", (_case, stored) => {
    const { storage, store } = memory();
    store.set("atrium-draft:s1", stored);

    expect(createDrafts(storage).read("s1")).toStrictEqual(EMPTY);
  });

  it("changes an image wherever its draft has gone, and takes it off when told", () => {
    const { storage, store } = memory();
    const drafts = createDrafts(storage);
    drafts.update("new:chats", () => ({ ...DRAFT, images: [kept("a", null), kept("b")] }));
    drafts.handOver("new:chats", "s1");

    drafts.updateImage("a", (image) => ({ ...image, attachmentId: "up-a" }));
    expect(drafts.read("s1").images).toStrictEqual([kept("a", "up-a"), kept("b")]);
    drafts.updateImage("b", () => null);

    expect(drafts.read("s1")).toStrictEqual({ ...DRAFT, images: [kept("a", "up-a")] });
    expect(drafts.read("new:chats")).toStrictEqual(EMPTY);
    expect([...store.keys()]).toStrictEqual(["atrium-draft:s1"]);
  });

  it("hands nothing over from an empty draft, keeping what the other one has", () => {
    const drafts = createDrafts(memory().storage);
    drafts.update("s1", () => DRAFT);

    drafts.handOver("new:chats", "s1");

    expect(drafts.read("s1")).toStrictEqual(DRAFT);
  });

  it("puts a message that did not go back into its draft, only when the draft is empty", () => {
    const drafts = createDrafts(memory().storage);

    drafts.restore("s1", "去了又回", [kept("a")]);
    drafts.restore("s1", "不会覆盖", []);

    expect(drafts.read("s1")).toStrictEqual({ ...EMPTY, text: "去了又回", images: [kept("a")] });
  });

  it("drops the drafts named, their images too, and nothing else", () => {
    const { storage, store } = memory();
    const drafts = createDrafts(storage);
    drafts.update("s1", () => ({ ...DRAFT, images: [kept("a")] }));
    drafts.update("s2", () => ({ ...DRAFT, images: [kept("b")] }));
    store.set("atrium-dot-seed", "7");
    const heard: string[] = [];
    drafts.subscribe("s1", () => heard.push("s1"));

    drafts.drop(["s1", "s3"]);

    expect([...store.keys()].toSorted()).toStrictEqual(["atrium-dot-seed", "atrium-draft:s2"]);
    expect(drafts.read("s1")).toStrictEqual(EMPTY);
    expect(drafts.read("s2")).toStrictEqual({ ...DRAFT, images: [kept("b")] });
    expect(heard).toStrictEqual(["s1"]);
  });

  it.each([
    ["text", { ...EMPTY, text: "mine" }],
    ["a pasted text", { ...EMPTY, pastes: [{ id: "p1", text: "x" }] }],
    ["a file", { ...EMPTY, files: ["a.ts"] }],
    ["an image", { ...EMPTY, images: [kept("a")] }],
  ])("puts nothing back into a draft holding %s", (_case, draft) => {
    const drafts = createDrafts(memory().storage);
    drafts.update("s1", () => draft);

    drafts.restore("s1", "去了又回", [kept("b")]);

    expect(drafts.read("s1")).toStrictEqual(draft);
  });

  it("hands over a draft of images alone", () => {
    const drafts = createDrafts(memory().storage);
    drafts.update("new:chats", () => ({ ...EMPTY, images: [kept("a")] }));

    drafts.handOver("new:chats", "s1");

    expect(drafts.read("s1")).toStrictEqual({ ...EMPTY, images: [kept("a")] });
  });

  it("follows storage changed elsewhere after a draft was read or emptied", () => {
    const { storage, store } = memory();
    const drafts = createDrafts(storage);
    store.set("atrium-draft:s1", JSON.stringify(TEXT));
    drafts.read("s1");
    drafts.update("s2", () => DRAFT);
    drafts.update("s2", () => EMPTY);

    store.set("atrium-draft:s1", JSON.stringify({ ...TEXT, text: "changed" }));
    store.set("atrium-draft:s2", JSON.stringify(TEXT));

    expect(drafts.read("s1")).toStrictEqual({ ...DRAFT, text: "changed" });
    expect(drafts.read("s2")).toStrictEqual(DRAFT);
  });

  it("keeps a draft storage could not take over what storage gets later", () => {
    const { storage, store, fill } = memory();
    const drafts = createDrafts(storage);
    fill();
    drafts.update("s1", () => DRAFT);

    store.set("atrium-draft:s1", JSON.stringify({ ...TEXT, text: "from elsewhere" }));

    expect(drafts.read("s1")).toStrictEqual(DRAFT);
  });

  it("keeps telling the other listeners of a key when one stops", () => {
    const drafts = createDrafts(memory().storage);
    const heard: string[] = [];
    const stop = drafts.subscribe("s1", () => heard.push("first"));
    drafts.subscribe("s1", () => heard.push("second"));

    stop();
    drafts.update("s1", () => DRAFT);

    expect(heard).toStrictEqual(["second"]);
  });

  it("changes an image only in the draft holding it, telling no one else", () => {
    const drafts = createDrafts(memory().storage);
    drafts.update("s1", () => ({ ...EMPTY, images: [kept("a", null)] }));
    drafts.update("s2", () => ({ ...EMPTY, images: [kept("b")] }));
    const heard: string[] = [];
    drafts.subscribe("s2", () => heard.push("s2"));

    drafts.updateImage("a", (image) => ({ ...image, attachmentId: "up-a" }));

    expect(heard).toStrictEqual([]);
    expect(drafts.read("s1").images).toStrictEqual([kept("a", "up-a")]);
  });
});
