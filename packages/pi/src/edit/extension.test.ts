import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, expectTypeOf, it } from "vitest";
import { editCommand } from "./edit";
import atriumEdit, { type EditApi, type EditEntry } from "./extension";

/** The command context pi supplies. */
type Context = Parameters<Parameters<EditApi["registerCommand"]>[1]["handler"]>[1];

/**
 * Builds a tree-backed stand-in for pi's read-only session API.
 * @remarks Navigation follows pi's special handling of user targets, not its general branch API.
 * @sideEffects none
 */
function stand(
  initial: readonly EditEntry[] = [
    { id: "p", parentId: null, type: "message", message: { role: "system" } },
    { id: "u", parentId: "p", type: "message", message: { role: "user" } },
    { id: "a", parentId: "u", type: "message", message: { role: "assistant" } },
  ],
) {
  const entries = [...initial];
  const state = { leaf: initial.at(-1)?.id ?? (null as string | null), cancelled: false, error: false, noMove: false };
  const navigations: unknown[] = [];
  let handler: (args: string, ctx: Context) => Promise<void> = () =>
    Promise.reject(new Error(`not registered for ${entries.length} entries`));
  atriumEdit({
    registerCommand: (name, options) => {
      expect(name).toBe("atrium-edit");
      expect(options.description).toBe("Atrium's stopped-message edit, sent by Atrium's host");
      handler = options.handler;
    },
    appendEntry: (customType, data) => {
      const entry = { id: `c${entries.length}`, parentId: state.leaf, type: "custom", customType, data };
      entries.push(entry);
      state.leaf = entry.id;
    },
  });
  const ctx: Context = {
    sessionManager: {
      getEntries: () => entries,
      getLeafId: () => state.leaf,
      getEntry: (id) => entries.find((entry) => entry.id === id),
    },
    navigateTree: (id, options) => {
      navigations.push([id, options]);
      if (state.error) return Promise.reject(new Error("navigation failed"));
      if (state.cancelled) return Promise.resolve({ cancelled: true });
      const target = entries.find((entry) => entry.id === id);
      if (!state.noMove) state.leaf = target?.message?.role === "user" ? target.parentId : id;
      return Promise.resolve({ cancelled: false });
    },
  };
  return {
    state,
    entries,
    navigations,
    run: (params: Parameters<typeof editCommand>[0]) => handler(editCommand(params).split(" ")[1] ?? "", ctx),
    raw: (args: string) => handler(args, ctx),
  };
}

const REWIND = { action: "rewind", token: "op", entryId: "u", leafId: "a" } as const;
const RESTORE = { action: "restore", token: "op" } as const;
const FAILURE_ERRORS = { cancelled: "edit_cancelled", error: "navigation failed" };

