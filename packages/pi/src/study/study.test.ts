import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, expectTypeOf, it } from "vitest";
import { AGENT_MESSAGE, encodeArgument } from "../agent/agent";
import type { AgentErrorCode, AgentReply } from "../agent/channel";
import type { HostChannel } from "../agent/extension";
import atriumStudy, { type StudyApi } from "./extension";
import {
  STUDY_COMMAND,
  STUDY_FLAG,
  STUDY_SECTION,
  STUDY_TOOLS,
  TOOLS_BY_USE,
  kickoffText,
  readStart,
  readStudyArgument,
  startCommand,
  studyArgument,
  AGENTS_RULE,
  studyPrompt,
  studyTooLong,
} from "./study";

/** What the stand-in host answers, without the request id. */
type Answer =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: AgentErrorCode; readonly params?: Readonly<Record<string, unknown>> };

/** A tool as the stand-in for pi holds it. */
type Registered = Parameters<StudyApi["registerTool"]>[0];

/** What a stand-in pi recorded of the extension. */
interface Loaded {
  readonly tools: Registered[];
  readonly hooks: Map<string, (event: never) => void>;
  readonly sent: { message: unknown; options: unknown }[];
  readonly calls: { op: string; args: unknown; id: string }[];
  command(args: string, idle?: boolean): Promise<void>;
  start(): void;
  sections(): Record<string, string>;
}

/**
 * Loads the study part into a stand-in for pi whose flag is `flag`, with a channel that answers
 * every call with `reply`.
 *
 * @remarks
 * As pi does, flags are read only once a session starts.
 *
 * @sideEffects none
 * @param flag - What pi gives for `--atrium-study`.
 * @param reply - What the host answers.
 * @returns What it recorded.
 */
function load(flag: string | undefined, reply: Answer | null = { ok: true, result: {} }): Loaded {
  const tools: Registered[] = [];
  const hooks = new Map<string, (event: never) => void>();
  const sent: { message: unknown; options: unknown }[] = [];
  const calls: { op: string; args: unknown; id: string }[] = [];
  let handler: ((args: string, ctx: { ui: { setStatus(): void }; isIdle(): boolean }) => Promise<void>) | undefined;
  const pi: StudyApi = {
    registerFlag: () => undefined,
    getFlag: (name) => (name === STUDY_FLAG ? flag : undefined),
    registerTool: (tool) => tools.push(tool),
    registerCommand: (name, options) => {
      if (name === STUDY_COMMAND) handler = options.handler;
    },
    sendMessage: (message, options) => sent.push({ message, options }),
    on: (event: string, hook: (event: never) => void) => hooks.set(event, hook),
  };
  const channel: HostChannel = {
    call: (_ui, id, op, args) => {
      calls.push({ op, args, id });
      const answer: AgentReply | null = reply === null ? null : { id, ...reply };
      return Promise.resolve(answer);
    },
  };
  atriumStudy(pi, channel);
  return {
    tools,
    hooks,
    sent,
    calls,
    command: (args, idle = true) =>
      handler === undefined
        ? Promise.resolve()
        : handler(args, { ui: { setStatus: () => undefined }, isIdle: () => idle }),
    start: () => (hooks.get("session_start") as (() => void) | undefined)?.(),
    sections: () => {
      const sections: Record<string, string> = { cwd: "/d" };
      (hooks.get("before_agent_start") as ((event: unknown) => void) | undefined)?.({
        systemPromptOptions: { sections },
      });
      return sections;
    },
  };
}

/** A tool's `execute`, called as pi calls it. */
function execute(tool: Registered | undefined, params: Record<string, unknown>) {
  if (tool === undefined) throw new Error("no such tool");
  return tool.execute("call-1", params, undefined, undefined, { ui: { setStatus: () => undefined } });
}

