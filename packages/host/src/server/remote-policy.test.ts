import { COMMAND_TYPES, HostMessage, type IndexChangesEvent, type IndexSnapshotEvent } from "@atrium/protocol";
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

/** A session summary in a container; only the fields the filter reads matter here. */
const inContainer = (sessionId: string, containerId: string) =>
  ({ sessionId, containerId }) as unknown as IndexSnapshotEvent["sessions"][number];

describe("what of the list goes to a phone (SPEC-0008, option A)", () => {
  it("keeps every learning direction, its sessions, its tabs and the learning directory out of a snapshot", () => {
    const snapshot = {
      type: "index_snapshot",
      directions: [{ id: "lrn_go", dir: "/Users/kim/Atrium/Learning/go" }],
      sessions: [inContainer("s1", "wks_0123456789abcdef"), inContainer("talk", "lrn_go")],
      layout: {
        container: "lrn_go",
        tabs: { lrn_go: { open: ["talk"], active: "talk" }, wks_0123456789abcdef: { open: ["s1"], active: "s1" } },
      },
      learningDir: "/Users/kim/Atrium/Learning",
    } as unknown as IndexSnapshotEvent;

    const sent = forPhone(snapshot);

    expect(sent).toMatchObject({
      directions: [],
      sessions: [{ sessionId: "s1" }],
      layout: { container: null, tabs: { wks_0123456789abcdef: { open: ["s1"], active: "s1" } } },
      learningDir: "~",
    });
    expect(JSON.stringify(sent)).not.toMatch(/lrn_|Learning|talk/u);
  });

  it("keeps them out of changes too, and leaves other messages as they are", () => {
    const changes = {
      type: "index_changes",
      directions: { upsert: [{ id: "lrn_go", dir: "/Users/kim/Atrium/Learning/go" }], remove: ["lrn_old"] },
      sessions: { upsert: [inContainer("s1", "wks_0123456789abcdef"), inContainer("talk", "lrn_go")], remove: [] },
      layout: { container: "lrn_go", tabs: { lrn_go: { open: ["talk"], active: "talk" } } },
    } as unknown as IndexChangesEvent;
    const response = { type: "response", requestId: "r1", ok: true, result: {} } as const;

    const sent = forPhone(changes);

    expect(sent).toMatchObject({
      directions: { upsert: [], remove: [] },
      sessions: { upsert: [{ sessionId: "s1" }], remove: [] },
      layout: { container: null, tabs: {} },
    });
    expect(JSON.stringify(sent)).not.toMatch(/lrn_|Learning|talk/u);
    expect(forPhone({ ...changes, layout: null })).toMatchObject({ layout: null });
    expect(forPhone(response)).toBe(response);
  });
});
