import { type FauxContext, present } from "@atrium/testkit";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runScenario, startOtherPi } from "../../test/contract";
import { AGENT_MESSAGE, encodeArgument } from "../agent/agent";
import { readRequest } from "../agent/channel";
import type { PiEvent } from "../process/pi-process";
import {
  AGENTS_RULE,
  ASK_PROMPT,
  OUTSIDE_RULE,
  STUDY_FLAG,
  STUDY_TOOLS,
  VISUAL_RULES,
  WRITE_VISUAL_FIRST,
  askArgument,
  kickoffText,
  startCommand,
  studyArgument,
} from "../study/study";
import { VISUALS_FLAG, visualsArgument, visualsPrompt } from "../visuals/visuals";

/** Atrium's extension, as the host has pi load it (ADR-0008, ADR-0013). */
const ATRIUM_EXTENSION = fileURLToPath(new URL("../extension/atrium.ts", import.meta.url));

/**
 * The study tools a request offered the model, sorted.
 *
 * @remarks
 * pi's and the other parts' tools are left out.
 *
 * @sideEffects none
 * @param request - The request; none offered nothing.
 * @returns The tools.
 */
function studyTools(request: FauxContext | undefined): string[] {
  return [...(request?.tools ?? [])].filter((tool) => (STUDY_TOOLS as readonly string[]).includes(tool)).toSorted();
}

/**
 * Whether an event is a call the extension made on its status line.
 *
 * @remarks
 * `atrium-agent:<request id>` with the envelope as its text (ADR-0013, point 1).
 *
 * @sideEffects none
 * @param id - The request id.
 * @returns The predicate.
 */
function asked(id: string): (event: PiEvent) => boolean {
  return (event) =>
    event.type === "extension_ui_request" &&
    event.method === "setStatus" &&
    event.statusKey === `atrium-agent:${id}` &&
    event.statusText !== undefined;
}

/**
 * Whether an event ends a custom message.
 *
 * @remarks
 * The kickoff is one (SPEC-0008, "ML2 定的细节").
 *
 * @sideEffects none
 * @param event - The event.
 * @returns Whether it does.
 */
function customEnd(event: PiEvent): boolean {
  return event.type === "message_end" && event.message.role === "custom";
}

/**
 * The text of the last tool result a request carried.
 *
 * @remarks
 * What the model was told.
 *
 * @sideEffects none
 * @param request - The request; none has no result.
 * @returns The text.
 */
function lastResult(request: FauxContext | undefined): string {
  const result = (request?.messages ?? []).findLast(
    (message) => Reflect.get(message as object, "role") === "toolResult",
  );
  const content: unknown = result === undefined ? [] : Reflect.get(Object(result), "content");
  return Array.isArray(content)
    ? content.map((block: unknown) => String(Reflect.get(block as object, "text") ?? "")).join("")
    : "";
}

/** What a direction's `AGENTS.md` says, to find in what the model is told. */
const METHOD = "Teach one idea at a time. study-agents-marker";

/** What an untrusted directory's `.pi/SYSTEM.md` says, which pi must not use. */
const UNTRUSTED = "untrusted-system-marker";

/**
 * Everything the model was told in a request's system message, as one text.
 *
 * @remarks
 * pi 1.x sends its system prompt as a `system` message with `sections` (the faux extension's
 * `instructionsOf`); stringified, the text of every part is in it.
 *
 * @sideEffects none
 * @param messages - The request's messages.
 * @returns The system message as JSON, or empty without one.
 */
function systemText(messages: readonly unknown[]): string {
  const system = messages.find((message) => Reflect.get(Object(message), "role") === "system");
  return system === undefined ? "" : JSON.stringify(system);
}

/**
 * Every system message a request carried, as JSON each.
 *
 * @remarks
 * A session forked from another carries the other's system messages in its history too; the one
 * the run itself gives is the last (pi-internals §2, "系统消息").
 *
 * @sideEffects none
 * @param messages - The request's messages.
 * @returns The system messages.
 */
function systemTexts(messages: readonly unknown[]): string[] {
  return messages
    .filter((message) => Reflect.get(Object(message), "role") === "system")
    .map((message) => JSON.stringify(message));
}

/**
 * The texts of a request's user and assistant messages, in order.
 *
 * @remarks
 * What history the model was given, system messages and tool results left out.
 *
 * @sideEffects none
 * @param messages - The request's messages.
 * @returns `role: text` for each.
 */
function said(messages: readonly unknown[]): string[] {
  return messages.flatMap((message): string[] => {
    const role = String(Reflect.get(Object(message), "role"));
    if (role !== "user" && role !== "assistant") return [];
    const content: unknown = Reflect.get(Object(message), "content");
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((block: unknown) => String(Reflect.get(Object(block), "text") ?? "")).join("")
          : "";
    return [`${role}: ${text}`];
  });
}

