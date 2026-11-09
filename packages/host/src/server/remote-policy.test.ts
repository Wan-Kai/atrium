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

describe("tasks on a phone (SPEC-0006)", () => {
  it("may list and open tasks and nothing else about them", () => {
    const fields = { requestId: "r1", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" };
    const task = { taskId: "tsk_a" };
    expect(phoneMayRun({ type: "list_tasks", ...fields })).toBe(true);
    expect(phoneMayRun({ type: "open_task", ...fields, ...task })).toBe(true);
    expect(phoneMayRun({ type: "answer_human", ...fields, ...task, node: "N1", answer: { kind: "pass" } })).toBe(false);
    expect(phoneMayRun({ type: "rerun_node", ...fields, ...task, node: "N1" })).toBe(false);
    expect(phoneMayRun({ type: "continue_node", ...fields, ...task, node: "N1" })).toBe(false);
    expect(phoneMayRun({ type: "pause_task", ...fields, ...task })).toBe(false);
    expect(phoneMayRun({ type: "resume_task", ...fields, ...task })).toBe(false);
    expect(phoneMayRun({ type: "cancel_task", ...fields, ...task })).toBe(false);
    expect(phoneMayRun({ type: "answer_archive", ...fields, ...task, answer: "archive" })).toBe(false);
    // The card for a task's gate is answered on the Mac (ADR-0017, decision 5).
    expect(
      phoneMayRun({
        type: "answer_review",
        ...fields,
        sessionId: "s1",
        reviewId: "tsk_a:human:H:1",
        verdict: { action: "pass" },
      }),
    ).toBe(false);
    expect(COMMAND_REACH.answer_review).toBe("local_only");
    expect(phoneMayRun({ type: "open_task_session", ...fields, ...task, sessionId: "s2" })).toBe(false);
    expect(COMMAND_REACH.open_task_session).toBe("local_only");
  });

  it("may talk in a task's or a node's conversation, and answer its question, but not decide anything (T8 review decision 4)", () => {
    const fields = { requestId: "r1", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" };
    const session = { sessionId: "ses_task" };
    expect(phoneMayRun({ type: "prompt", ...fields, ...session, text: "hi" })).toBe(true);
    expect(phoneMayRun({ type: "steer", ...fields, ...session, text: "hi" })).toBe(true);
    expect(phoneMayRun({ type: "stop", ...fields, ...session })).toBe(true);
    expect(
      phoneMayRun({ type: "answer_question", ...fields, ...session, questionId: "q1", answer: { skipped: true } }),
    ).toBe(true);
    // Everything that carries out a task's decision or opens its sessions stays on the Mac.
    for (const type of [
      "create_task",
      "start_task",
      "abandon_task",
      "approve_graph",
      "reject_graph",
      "answer_human",
      "rerun_node",
      "continue_node",
      "pause_task",
      "resume_task",
      "cancel_task",
      "answer_archive",
      "open_task_session",
      "answer_review",
    ] as const) {
      expect(COMMAND_REACH[type]).toBe("local_only");
    }
  });

  it("keeps the schedule rules on the Mac: every command and the push (T10)", () => {
    for (const type of [
      "list_schedules",
      "pause_schedule",
      "resume_schedule",
      "run_schedule_now",
      "delete_schedule",
      "edit_schedule",
    ] as const) {
      expect(COMMAND_REACH[type]).toBe("local_only");
    }
    expect(pushedToPhone({ type: "schedules_updated", seq: 1, schedules: [] })).toBe(false);
  });

  it("pushes the task list and an open task's state to a phone that asked for them", () => {
    expect(pushedToPhone({ type: "tasks_updated", seq: 1, tasks: [] })).toBe(true);
    expect(PUSHED_TO_PHONE.task_updated).toBe(true);
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
      "schedules_updated",
    ]);
    expect(pushedToPhone({ type: "credentials_changed" })).toBe(false);
    expect(pushedToPhone({ type: "plans_updated", plans: [] })).toBe(true);
  });
});
