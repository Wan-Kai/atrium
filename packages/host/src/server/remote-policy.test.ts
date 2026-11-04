import {
  type Chat,
  COMMAND_TYPES,
  HostMessage,
  IDLE_CONTROL,
  type SessionSummary,
  type Step,
  type Turn,
  UNKNOWN_METRICS,
  type Workspace,
} from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  COMMAND_REACH,
  PHONE_STEP_TEXT_LIMIT,
  PUSHED_TO_PHONE,
  forPhone,
  phoneMayRun,
  pushedToPhone,
} from "./remote-policy";

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
  it("classifies every command there is, 41 for the phone and the rest for the Mac", () => {
    expect(Object.keys(COMMAND_REACH).toSorted()).toStrictEqual([...COMMAND_TYPES].toSorted());
    expect(Object.values(COMMAND_REACH).filter((reach) => reach === "phone")).toHaveLength(41);
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
  return { id, dir: `/chats/${id}`, alias: null, firstSessionId: null, archivedAt, pinnedAt: null };
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

/** A command's output four times as long as a phone's preview. */
const LONG = `${"a".repeat(10)}${"m".repeat(PHONE_STEP_TEXT_LIMIT * 4)}${"z".repeat(10)}`;

/**
 * A finished tool step with an output.
 *
 * @remarks
 * `bash`, so a preview keeps the end.
 *
 * @sideEffects none
 * @param output - What it printed.
 * @param partial - Whether it is already a preview.
 * @returns The step.
 */
function toolStep(output: string, partial = false): Step {
  return {
    kind: "tool",
    id: "1",
    callId: "c1",
    tool: "bash",
    args: { command: "ls" },
    status: "done",
    output,
    details: { tool: "bash", command: "ls" },
    partial,
  };
}

/**
 * A finished turn with a reply and a long command output.
 *
 * @remarks
 * The reply is long too: only tool steps are cut.
 *
 * @sideEffects none
 * @param output - The command's output.
 * @param partial - Whether that output is already a preview.
 * @returns The turn.
 */
function turnWith(output: string, partial = false): Turn {
  return {
    kind: "turn",
    id: "t1",
    source: null,
    user: { text: "q", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 1 },
    steps: [{ kind: "text", id: "0", text: LONG }, toolStep(output, partial)],
    outcome: "done",
    error: null,
    startedAt: 1,
    durationMs: 1,
    usage: null,
    changes: [],
  };
}

/**
 * A `step_added` event for a command step with an output.
 *
 * @remarks
 * Turn `t1` of `s1`.
 *
 * @sideEffects none
 * @param output - What it printed.
 * @returns The event, unparsed.
 */
function stepEvent(output: string) {
  return { type: "step_added", sessionId: "s1", epoch: 1, seq: 1, traceId: null, turnId: "t1", step: toolStep(output) };
}

describe("conversations as the phone gets them", () => {
  const preview = LONG.slice(-PHONE_STEP_TEXT_LIMIT);

  it("sends tool steps of snapshots and step events as short previews, marked partial", () => {
    const snapshot = HostMessage.parse({
      type: "session_snapshot",
      sessionId: "s1",
      epoch: 1,
      seq: 0,
      traceId: null,
      stream: "st",
      items: [turnWith(LONG)],
      hasOlder: false,
      run: null,
      exited: false,
      control: IDLE_CONTROL,
      model: null,
      fast: false,
      metrics: UNKNOWN_METRICS,
    });
    const added = HostMessage.parse({
      type: "step_added",
      sessionId: "s1",
      epoch: 1,
      seq: 1,
      traceId: null,
      turnId: "t1",
      step: toolStep(LONG),
    });
    const updated = HostMessage.parse({ ...added, type: "step_updated", seq: 2 });

    expect(forPhone(snapshot)).toStrictEqual({ ...snapshot, items: [turnWith(preview, true)] });
    expect(forPhone(added)).toStrictEqual({ ...added, step: toolStep(preview, true) });
    expect(forPhone(updated)).toStrictEqual({ ...updated, step: toolStep(preview, true) });
  });

  it("cuts to 512 bytes, as the phone shows one line until a step is opened", () => {
    expect(PHONE_STEP_TEXT_LIMIT).toBe(512);
    expect(forPhone(HostMessage.parse(stepEvent(LONG)))).toMatchObject({ step: { output: LONG.slice(-512) } });
  });
});