describe("pi contract: study mode (SPEC-0008)", () => {
  it("study-agents: reads AGENTS.md in a direction's directory without trusting it", async () => {
    await runScenario(
      {
        scenario: "study-agents",
        script: { replies: [{ blocks: [{ type: "text", text: "ok" }] }] },
        // A direction's directory as the host makes it, and what only trust would let in.
        files: {
          "AGENTS.md": `# Learning direction\n\n${METHOD}\n`,
          ".atrium-study.json": '{"version":1,"name":"Go"}\n',
          ".pi/SYSTEM.md": `${UNTRUSTED}\n`,
        },
      },
      async ({ pi, until, contexts, cwd }) => {
        await pi.request({ type: "prompt", message: "我想学 Go" });
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();
        const told = systemText(present(request, "the request").messages);

        expect(told).toContain(METHOD);
        expect(told).toContain(`<project_instructions path=\\"${cwd}/AGENTS.md\\">`);
        expect(told).not.toContain(UNTRUSTED);
      },
    );
  });

  it("study-tools-none: a session with no use it can read, as a workspace's or a chat's, has no study tool and no study prompt", async () => {
    await runScenario(
      {
        scenario: "study-tools-none",
        extensions: [ATRIUM_EXTENSION],
        // No use is read from a flag that names none.
        args: [`--${STUDY_FLAG}=${encodeArgument({ v: 1, kind: "nap" })}`],
        script: { replies: [{ blocks: [{ type: "text", text: "ok" }] }] },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "hi" });
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();

        expect(studyTools(request)).toStrictEqual([]);
        expect(systemText(present(request, "the request").messages)).not.toContain("atrium_study");
      },
    );
  });

  it("study-ask: an asking session of a direction has no study tool, only the rule of staying in its folder (ML4 review)", async () => {
    await runScenario(
      {
        scenario: "study-ask",
        extensions: [ATRIUM_EXTENSION],
        args: [
          `--${STUDY_FLAG}=${askArgument()}`,
          `--${VISUALS_FLAG}=${visualsArgument("/L/rust/visuals", "visuals")}`,
        ],
        script: { replies: [{ blocks: [{ type: "text", text: "ok" }] }] },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "借用是什么" });
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();
        const told = systemText(present(request, "the request").messages);

        expect(studyTools(request)).toStrictEqual([]);
        expect(told).toContain(JSON.stringify(ASK_PROMPT).slice(1, -1));
        expect(told).not.toContain("This session's use:");
        expect(told).toContain(JSON.stringify(visualsPrompt("/L/rust/visuals", "visuals")).slice(1, -1));
      },
    );
  });

  it("study-tools-discuss: a discussion has its three tools, registered at session start, and its prompt", async () => {
    await runScenario(
      {
        scenario: "study-tools-discuss",
        extensions: [ATRIUM_EXTENSION],
        args: [`--${STUDY_FLAG}=${studyArgument({ kind: "discuss" })}`],
        script: { replies: [{ blocks: [{ type: "text", text: "ok" }] }] },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "我想学 Go" });
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();

        expect(studyTools(request)).toStrictEqual(["study_set_ladder", "study_set_name", "study_set_profile"]);
        expect(systemText(present(request, "the request").messages)).toContain("This session's use: discuss.");
        expect(systemText(present(request, "the request").messages)).toContain(AGENTS_RULE);
      },
    );
  });

  it("study-call: a study tool asks the host on the agent channel and the model reads the answer", async () => {
    await runScenario(
      {
        scenario: "study-call",
        extensions: [ATRIUM_EXTENSION],
        args: [`--${STUDY_FLAG}=${studyArgument({ kind: "lesson", level: "l1", step: "s1" })}`],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "study_report", arguments: {} }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        const call = await until(asked("call-1"));
        const read = readRequest(String(Reflect.get(call, "statusText")));
        await pi.request({
          type: "prompt",
          message: `/atrium-agent reply ${encodeArgument({ v: 1, id: "call-1", ok: true, result: {} })}`,
        });
        await until((event) => event.type === "agent_settled");
        const [first, second] = await contexts();

        expect(read).toStrictEqual({ request: { kind: "call", id: "call-1", op: "study_report", args: {} } });
        expect(studyTools(first)).toStrictEqual(["study_report"]);
        expect(lastResult(second)).toBe("Reported.");
      },
    );
  });

  it("study-too-long: a text over its limit reaches the extension, which answers agent_text_too_long without asking the host", async () => {
    await runScenario(
      {
        scenario: "study-too-long",
        extensions: [ATRIUM_EXTENSION],
        args: [`--${STUDY_FLAG}=${studyArgument({ kind: "discuss" })}`],
        script: {
          replies: [
            {
              blocks: [
                { type: "toolCall", id: "call-1", name: "study_set_name", arguments: { name: "x".repeat(300) } },
              ],
            },
            { blocks: [{ type: "text", text: "shorter then" }] },
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "给方向起个名字" });
        // pi does not refuse it by its schema; the extension answers without a call to the host.
        await until((event) => event.type === "agent_settled");
        const [, second] = await contexts();

        expect(lastResult(second)).toBe("Error agent_text_too_long: name is too long: at most 256 characters.");
      },
    );
  });

  it("study-kickoff: /atrium-study start opens a turn with the use, which the model reads as Atrium's, not the learner's", async () => {
    const launch = { kind: "lesson", level: "l1", step: "s1" } as const;
    await runScenario(
      {
        scenario: "study-kickoff",
        session: true,
        extensions: [ATRIUM_EXTENSION],
        args: [`--${STUDY_FLAG}=${studyArgument(launch)}`],
        script: { replies: [{ blocks: [{ type: "text", text: "第一课" }] }] },
      },
      async ({ pi, until, contexts }) => {
        const handled = await pi.request({ type: "prompt", message: startCommand() });
        const message = await until(customEnd);
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();

        expect(handled).toStrictEqual({ disposition: "handled" });
        expect(message).toMatchObject({
          message: {
            role: "custom",
            customType: AGENT_MESSAGE,
            details: { v: 1, kind: "study", deliveries: [], study: launch },
          },
        });
        expect(JSON.stringify(present(request, "the request").messages)).toContain(
          JSON.stringify(kickoffText(launch)).slice(1, -1),
        );
      },
    );
  });

  it("study-quiz-fork: a quiz forked from its lesson's file has the quiz's prompt and tools, the lesson's history, and opens a quiz turn (ML3)", async () => {
    const lesson = { kind: "lesson", level: "l1", step: "s1" } as const;
    const quiz = { kind: "quiz", level: "l1", step: "s1" } as const;
    await runScenario(
      {
        scenario: "study-quiz-fork",
        session: true,
        extensions: [ATRIUM_EXTENSION],
        args: [`--${STUDY_FLAG}=${studyArgument(lesson)}`],
        script: { replies: [{ blocks: [{ type: "text", text: "lesson-marker: goroutines" }] }] },
      },
      async ({ pi, until, cwd }) => {
        await pi.request({ type: "prompt", message: startCommand() });
        await until((event) => event.type === "agent_settled");
        const lessonFile = present((await pi.request({ type: "get_state" })).sessionFile, "the lesson's file");

        // As the host starts the quiz: in the direction's directory, from the lesson's file, the quiz's use.
        const id = randomUUID();
        const child = await startOtherPi({
          dir: join(cwd, "quiz"),
          script: { replies: [{ blocks: [{ type: "text", text: "第 1 题" }] }] },
          args: [
            "--session-dir",
            join(cwd, "quiz-sessions"),
            "--fork",
            lessonFile,
            "--session-id",
            id,
            `--${STUDY_FLAG}=${studyArgument(quiz)}`,
          ],
          extensions: [ATRIUM_EXTENSION],
        });
        try {
          const handled = await child.pi.request({ type: "prompt", message: startCommand() });
          const message = await child.until(customEnd);
          await child.until((event) => event.type === "agent_settled");
          const [request] = await child.contexts();
          const messages = present(request, "the quiz's request").messages;
          const systems = systemTexts(messages);

          expect(handled).toStrictEqual({ disposition: "handled" });
          expect(message).toMatchObject({
            message: { customType: AGENT_MESSAGE, details: { v: 1, kind: "study", deliveries: [], study: quiz } },
          });
          // The quiz's tools only; the lesson's study_report shape is not carried over.
          expect(studyTools(request)).toStrictEqual(["study_add_gap", "study_report"]);
          expect(systems.at(-1)).toContain(
            'This session\'s use: quiz (level=\\\"l1\\\" step=\\\"s1\\\" in .atrium-study.json).',
          );
          expect(systems.at(-1)).not.toContain("This session's use: lesson");
          // pi keeps the lesson's system message in the copied history; the quiz's comes after it.
          expect(systems).toHaveLength(2);
          expect(systems[0]).toContain("This session's use: lesson");
          // The lesson's turn, then the quiz's kickoff, which points at it.
          const history = said(messages);
          expect(history.some((line) => line.includes("lesson-marker: goroutines"))).toBe(true);
          expect(history.at(-1)).toContain("The lesson's conversation is above");
          expect(history.at(-1)).toContain('<atrium-study use="quiz" level="l1" step="s1">');
        } finally {
          await child.pi.stop();
        }
      },
    );
  });

  it("study-quiz-none: a quiz with no lesson to come from is told to quiz from the notes and the progress (ML3)", async () => {
    const launch = { kind: "quiz", level: "l1", step: "s1", context: "none" } as const;
    await runScenario(
      {
        scenario: "study-quiz-none",
        session: true,
        extensions: [ATRIUM_EXTENSION],
        args: [`--${STUDY_FLAG}=${studyArgument(launch)}`],
        script: { replies: [{ blocks: [{ type: "text", text: "第 1 题" }] }] },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: startCommand() });
        const message = await until(customEnd);
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();

        // The record the transcript reads has no `context`: it is the session's use only.
        expect(message).toMatchObject({
          message: { details: { study: { kind: "quiz", level: "l1", step: "s1" } } },
        });
        expect(
          Reflect.get(Reflect.get(Object(Reflect.get(message, "message")), "details") as object, "study"),
        ).not.toHaveProperty("context");
        expect(studyTools(request)).toStrictEqual(["study_add_gap", "study_report"]);
        expect(JSON.stringify(present(request, "the request").messages)).toContain(
          JSON.stringify(kickoffText(launch)).slice(1, -1),
        );
        expect(kickoffText(launch)).toContain("There is no conversation of the lesson in this session");
      },
    );
  });

  it("study-tools-plan: a plan session has only study_set_steps and the plan's prompt (ML3)", async () => {
    await runScenario(
      {
        scenario: "study-tools-plan",
        session: true,
        extensions: [ATRIUM_EXTENSION],
        args: [`--${STUDY_FLAG}=${studyArgument({ kind: "plan", level: "l2" })}`],
        script: { replies: [{ blocks: [{ type: "text", text: "准备这样排，确认吗？" }] }] },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: startCommand() });
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();
        const told = systemText(present(request, "the request").messages);

        expect(studyTools(request)).toStrictEqual(["study_set_steps"]);
        expect(told).toContain('This session\'s use: plan (level=\\\"l2\\\" in .atrium-study.json).');
        expect(told).toContain("Do not say the lessons are set or saved before you have called study_set_steps.");
      },
    );
  });

  it("study-lesson-visuals: a lesson in a direction is told its numbers, the two rules of visuals, to stay in its folder, and to write visuals by their place (ML4)", async () => {
    const launch = { kind: "lesson", level: "l2", step: "s9" } as const;
    const progress = {
      version: 1,
      name: "Rust",
      ladder: [{ id: "l1" }, { id: "l2" }],
      steps: { l2: [{ id: "s1" }, { id: "s2" }, { id: "s9" }] },
    };
    await runScenario(
      {
        scenario: "study-lesson-visuals",
        session: true,
        extensions: [ATRIUM_EXTENSION],
        args: [
          `--${STUDY_FLAG}=${studyArgument(launch)}`,
          `--${VISUALS_FLAG}=${visualsArgument("/L/rust/visuals", "visuals")}`,
        ],
        files: { ".atrium-study.json": `${JSON.stringify(progress)}\n` },
        script: { replies: [{ blocks: [{ type: "text", text: "第三课" }] }] },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: startCommand() });
        await until(customEnd);
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();
        const sent = JSON.stringify(present(request, "the request").messages);
        const told = systemText(present(request, "the request").messages);

        expect(sent).toContain(JSON.stringify(kickoffText(launch, { level: 2, step: 3 })).slice(1, -1));
        expect(sent).toContain("visuals/2-03-<short-name>.html");
        for (const rule of [OUTSIDE_RULE, ...VISUAL_RULES, WRITE_VISUAL_FIRST]) {
          expect(told).toContain(JSON.stringify(rule).slice(1, -1));
        }
        expect(told).toContain(JSON.stringify(visualsPrompt("/L/rust/visuals", "visuals")).slice(1, -1));
        expect(told).not.toContain("/L/rust/visuals/<name>.html");
      },
    );
  });

  it("study-quiz-visuals: a quiz makes no visual, and is told only that, nothing of visuals besides (ML4)", async () => {
    await runScenario(
      {
        scenario: "study-quiz-visuals",
        extensions: [ATRIUM_EXTENSION],
        args: [
          `--${STUDY_FLAG}=${studyArgument({ kind: "quiz", level: "l1", step: "s1", context: "none" })}`,
          `--${VISUALS_FLAG}=${visualsArgument("/L/rust/visuals", "visuals")}`,
        ],
        script: { replies: [{ blocks: [{ type: "text", text: "ok" }] }] },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "测我" });
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();
        const told = systemText(present(request, "the request").messages);

        expect(told).toContain("Make no interactive visual in this session: ask with question cards only.");
        expect(told).toContain(JSON.stringify(OUTSIDE_RULE).slice(1, -1));
        for (const rule of [...VISUAL_RULES, WRITE_VISUAL_FIRST])
          expect(told).not.toContain(JSON.stringify(rule).slice(1, -1));
        expect(told).not.toContain("atrium_visuals");
        expect(told).not.toContain("visuals/<name>.html");
      },
    );
  });
});
