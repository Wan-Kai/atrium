import { COMMAND_TYPES, HostMessage } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { COMMAND_REACH, PUSHED_TO_PHONE, phoneMayRun, pushedToPhone } from "./remote-policy";

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
