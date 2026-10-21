import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeClient } from "../test/fake-client";
import { pageDrafts } from "./use-draft";
import { dropStoppedEdits, finishStoppedEdit, stoppedEditStore, type StoppedEdit } from "./stopped-edits";

const stored = new Map<string, string>();
beforeAll(() =>
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
    removeItem: (key: string) => {
      stored.delete(key);
    },
  }),
);
afterAll(() => vi.unstubAllGlobals());

/**
 * Makes an immutable editor target with its own populated draft.
 * @remarks Tests use different keys so the real page-draft cache remains isolated between cases.
 * @sideEffects Writes the target's private draft through the in-memory storage.
 * @returns The target whose identity is used to reject stale completion.
 */
function target(): StoppedEdit {
  const draftKey = `edit:${crypto.randomUUID()}`;
  pageDrafts().update(draftKey, () => ({ text: "修订正文", images: [], pastes: [], files: [], command: null }));
  return { epoch: 7, turnId: "turn", draftKey, images: [], savedDraft: true };
}

describe("page-local stopped-message editors", () => {
  it("keeps stable stores per client and session without sharing identities", () => {
    const { client } = fakeClient();
    const other = fakeClient().client;
    const store = stoppedEditStore(client, "s1");
    expect(store.getState()).toStrictEqual({ target: null, submitting: false, error: null });
    expect(stoppedEditStore(client, "s1")).toBe(store);
    expect(stoppedEditStore(client, "s2")).not.toBe(store);
    expect(stoppedEditStore(other, "s1")).not.toBe(store);
    const selected = target();
    store.setState({ target: selected, submitting: true, error: "failure" });
    expect(stoppedEditStore(client, "s1").getState()).toStrictEqual({
      target: selected,
      submitting: true,
      error: "failure",
    });
    expect(stoppedEditStore(other, "s1").getState()).toStrictEqual({ target: null, submitting: false, error: null });
  });

  it("finishes only the private edit draft and resets request status", () => {
    const { client } = fakeClient();
    const store = stoppedEditStore(client, "s1");
    const selected = target();
    pageDrafts().update("s1", () => ({
      text: "下一条草稿",
      images: [],
      pastes: [{ id: "paste", text: "粘贴" }],
      files: ["note.ts"],
      command: null,
    }));
    const next = pageDrafts().read("s1");
    store.setState({ target: selected, submitting: true, error: "failure" });
    finishStoppedEdit(store, selected);
    expect(store.getState()).toStrictEqual({ target: null, submitting: false, error: null });
    expect(pageDrafts().read(selected.draftKey)).toStrictEqual({
      text: "",
      images: [],
      pastes: [],
      files: [],
      command: null,
    });
    expect(stored.has(`atrium-draft:${selected.draftKey}`)).toBe(false);
    expect(pageDrafts().read("s1")).toBe(next);
  });

  it("does not let an older request clear a newer editor", () => {
    const { client } = fakeClient();
    const store = stoppedEditStore(client, "s1");
    const older = target();
    // Attachment recovery replaces identity while deliberately preserving this same draft key.
    const newer = { ...older, epoch: older.epoch + 1 };
    store.setState({ target: newer, submitting: true, error: "new failure" });
    finishStoppedEdit(store, older);
    expect(store.getState()).toStrictEqual({ target: newer, submitting: true, error: "new failure" });
    expect(pageDrafts().read(older.draftKey).text).toBe("修订正文");
    expect(pageDrafts().read(newer.draftKey).text).toBe("修订正文");
  });

  it("does not resurrect a cancelled editor when its request later finishes", () => {
    const { client } = fakeClient();
    const store = stoppedEditStore(client, "s1");
    const selected = target();
    store.setState({ target: selected, submitting: true, error: null });
    finishStoppedEdit(store, selected);
    finishStoppedEdit(store, selected);
    expect(store.getState()).toStrictEqual({ target: null, submitting: false, error: null });
    expect(pageDrafts().read(selected.draftKey).text).toBe("");
  });

  it("drops only selected sessions while keeping other editors and other clients", () => {
    const { client } = fakeClient();
    const other = fakeClient().client;
    const first = target();
    const second = target();
    const kept = target();
    const otherClient = target();
    stoppedEditStore(client, "s1").setState({ target: first, submitting: true, error: "old" });
    stoppedEditStore(client, "s2").setState({ target: second });
    stoppedEditStore(client, "s3").setState({ target: kept });
    stoppedEditStore(other, "s1").setState({ target: otherClient });
    dropStoppedEdits(client, ["s1", "s2", "unknown"]);
    expect(stoppedEditStore(client, "s1").getState()).toStrictEqual({ target: null, submitting: false, error: null });
    expect(stoppedEditStore(client, "s2").getState()).toStrictEqual({ target: null, submitting: false, error: null });
    expect(stoppedEditStore(client, "s3").getState().target).toBe(kept);
    expect(stoppedEditStore(other, "s1").getState().target).toBe(otherClient);
    expect(pageDrafts().read(first.draftKey).text).toBe("");
    expect(pageDrafts().read(second.draftKey).text).toBe("");
    expect(pageDrafts().read(kept.draftKey).text).toBe("修订正文");
    expect(pageDrafts().read(otherClient.draftKey).text).toBe("修订正文");
    dropStoppedEdits(client, ["s1"]);
    expect(stoppedEditStore(client, "s3").getState().target).toBe(kept);
  });

  it("releases discarded session stores even when they never held an edit", () => {
    const { client } = fakeClient();
    const empty = stoppedEditStore(client, "empty");
    const active = stoppedEditStore(client, "active");
    const selected = target();
    active.setState({ target: selected });
    dropStoppedEdits(client, ["empty", "active"]);
    expect(stoppedEditStore(client, "empty")).not.toBe(empty);
    expect(stoppedEditStore(client, "active")).not.toBe(active);
    expect(active.getState()).toStrictEqual({ target: null, submitting: false, error: null });
    expect(stoppedEditStore(client, "active").getState()).toStrictEqual({
      target: null,
      submitting: false,
      error: null,
    });
    expect(pageDrafts().read(selected.draftKey).text).toBe("");
  });

  it("accepts cleanup before a client has ever opened an editor", () => {
    const { client } = fakeClient();
    expect(() => dropStoppedEdits(client, ["unknown"])).not.toThrow();
    expect(stoppedEditStore(client, "unknown").getState()).toStrictEqual({
      target: null,
      submitting: false,
      error: null,
    });
  });
});