describe("study mode's flag", () => {
  it("reads back what the host wrote, and nothing else", () => {
    expect(readStudyArgument(studyArgument({ kind: "lesson", level: "l2", step: "s4" }))).toStrictEqual({
      kind: "lesson",
      level: "l2",
      step: "s4",
    });
    expect(readStudyArgument(studyArgument({ kind: "discuss" }))).toStrictEqual({ kind: "discuss" });
    for (const flag of [
      undefined,
      "",
      true,
      "not json",
      encodeArgument({ v: 2, kind: "lesson" }),
      encodeArgument({ kind: "lesson" }),
      encodeArgument({ v: 1, kind: "ask" }),
      encodeArgument({ v: 1, kind: "nap" }),
      encodeArgument({ v: 1, kind: "lesson", extra: 1 }),
      encodeArgument([1]),
    ]) {
      expect(readStudyArgument(flag)).toBeNull();
    }
  });

  it("reads a quiz with no lesson to come from, and that mark on nothing else (ML3)", () => {
    expect(readStudyArgument(studyArgument({ kind: "quiz", level: "l1", step: "s2", context: "none" }))).toStrictEqual({
      kind: "quiz",
      level: "l1",
      step: "s2",
      context: "none",
    });
    for (const flag of [
      encodeArgument({ v: 1, kind: "quiz", level: "l1", step: "s2", context: "lesson" }),
      encodeArgument({ v: 1, kind: "quiz", level: "l1", step: "s2", context: null }),
      encodeArgument({ v: 1, kind: "lesson", level: "l1", step: "s2", context: "none" }),
      encodeArgument({ v: 1, kind: "exam", level: "l1", step: "s9", context: "none" }),
    ]) {
      expect(readStudyArgument(flag)).toBeNull();
    }
  });

  it("reads no flag that is empty, not text, or no object", () => {
    expect([undefined, "", 7, true, encodeArgument(null)].map((flag) => readStudyArgument(flag))).toStrictEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("gives each use only its tools, and every tool to some use", () => {
    expect(TOOLS_BY_USE).toStrictEqual({
      discuss: ["study_set_name", "study_set_profile", "study_set_ladder"],
      plan: ["study_set_steps"],
      lesson: ["study_report"],
      sheet: ["study_report"],
      project: ["study_report"],
      quiz: ["study_report", "study_add_gap"],
      exam: ["study_report", "study_add_gap"],
      feynman: ["study_fix_gap"],
    });
    expect(new Set(Object.values(TOOLS_BY_USE).flat())).toStrictEqual(new Set(STUDY_TOOLS));
  });
});

describe("study mode's part of the extension", () => {
  it("registers no tool and no prompt without the flag, and none before the session starts", () => {
    expectTypeOf<ExtensionAPI>().toExtend<StudyApi>();
    for (const flag of [undefined, encodeArgument({ v: 1, kind: "ask" })]) {
      const loaded = load(flag);
      loaded.start();

      expect(loaded.tools).toStrictEqual([]);
      expect(loaded.sections()).toStrictEqual({ cwd: "/d" });
    }
    const early = load(studyArgument({ kind: "discuss" }));

    expect(early.tools).toStrictEqual([]);
  });

  it("registers the use's tools once, at session start", () => {
    const loaded = load(studyArgument({ kind: "discuss" }));
    loaded.start();
    loaded.start();

    expect(loaded.tools.map((tool) => tool.name)).toStrictEqual([
      "study_set_name",
      "study_set_profile",
      "study_set_ladder",
    ]);
    for (const kind of ["quiz", "feynman"] as const) {
      const other = load(studyArgument({ kind, level: "l1", step: "s1", gap: "g1" }));
      other.start();

      expect(other.tools.map((tool) => tool.name)).toStrictEqual(TOOLS_BY_USE[kind]);
    }
  });

  it("declares each tool to pi as the model reads it: its label, words, schema and mode, no text with a maxLength", () => {
    const uses = [
      { kind: "discuss" },
      { kind: "plan" },
      { kind: "quiz", level: "l1", step: "s1" },
      { kind: "feynman", level: "l1", step: "s1", gap: "g1" },
    ] as const;
    const declared = uses.flatMap((use) => {
      const loaded = load(studyArgument(use));
      loaded.start();
      return loaded.tools.map((tool) => JSON.parse(JSON.stringify(tool)) as unknown);
    });

    expect(declared).toStrictEqual(TOOL_DEFINITIONS);
    expect(JSON.stringify(declared)).not.toContain("maxLength");
  });

  it("tells the model each tool went through in its own words", async () => {
    const uses = [
      { kind: "discuss" },
      { kind: "plan" },
      { kind: "quiz", level: "l1", step: "s1" },
      { kind: "feynman", level: "l1", step: "s1", gap: "g1" },
    ] as const;
    const said: Record<string, unknown> = {};
    for (const use of uses) {
      const loaded = load(studyArgument(use));
      loaded.start();
      for (const tool of loaded.tools) said[tool.name] = (await execute(tool, {})).content;
    }

    expect(said).toStrictEqual({
      study_set_name: [{ type: "text", text: "Renamed." }],
      study_set_profile: [{ type: "text", text: "Profile recorded." }],
      study_set_ladder: [
        {
          type: "text",
          text: "Ladder written. The discussion is over; the learner can start the first lesson from the step strip.",
        },
      ],
      study_set_steps: [{ type: "text", text: "Lessons written." }],
      study_report: [{ type: "text", text: "Reported." }],
      study_add_gap: [{ type: "text", text: "Gap recorded." }],
      study_fix_gap: [{ type: "text", text: "Gap marked fixed." }],
    });
  });

  it("sets its section before every run", () => {
    const loaded = load(studyArgument({ kind: "lesson", level: "l2", step: "s4" }));

    expect(loaded.sections()).toStrictEqual({
      cwd: "/d",
      [STUDY_SECTION]: studyPrompt({ kind: "lesson", level: "l2", step: "s4" }),
    });
    expect(STUDY_SECTION).toBe("atrium_study");
  });

  it("asks the host with the tool's name as the call, and words the answer", async () => {
    const loaded = load(studyArgument({ kind: "discuss" }));
    loaded.start();
    const ladder = loaded.tools.find((tool) => tool.name === "study_set_ladder");
    const params = { levels: [{ name: "a", topics: "", pass: "" }], lessons: ["x"] };

    await expect(execute(ladder, params)).resolves.toStrictEqual({
      content: [
        {
          type: "text",
          text: "Ladder written. The discussion is over; the learner can start the first lesson from the step strip.",
        },
      ],
      details: {},
    });
    expect(loaded.calls).toStrictEqual([{ op: "study_set_ladder", args: params, id: "call-1" }]);
  });

  it("words the host's refusal, with its parameters", async () => {
    const loaded = load(studyArgument({ kind: "discuss" }), {
      ok: false,
      code: "study_ladder_size",
      params: { min: 2, max: 6, got: 7 },
    });
    loaded.start();
    const result = await execute(
      loaded.tools.find((tool) => tool.name === "study_set_ladder"),
      { levels: [], lessons: ["x"] },
    );

    expect(result).toStrictEqual({
      content: [
        {
          type: "text",
          text: "Error study_ladder_size: A ladder has 2 to 6 levels, skipped ones included; this one has 7. Merge or split levels and call it again.",
        },
      ],
      details: { error: "study_ladder_size", params: { min: 2, max: 6, got: 7 } },
      isError: true,
    });
  });

  it("refuses text over its limit without asking, and says stopped when stopped", async () => {
    const loaded = load(studyArgument({ kind: "quiz", level: "l1", step: "s1" }), null);
    loaded.start();
    const gap = loaded.tools.find((tool) => tool.name === "study_add_gap");

    await expect(execute(gap, { text: "x".repeat(1001) })).resolves.toMatchObject({
      details: { error: "agent_text_too_long", params: { field: "text", max: 1000 } },
      isError: true,
    });
    expect(loaded.calls).toStrictEqual([]);
    await expect(execute(gap, { text: "x" })).resolves.toStrictEqual({
      content: [{ type: "text", text: "Stopped." }],
      details: { stopped: true },
      isError: true,
    });
  });

  it("starts a turn with the use as an atrium-agent message, only for a well-formed start, after a run under way", async () => {
    const launch = { kind: "lesson", level: "l2", step: "s4" } as const;
    const loaded = load(studyArgument(launch));
    await loaded.command("start");
    await loaded.command(`start ${encodeArgument({ v: 1, kind: "exam" })}`);

    expect(loaded.sent).toStrictEqual([]);
    await loaded.command(startCommand().slice(STUDY_COMMAND.length + 2));
    // pi runs: the start waits for the run to end, not dropped (SPEC-0008, "ML2 定的细节").
    await loaded.command(startCommand().slice(STUDY_COMMAND.length + 2), false);
    const message = {
      customType: AGENT_MESSAGE,
      content: kickoffText(launch),
      display: true,
      details: { v: 1, kind: "study", deliveries: [], study: launch },
    };

    expect(loaded.sent).toStrictEqual([
      { message, options: { triggerTurn: true } },
      { message, options: { triggerTurn: true, deliverAs: "followUp" } },
    ]);
    const none = load(undefined);
    await none.command(startCommand().slice(STUDY_COMMAND.length + 2));

    expect(none.sent).toStrictEqual([]);
  });
});

describe("study mode's words", () => {
  it("puts the prompt together: the common rules, a blank line, the use and where, the use's own", () => {
    const lines = studyPrompt({ kind: "feynman", level: "l2", step: "s4", gap: "g1" }).split("\n");
    const at = lines.indexOf('This session\'s use: feynman (level="l2" step="s4" gap="g1" in .atrium-study.json).');

    expect(at).toBeGreaterThan(1);
    expect(lines[at - 1]).toBe("");
    expect(lines[at - 2]?.startsWith("Never say Atrium's internal ids")).toBe(true);
    expect(studyPrompt({ kind: "discuss" }).split("\n")).toContain("This session's use: discuss.");
  });

  it("tells every use to leave the direction's AGENTS.md alone (2026-11-09)", () => {
    for (const kind of ["discuss", "plan", "lesson", "quiz", "feynman", "sheet", "project", "exam"] as const) {
      expect(studyPrompt({ kind }).split("\n")).toContain(AGENTS_RULE);
    }
    // The discussion no longer writes the profile there: only study_set_profile records it.
    expect(studyPrompt({ kind: "discuss" })).not.toMatch(/in AGENTS\.md|Learner profile/u);
  });

  it("has the discussion propose the ladder, set it only once agreed, then wrap up and stop (2026-11-09)", () => {
    const discuss = studyPrompt({ kind: "discuss" });

    expect(discuss).toContain(
      "Show the ladder and the starting level's lessons together as a proposal and ask the learner to confirm, in their language (for example: 准备这样排，确认吗？). Do not say the ladder is set or saved before you have called study_set_ladder.",
    );
    expect(discuss).toContain(
      "Only after the learner confirms, call study_set_ladder once with the levels (skip: true for the ones placement showed they can skip) and the starting level's lesson titles.",
    );
    expect(discuss).toContain(
      "Once it succeeds, wrap up in two or three sentences (what was set, and that the first lesson starts from the direction's home in Atrium), then stop. Do no more work with files in this session: do not create directories or files and do not edit resources.md or anything else.",
    );
  });

  it("has the quiz ask 5 to 10 questions one at a time, score them by tens, and report again to overwrite (ML3)", () => {
    const quiz = studyPrompt({ kind: "quiz", level: "l1", step: "s2" });

    expect(quiz).toContain(
      "Ask one question at a time, from easy to hard: 5 to 10 questions, and stop early after two in a row the learner cannot answer.",
    );
    // Real-model check (2026-11-09, D): cards for every choice, a wrong answer explained at once.
    expect(quiz).toContain(
      "Ask every multiple-choice question with the ask_user tool, as a question card with the choices as its options; never list the choices in your text instead.",
    );
    expect(quiz).toContain(
      "Judge each answer as soon as it comes: say whether it was right, and when it was wrong or partly right, explain the right answer and what was missed right then, before you ask the next question. Do not leave the explanations for the summary at the end.",
    );
    expect(quiz).toContain(
      "Score each question out of 10 (partial credit allowed). At the end call study_report with score as the sum and of as 10 times the number of questions asked.",
    );
    expect(quiz).toContain(
      "Each time an answer shows a gap, call study_add_gap with what the learner does not understand and the question's number.",
    );
    expect(quiz).toContain("Calling study_report again in this session overwrites the score.");
  });

  it("has the exam cover the whole level in 10 questions, scored as the quiz (ML3)", () => {
    const exam = studyPrompt({ kind: "exam", level: "l1", step: "s9" });

    expect(exam).toContain(
      "Give the level's final exam: 10 questions over the whole level, from easy to hard, one at a time, judging each at once.",
    );
    expect(exam).toContain(
      "Score each question out of 10 (partial credit allowed). At the end call study_report with score as the sum and of as 100.",
    );
    expect(exam).toContain("Ask every multiple-choice question with the ask_user tool");
    expect(exam).toContain(
      "Each time an answer shows a gap, call study_add_gap with what the learner does not understand and the question's number.",
    );
  });

  it("has Feynman read its gap, mark it only once explained back clearly, and stop otherwise (ML3)", () => {
    const feynman = studyPrompt({ kind: "feynman", level: "l2", gap: "g3" });

    expect(feynman).toContain('This session\'s use: feynman (level="l2" gap="g3" in .atrium-study.json).');
    expect(feynman).toContain(
      "The gap is the entry of gaps in .atrium-study.json with the id above: read its text and where it came from first.",
    );
    expect(feynman).toContain(
      "Call study_fix_gap only once the learner has explained it back clearly in their own words. If they still cannot, do not call it: say what is still unclear and stop.",
    );
    expect(feynman).toContain("Write the final clean explanation to notes/ as a Feynman note for this gap.");
  });

  it("has the plan propose the level's lessons, set them only once agreed, then wrap up and stop (ML3)", () => {
    const plan = studyPrompt({ kind: "plan", level: "l2" });

    expect(plan).toContain(
      "Read the ladder, what the learner did in the levels before, and the gaps not yet fixed in .atrium-study.json.",
    );
    expect(plan).toContain(
      "Show the lessons as a proposal and ask the learner to confirm, in their language (for example: 准备这样排，确认吗？). Do not say the lessons are set or saved before you have called study_set_steps.",
    );
    expect(plan).toContain(
      "Only after the learner confirms, call study_set_steps once with the lesson titles: it can be called only once for a level.",
    );
    expect(plan).toContain(
      "Once it succeeds, wrap up in two or three sentences (how many lessons, and that the first one starts from the direction's home in Atrium), then stop.",
    );
    expect(plan).toContain(
      "You may add this level's resources to resources.md; do not change the ladder or AGENTS.md.",
    );
    // Real-model check (2026-11-09, D): the plan put a probe file in lab/.
    expect(plan).toContain(
      "Apart from adding to resources.md, do not create or edit any file in this session: nothing in lab/, no probe, scratch or test files.",
    );
  });

  it("has the lesson write no probe files, only its note and a starting file it needs (D)", () => {
    expect(studyPrompt({ kind: "lesson", level: "l1", step: "s1" })).toContain(
      "Do not create probe or scratch files to try things yourself. The files you write are the lesson's note in notes/ and, only when the lesson needs one, a short starting file in lab/ that the learner then fills in.",
    );
  });

  it("tells every use never to say Atrium's internal ids to the learner (D)", () => {
    for (const kind of ["discuss", "plan", "lesson", "quiz", "feynman", "sheet", "project", "exam"] as const) {
      expect(studyPrompt({ kind }).split("\n")).toContain(
        "Never say Atrium's internal ids (such as l1, s2 or g3) to the learner: call a level by its number and name, a lesson by its title, a gap by what it is about.",
      );
    }
  });

  it("tells a quiz with no lesson to come from to quiz from the notes and the progress (ML3)", () => {
    const none = kickoffText({ kind: "quiz", level: "l1", step: "s2", context: "none" }).split("\n");
    const forked = kickoffText({ kind: "quiz", level: "l1", step: "s2" });

    expect(none[0]).toBe('<atrium-study use="quiz" level="l1" step="s2" context="none">');
    expect(none).toContain(
      "There is no conversation of the lesson in this session: build the questions from the lesson's note in notes/ and from .atrium-study.json.",
    );
    expect(forked).not.toContain("There is no conversation of the lesson");
    expect(forked).toContain("The lesson's conversation is above: quiz on what was taught there, with its examples.");
    expect(kickoffText({ kind: "lesson", level: "l1", step: "s2" })).not.toContain(
      "The lesson's conversation is above",
    );
  });

  it("opens the kickoff with the use and only the ids there are, and closes it", () => {
    const full = kickoffText({ kind: "feynman", level: "l2", step: "s4", gap: "g1" }).split("\n");
    const bare = kickoffText({ kind: "discuss" }).split("\n");

    expect(full[0]).toBe('<atrium-study use="feynman" level="l2" step="s4" gap="g1">');
    expect(full.at(-1)).toBe("</atrium-study>");
    expect(bare[0]).toBe('<atrium-study use="discuss">');
    expect(bare.at(-1)).toBe("</atrium-study>");
  });

  it("reads a start with spaces around and between, and nothing but start", () => {
    const argument = encodeArgument({ v: 1 });

    expect(readStart(`  start   ${argument}  `)).toBe(true);
    expect(readStart(`stop ${argument}`)).toBe(false);
    expect(readStart(`start ${encodeArgument(null)}`)).toBe(false);
    expect(readStart(`start ${encodeArgument("v")}`)).toBe(false);
  });

  it("reads only a version 1 start with nothing else", () => {
    expect(startCommand()).toBe(`/atrium-study start ${encodeArgument({ v: 1 })}`);
    expect(readStart(`start ${encodeArgument({ v: 1 })}`)).toBe(true);
    for (const args of [
      "",
      "start",
      "stop",
      `start ${encodeArgument({ v: 2 })}`,
      `start ${encodeArgument({ v: 1 })} x`,
    ]) {
      expect(readStart(args)).toBe(false);
    }
  });

  it("escapes ids in the kickoff and the prompt", () => {
    const text = kickoffText({ kind: "feynman", level: "l1", step: "s1", gap: 'g"<' });

    expect(text.split("\n")[0]).toBe('<atrium-study use="feynman" level="l1" step="s1" gap="g&quot;&lt;">');
    expect(text).toContain("This is not the learner's message.");
    expect(studyPrompt({ kind: "discuss" })).toContain("This session's use: discuss.");
    expect(studyPrompt({ kind: "exam", level: "l2", step: "s9" })).toContain(
      'This session\'s use: exam (level="l2" step="s9" in .atrium-study.json).',
    );
    expect(studyPrompt({ kind: "discuss" })).toContain("2 to 6 levels");
  });

  it("finds text over its limit in fields and lists", () => {
    expect(studyTooLong("study_set_name", { name: "x".repeat(257) })).toStrictEqual({ field: "name", max: 256 });
    expect(studyTooLong("study_set_name", { name: "x".repeat(256) })).toBeNull();
    // The name also within the 256 units the list carries; other texts by what is seen only.
    expect(studyTooLong("study_set_name", { name: "👨‍👩‍👧".repeat(40) })).toStrictEqual({ field: "name", max: 256 });
    expect(studyTooLong("study_add_gap", { text: "👨‍👩‍👧".repeat(300) })).toBeNull();
    expect(studyTooLong("study_set_steps", { levels: [{ name: "x".repeat(61) }], lessons: [] })).toBeNull();
    expect(
      studyTooLong("study_set_ladder", { levels: [null, "x", { name: "x".repeat(61) }], lessons: [] }),
    ).toStrictEqual({ field: "levels[].name", max: 60 });
    // Characters as a reader sees them: a joined emoji is one (SPEC-0008, "ML2 定的细节").
    const family = "👨‍👩‍👧";
    expect(studyTooLong("study_add_gap", { text: family.repeat(1000) })).toBeNull();
    expect(studyTooLong("study_add_gap", { text: family.repeat(1001) })).toStrictEqual({ field: "text", max: 1000 });
    expect(studyTooLong("study_set_steps", { lessons: [family.repeat(120)] })).toBeNull();
    expect(
      studyTooLong("study_set_ladder", { levels: [{ name: family.repeat(60), topics: "", pass: "" }], lessons: ["a"] }),
    ).toBeNull();
    expect(
      studyTooLong("study_set_ladder", { levels: [{ name: "x".repeat(61), topics: "", pass: "" }], lessons: [] }),
    ).toStrictEqual({ field: "levels[].name", max: 60 });
    expect(
      studyTooLong("study_set_ladder", { levels: [{ name: "x", topics: "x".repeat(501), pass: "" }], lessons: [] }),
    ).toStrictEqual({ field: "levels[].topics", max: 500 });
    expect(studyTooLong("study_set_steps", { lessons: ["x".repeat(121)] })).toStrictEqual({
      field: "lessons[]",
      max: 120,
    });
    expect(studyTooLong("study_set_profile", { goal: "x".repeat(201) })).toStrictEqual({ field: "goal", max: 200 });
    expect(studyTooLong("study_report", { score: 1 })).toBeNull();
  });
});

/** The study tools as the extension declares them to pi (SPEC-0008, "ML2 定的细节"). */
const TOOL_DEFINITIONS = [
  {
    name: "study_set_name",
    label: "Name the direction",
    description: "Changes the learning direction's display name, as the learner sees it. Its directory keeps its name.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The new display name, short, in the learner's language.",
          minLength: 1,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "study_set_profile",
    label: "Record the profile",
    description:
      "Records the learner's profile for the direction's home: goal, time per week, language or environment. Each field is optional; one given replaces the one before.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "What the learner wants to be able to do, in one line.",
          minLength: 0,
        },
        weeklyHours: {
          type: "string",
          description: 'Hours a week, as the learner said, like "4-8".',
          minLength: 0,
        },
        language: {
          type: "string",
          description: "The language or environment they learn in.",
          minLength: 0,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "study_set_ladder",
    label: "Write the ladder",
    description:
      "Writes the learner's ladder, which ends the discussion and cannot be changed afterwards: 2 to 6 levels in order (skipped ones included, with skip: true), and the lesson titles of the level they start at, the first one not skipped.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        levels: {
          type: "array",
          description: "The levels, from beginner to the learner's goal.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "A short name for the level.",
                minLength: 1,
              },
              topics: {
                type: "string",
                description: "What the level covers.",
                minLength: 0,
              },
              pass: {
                type: "string",
                description: "How to tell the level is passed.",
                minLength: 0,
              },
              skip: {
                type: "boolean",
                description: "The placement showed the learner can skip this level.",
              },
            },
            required: ["name", "topics", "pass"],
            additionalProperties: false,
          },
        },
        lessons: {
          type: "array",
          description: "The starting level's lessons, in order: their titles.",
          items: {
            type: "string",
            description: "A lesson's title.",
            minLength: 1,
          },
          minItems: 1,
          maxItems: 30,
        },
      },
      required: ["levels", "lessons"],
      additionalProperties: false,
    },
  },
  {
    name: "study_set_steps",
    label: "Plan the level",
    description: "Writes the current level's lessons, in order, when it has none yet.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        lessons: {
          type: "array",
          items: {
            type: "string",
            description: "A lesson's title.",
            minLength: 1,
          },
          minItems: 1,
          maxItems: 30,
        },
      },
      required: ["lessons"],
      additionalProperties: false,
    },
  },
  {
    name: "study_report",
    label: "Report progress",
    description:
      "Reports that this session's work is done: a lesson taught, a cheat sheet written or a project passed (no score), or a quiz or exam finished (with score and of).",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        score: {
          type: "integer",
          minimum: 0,
          description: "Questions answered right.",
        },
        of: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Questions asked.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "study_add_gap",
    label: "Record a gap",
    description: "Records a gap an answer showed: what the learner does not understand yet, in one or two sentences.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "What the learner does not understand yet.",
          minLength: 1,
        },
        question: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "The question's number.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "study_fix_gap",
    label: "Mark the gap fixed",
    description: "Marks the gap this Feynman session is for as fixed, once the learner explained it clearly.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];