describe("edit tree boundary", () => {
  it("appends a non-context anchor before navigating, then restores via that anchor and persists", async () => {
    expectTypeOf<ExtensionAPI>().toExtend<EditApi>();
    const s = stand();
    await s.run(REWIND);
    expect(s.state.leaf).toBe("p");
    expect(s.entries.at(-1)).toStrictEqual({
      id: "c3",
      parentId: "a",
      type: "custom",
      customType: "atrium-edit-anchor",
      data: { token: "op", entryId: "u", fromLeaf: "a" },
    });
    expect(s.navigations).toStrictEqual([["u", { summarize: false }]]);
    await s.run(RESTORE);
    expect(s.navigations).toStrictEqual([
      ["u", { summarize: false }],
      ["c3", { summarize: false }],
    ]);
    expect(s.entries.at(-1)).toStrictEqual({
      id: "c4",
      parentId: "c3",
      type: "custom",
      customType: "atrium-edit-restored",
      data: { token: "op" },
    });
    await expect(s.run(RESTORE)).rejects.toThrow("edit_conflict");
  });
  it("moves a user leaf and a root user to their parent despite pi's leaf no-op", async () => {
    const s = stand([{ id: "u", parentId: null, type: "message", message: { role: "user" } }]);
    await s.run({ ...REWIND, leafId: "u" });
    expect(s.state.leaf).toBeNull();
    await s.run(RESTORE);
    expect(s.entries.at(-1)?.parentId).toBe("c1");
  });
  it.each([
    { ...REWIND, leafId: "stale" },
    { ...REWIND, leafId: "u" },
    { ...REWIND, entryId: "a" },
    { ...REWIND, entryId: "missing" },
  ])("rejects stale leaves and non-user targets before writing: %j", async (params) => {
    const s = stand();
    await expect(s.run(params)).rejects.toThrow("edit_conflict");
    expect(s.entries).toHaveLength(3);
    expect(s.navigations).toStrictEqual([]);
  });
  it("rejects a user on another branch", async () => {
    const s = stand([
      { id: "u", parentId: null, type: "message", message: { role: "user" } },
      { id: "a", parentId: null, type: "message", message: { role: "assistant" } },
    ]);
    await expect(s.run(REWIND)).rejects.toThrow("edit_conflict");
    expect(s.entries).toHaveLength(2);
  });
  it.each(["cancelled", "error"] as const)(
    "leaves the anchor on the original branch when rewind is %s",
    async (failure) => {
      const s = stand();
      s.state[failure] = true;
      await expect(s.run(REWIND)).rejects.toThrow(FAILURE_ERRORS[failure]);
      expect(s.state.leaf).toBe("c3");
      expect(s.entries.at(-1)?.parentId).toBe("a");
    },
  );
  it("rejects unknown tokens, a newer operation and any new user or assistant on the current path", async () => {
    const s = stand();
    await s.run(REWIND);
    await expect(s.run({ ...RESTORE, token: "other" })).rejects.toThrow("edit_conflict");
    s.entries.push({ id: "new", parentId: "p", type: "message", message: { role: "user" } });
    s.state.leaf = "new";
    await expect(s.run(RESTORE)).rejects.toThrow("edit_conflict");
    s.entries.splice(-1, 1, { id: "new", parentId: "p", type: "message", message: { role: "assistant" } });
    await expect(s.run(RESTORE)).rejects.toThrow("edit_conflict");
    s.state.leaf = "p";
    s.entries.push({
      id: "other",
      parentId: "p",
      type: "custom",
      customType: "atrium-edit-anchor",
      data: { token: "other" },
    });
    await expect(s.run(RESTORE)).rejects.toThrow("edit_conflict");
    expect(s.navigations).toHaveLength(1);
  });
  it.each([
    { type: "custom_message", customType: "agent-notification" },
    { type: "message", message: { role: "toolResult" } },
    { type: "message", message: { role: "system" } },
  ])("refuses restoration over any newly delivered model-context entry: %j", async (message) => {
    const s = stand();
    await s.run(REWIND);
    s.entries.push({ id: "delivered", parentId: "p", ...message });
    s.state.leaf = "delivered";
    await expect(s.run(RESTORE)).rejects.toThrow("edit_conflict");
    expect(s.navigations).toStrictEqual([["u", { summarize: false }]]);
    expect(s.entries.at(-1)?.id).toBe("delivered");
    expect(s.state.leaf).toBe("delivered");
  });
  it("allows harmless metadata after rewind but refuses an unrelated current branch", async () => {
    const s = stand();
    await s.run(REWIND);
    s.entries.push({ id: "metadata", parentId: "p", type: "custom", customType: "harmless", data: { token: "op" } });
    s.entries.push({ id: "settings", parentId: "metadata", type: "thinking_level_change" });
    s.state.leaf = "settings";
    await s.run(RESTORE);
    expect(s.entries.at(-1)?.customType).toBe("atrium-edit-restored");

    const other = stand();
    await other.run(REWIND);
    other.entries.push({ id: "unrelated", parentId: null, type: "custom" });
    other.state.leaf = "unrelated";
    await expect(other.run(RESTORE)).rejects.toThrow("edit_conflict");
    expect(other.navigations).toHaveLength(1);
  });
  it("rejects an already restored operation even if another navigator returned to the old base", async () => {
    const s = stand();
    await s.run(REWIND);
    await s.run(RESTORE);
    s.state.leaf = "p";
    await expect(s.run(RESTORE)).rejects.toThrow("edit_conflict");
    expect(s.navigations).toHaveLength(2);
  });
  it("does not persist restoration if another hook moved its selected leaf", async () => {
    const s = stand();
    await s.run(REWIND);
    s.state.noMove = true;
    await expect(s.run(RESTORE)).rejects.toThrow("edit_conflict");
    expect(s.entries).toHaveLength(4);
  });
  it.each([
    {
      id: "c3",
      parentId: "other",
      type: "custom",
      customType: "atrium-edit-anchor",
      data: { token: "op", entryId: "u", fromLeaf: "a" },
    },
    { id: "c3", parentId: "a", type: "custom", customType: "atrium-edit-anchor", data: {} },
  ])("rejects malformed anchor data or a changed original branch: %j", async (anchor) => {
    const s = stand();
    await s.run(REWIND);
    s.entries.splice(-1, 1, anchor);
    await expect(s.run(RESTORE)).rejects.toThrow("edit_conflict");
    expect(s.navigations).toHaveLength(1);
  });
  it("rechecks the target role during restoration", async () => {
    const s = stand();
    await s.run(REWIND);
    s.entries.splice(1, 1, { id: "u", parentId: "p", type: "message", message: { role: "system" } });
    await expect(s.run(RESTORE)).rejects.toThrow("edit_conflict");
    expect(s.navigations).toHaveLength(1);
  });
  it("ignores unrelated restoration markers and message entries that reuse custom type names", async () => {
    const s = stand();
    await s.run(REWIND);
    s.entries.push({
      id: "older",
      parentId: "p",
      type: "custom",
      customType: "atrium-edit-restored",
      data: { token: "old-operation" },
    });
    s.entries.push({
      id: "invalid-marker",
      parentId: "p",
      type: "custom",
      customType: "atrium-edit-restored",
      data: {},
    });
    s.entries.push({ id: "message-anchor", parentId: "p", type: "custom_message", customType: "atrium-edit-anchor" });
    await s.run(RESTORE);
    expect(s.entries.at(-1)).toMatchObject({ customType: "atrium-edit-restored", data: { token: "op" } });
  });
  it("rejects a broken ancestor chain before writing an anchor", async () => {
    const s = stand([
      { id: "u", parentId: null, type: "message", message: { role: "user" } },
      { id: "a", parentId: "missing", type: "custom" },
    ]);
    await expect(s.run(REWIND)).rejects.toThrow("edit_conflict");
    expect(s.entries).toHaveLength(2);
    expect(s.navigations).toStrictEqual([]);
  });
  it("rejects absent anchors, corrupt references and ancestry cycles without navigation", async () => {
    const s = stand();
    await expect(s.run(RESTORE)).rejects.toThrow("edit_conflict");
    await s.run(REWIND);
    s.entries.splice(1, 1);
    await expect(s.run(RESTORE)).rejects.toThrow("edit_conflict");
    expect(s.navigations).toHaveLength(1);

    const cycle = stand([
      { id: "u", parentId: null, type: "message", message: { role: "user" } },
      { id: "a", parentId: "a", type: "custom" },
    ]);
    await expect(cycle.run(REWIND)).rejects.toThrow("edit_conflict");
    expect(cycle.entries).toHaveLength(2);
    expect(cycle.navigations).toStrictEqual([]);
  });
  it.each(["cancelled", "error"] as const)("does not mark restore persisted when navigation is %s", async (failure) => {
    const s = stand();
    await s.run(REWIND);
    s.state[failure] = true;
    await expect(s.run(RESTORE)).rejects.toThrow(FAILURE_ERRORS[failure]);
    expect(s.entries).toHaveLength(4);
    expect(s.state.leaf).toBe("p");
  });
  it.each([
    "",
    "!",
    "e30",
    "ew",
    "x".repeat(1025),
    Buffer.from('{"action":"restore","token":"op","text":"secret"}').toString("base64url"),
  ])("rejects malformed command arguments without writing: %s", async (args) => {
    const s = stand();
    await expect(s.raw(args)).rejects.toThrow("edit_invalid");
    expect(s.entries).toHaveLength(3);
  });
});
