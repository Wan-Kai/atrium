import { type Chat, COMMAND_TYPES, HostMessage, type SessionSummary, type Workspace } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { COMMAND_REACH, PUSHED_TO_PHONE, forPhone, phoneMayRun, pushedToPhone } from "./remote-policy";

/**
 * Every `type` a host message schema allows, through its unions.
 *
 * @remarks
 * Walks the zod unions of `HostMessage`, so a new kind of message fails the test until it is
 * classified for the phone.
 *
 * @sideEffects none
 * @param schema - A zod schema.
 * @returns The constant `type` values.
 */
function typesOf(schema: z.ZodType): string[] {
  const def: unknown = Reflect.get(schema, "def");
  const options: unknown = Reflect.get(Object(def), "options");
  if (Array.isArray(options)) return options.flatMap((option: z.ZodType) => typesOf(option));
  const shape: unknown = Reflect.get(Object(def), "shape");
  const type: unknown = Reflect.get(Object(shape), "type");
  const values: unknown = Reflect.get(Object(Reflect.get(Object(type), "def")), "values");
  return Array.isArray(values) ? values.map(String) : [];
}

describe("the phone's allowlist", () => {
  it("classifies every command there is, 39 for the phone and the rest for the Mac", () => {
    expect(Object.keys(COMMAND_REACH).toSorted()).toStrictEqual([...COMMAND_TYPES].toSorted());
    expect(Object.values(COMMAND_REACH).filter((reach) => reach === "phone")).toHaveLength(39);
  });

  it("refuses a new child conversation, and the remote commands, to a phone", () => {
    const fields = { requestId: "r1", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" };
    const child = { parentSessionId: "s1", name: "c", place: "same" } as const;
    expect(phoneMayRun({ type: "create_session", ...fields, containerId: "wks_0123456789abcdef" })).toBe(true);
    expect(phoneMayRun({ type: "create_session", ...fields, containerId: "wks_0123456789abcdef", child })).toBe(false);
    expect(phoneMayRun({ type: "ping", ...fields })).toBe(true);
    expect(phoneMayRun({ type: "get_remote", ...fields })).toBe(false);
    expect(phoneMayRun({ type: "set_preferences", ...fields })).toBe(false);
    expect(
      phoneMayRun({ type: "translate_reply", ...fields, sessionId: "s1", turnId: "t1", translationId: "tr1" }),
    ).toBe(false);
    expect(phoneMayRun({ type: "cancel_translation", ...fields, translationId: "tr1" })).toBe(false);
    expect(COMMAND_REACH.translate_reply).toBe("local_only");
    expect(COMMAND_REACH.cancel_translation).toBe("local_only");
  });
});

describe("what goes to the phone", () => {
  it("classifies every kind of host message", () => {
    expect(Object.keys(PUSHED_TO_PHONE).toSorted()).toStrictEqual([...new Set(typesOf(HostMessage))].toSorted());
  });

  it("holds back sign-in, install, pi updates, credentials and the remote state", () => {
    expect(
      Object.entries(PUSHED_TO_PHONE)
        .filter(([, pushed]) => !pushed)
        .map(([type]) => type),
    ).toStrictEqual([
      "login_updated",
      "install_updated",
      "install_output",
      "pi_latest",
      "credentials_changed",
      "remote_updated",
    ]);
    expect(pushedToPhone({ type: "credentials_changed" })).toBe(false);
    expect(pushedToPhone({ type: "plans_updated", plans: [] })).toBe(true);
  });
});

/**
 * A session summary for the phone's list.
 *
 * @remarks
 * Persisted with a file, so the test sees the path go.
 *
 * @sideEffects none
 * @param id - Its id.
 * @param archived - Whether it is archived.
 * @returns The summary.
 */
function session(id: string, archived: boolean): SessionSummary {
  return {
    sessionId: id,
    containerId: "cht_1",
    name: null,
    prompt: id,
    file: `/pi/sessions/${id}.jsonl`,
    state: "persisted",
    updatedAt: 1,
    archived,
    running: false,
    attention: null,
    asking: null,
    question: null,
    handedOff: false,
    model: null,
    parent: null,
    agent: null,
    heldDeliveries: 0,
  };
}

/**
 * A workspace, archived or not.
 *
 * @remarks
 * Only `archivedAt` matters here.
 *
 * @sideEffects none
 * @param id - Its id.
 * @param archivedAt - When it was archived, or `null`.
 * @returns The workspace.
 */
function workspace(id: string, archivedAt: number | null): Workspace {
  return {
    id,
    projectId: "prj_0000000000000001",
    kind: "worktree",
    dir: `/code/${id}`,
    alias: null,
    branch: id,
    head: null,
    external: false,
    createdAt: null,
    merge: null,
    archivedAt,
  };
}

/**
 * A chat, archived or not.
 *
 * @remarks
 * Only `archivedAt` matters here.
 *
 * @sideEffects none
 * @param id - Its id.
 * @param archivedAt - When it was archived, or `null`.
 * @returns The chat.
 */
function chat(id: string, archivedAt: number | null): Chat {
  return { id, dir: `/chats/${id}`, alias: null, firstSessionId: null, archivedAt };
}

describe("the list as the phone gets it", () => {
  const live = { ...session("s1", false), file: null };

  it("leaves archived sessions, workspaces and chats out of the snapshot, and every session's file", () => {
    const snapshot = HostMessage.parse({
      type: "index_snapshot",
      generation: "g1",
      seq: 3,
      reason: "no_cursor",
      projects: [],
      workspaces: [workspace("wks_0000000000000001", null), workspace("wks_0000000000000002", 5)],
      chats: [chat("cht_1", null), chat("cht_2", 5)],
      sessions: [session("s1", false), session("s2", true)],
      layout: { container: null, tabs: {} },
      preferences: {
        setupDone: true,
        appearance: "system",
        lastModel: null,
        thinkingByModel: {},
        lastFast: false,
        statusBar: {},
        titleModel: null,
        proxy: null,
        inbox: true,
        translationLanguage: "简体中文",
      },
      resets: [],
    });

    expect(forPhone(snapshot)).toStrictEqual({
      ...snapshot,
      workspaces: [workspace("wks_0000000000000001", null)],
      chats: [chat("cht_1", null)],
      sessions: [live],
    });
  });

  it("turns changes to archived items into removals, keeps removals, and drops every session's file", () => {
    const changes = HostMessage.parse({
      type: "index_changes",
      generation: "g1",
      seq: 4,
      projects: { upsert: [], remove: [] },
      workspaces: {
        upsert: [workspace("wks_0000000000000001", null), workspace("wks_0000000000000002", 5)],
        remove: ["wks_0000000000000003"],
      },
      chats: { upsert: [chat("cht_2", 5)], remove: [] },
      sessions: { upsert: [session("s1", false), session("s2", true)], remove: ["s3"] },
      layout: null,
      preferences: null,
    });

    expect(forPhone(changes)).toStrictEqual({
      ...changes,
      workspaces: {
        upsert: [workspace("wks_0000000000000001", null)],
        remove: ["wks_0000000000000003", "wks_0000000000000002"],
      },
      chats: { upsert: [], remove: ["cht_2"] },
      sessions: { upsert: [live], remove: ["s3", "s2"] },
    });
  });

  it("passes every other message as it is", () => {
    const message = HostMessage.parse({ type: "response", requestId: "r1", ok: true, result: {} });

    expect(forPhone(message)).toBe(message);
  });
});
