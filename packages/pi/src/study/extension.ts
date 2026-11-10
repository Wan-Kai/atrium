import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { AGENT_MESSAGE } from "../agent/agent";
import type { AgentErrorCode } from "../agent/channel";
import type { HostChannel, StatusLine } from "../agent/extension";
import { errorText } from "../agent/words";
import {
  STUDY_COMMAND,
  STUDY_FLAG,
  STUDY_SECTION,
  type StudyLaunch,
  type StudyTool,
  TOOLS_BY_USE,
  kickoffText,
  positionOf,
  readStart,
  readStudyArgument,
  readsAsAsk,
  ASK_PROMPT,
  studyPrompt,
  studyTooLong,
} from "./study";

/** A tool's result, as pi takes it. */
interface ToolResult {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly details: unknown;
  readonly isError?: boolean;
}

/** A study tool, as the extension registers it with pi; its parameters are plain JSON Schema. */
interface StudyToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly executionMode?: "sequential";
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(
    toolCallId: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { readonly ui: StatusLine },
  ): Promise<ToolResult>;
}

/** What `before_agent_start` hands the extension that it changes: pi's prompt sections. */
interface BeforeAgentStart {
  readonly systemPromptOptions: { sections: Record<string, string> };
}

/** The part of pi's extension API the study part uses; its test checks pi's `ExtensionAPI` fits it. */
export interface StudyApi {
  registerFlag(name: string, options: { readonly description: string; readonly type: "string" }): void;
  getFlag(name: string): boolean | string | undefined;
  registerTool(tool: StudyToolDefinition): void;
  registerCommand(
    name: string,
    options: {
      readonly description: string;
      readonly handler: (args: string, ctx: { readonly ui: StatusLine; isIdle(): boolean }) => Promise<void>;
    },
  ): void;
  sendMessage(
    message: {
      readonly customType: string;
      readonly content: string;
      readonly display: boolean;
      readonly details: unknown;
    },
    options?: { readonly triggerTurn?: boolean; readonly deliverAs?: "followUp" },
  ): void;
  on(event: "session_start", handler: () => void): unknown;
  on(event: "before_agent_start", handler: (event: BeforeAgentStart) => void): unknown;
}

/**
 * A JSON Schema string with a length limit.
 *
 * @remarks
 * For the tools' parameters.
 *
 * @sideEffects none
 * @param description - What it is, for the model.
 * @param minLength - The fewest characters.
 * @returns The schema.
 */
function text(description: string, minLength = 1): Record<string, unknown> {
  return { type: "string", description, minLength };
}

/**
 * The tools' definitions, without `execute`.
 *
 * @remarks
 * Plain JSON Schema, as pi takes it; the host checks again (`CallArgs`), and level counts are the
 * host's to refuse (`study_ladder_size`). No text has a `maxLength`: pi would refuse a long one
 * with its own words before `execute`, so the model would never get `agent_text_too_long` with the
 * field and the limit (ADR-0013, point 9); `studyTooLong` checks them instead.
 */
const SPECS: { readonly [Tool in StudyTool]: Omit<StudyToolDefinition, "name" | "execute"> } = {
  study_set_name: {
    label: "Name the direction",
    description: "Changes the learning direction's display name, as the learner sees it. Its directory keeps its name.",
    parameters: {
      type: "object",
      properties: { name: text("The new display name, short, in the learner's language.") },
      required: ["name"],
      additionalProperties: false,
    },
  },
  study_set_profile: {
    label: "Record the profile",
    description:
      "Records the learner's profile for the direction's home: goal, time per week, language or environment. Each field is optional; one given replaces the one before.",
    parameters: {
      type: "object",
      properties: {
        goal: text("What the learner wants to be able to do, in one line.", 0),
        weeklyHours: text('Hours a week, as the learner said, like "4-8".', 0),
        language: text("The language or environment they learn in.", 0),
      },
      additionalProperties: false,
    },
  },
  study_set_ladder: {
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
              name: text("A short name for the level."),
              topics: text("What the level covers.", 0),
              pass: text("How to tell the level is passed.", 0),
              skip: { type: "boolean", description: "The placement showed the learner can skip this level." },
            },
            required: ["name", "topics", "pass"],
            additionalProperties: false,
          },
        },
        lessons: {
          type: "array",
          description: "The starting level's lessons, in order: their titles.",
          items: text("A lesson's title."),
          minItems: 1,
          maxItems: 30,
        },
      },
      required: ["levels", "lessons"],
      additionalProperties: false,
    },
  },
  study_set_steps: {
    label: "Plan the level",
    description: "Writes the current level's lessons, in order, when it has none yet.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        lessons: { type: "array", items: text("A lesson's title."), minItems: 1, maxItems: 30 },
      },
      required: ["lessons"],
      additionalProperties: false,
    },
  },
  study_report: {
    label: "Report progress",
    description:
      "Reports that this session's work is done: a lesson taught, a cheat sheet written or a project passed (no score), or a quiz or exam finished (with score and of).",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        score: { type: "integer", minimum: 0, description: "Questions answered right." },
        of: { type: "integer", minimum: 1, maximum: 100, description: "Questions asked." },
      },
      additionalProperties: false,
    },
  },
  study_add_gap: {
    label: "Record a gap",
    description: "Records a gap an answer showed: what the learner does not understand yet, in one or two sentences.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        text: text("What the learner does not understand yet."),
        question: { type: "integer", minimum: 1, maximum: 100, description: "The question's number." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  study_fix_gap: {
    label: "Mark the gap fixed",
    description: "Marks the gap this Feynman session is for as fixed, once the learner explained it clearly.",
    executionMode: "sequential",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

/** What the model is told when a study tool's call went through. */
const DONE: { readonly [Tool in StudyTool]: string } = {
  study_set_name: "Renamed.",
  study_set_profile: "Profile recorded.",
  study_set_ladder:
    "Ladder written. The discussion is over; the learner can start the first lesson from the step strip.",
  study_set_steps: "Lessons written.",
  study_report: "Reported.",
  study_add_gap: "Gap recorded.",
  study_fix_gap: "Gap marked fixed.",
};

/**
 * A tool's result.
 *
 * @remarks
 * See `atriumStudy`.
 *
 * @sideEffects none
 * @param body - The text, and whether it failed.
 * @param details - The structured result.
 * @returns The result.
 */
function result(body: { readonly text: string; readonly error?: boolean }, details: unknown): ToolResult {
  return { content: [{ type: "text", text: body.text }], details, ...(body.error === true ? { isError: true } : {}) };
}

/**
 * A failed study tool's result, worded from the host's code.
 *
 * @remarks
 * The host sends only codes (ADR-0013, point 9).
 *
 * @sideEffects none
 * @param code - The code.
 * @param params - Its parameters.
 * @returns The result.
 */
function failed(code: AgentErrorCode, params?: Readonly<Record<string, unknown>>): ToolResult {
  return result(
    { text: errorText(code, params), error: true },
    { error: code, ...(params === undefined ? {} : { params }) },
  );
}

/** The most of a progress file the kickoff reads for its numbers, as the host's limit. */
const PROGRESS_MAX = 1024 * 1024;

/**
 * Reads the direction's progress file in a folder, refusing one over 1 MiB by its size before
 * reading it.
 *
 * @remarks
 * For the kickoff's numbers only (ML4). The size comes from the same opening that is read, and no
 * more than that size is read, so a huge file neither blocks pi nor fills its memory; the limit is
 * in bytes, as the host's. A file that grew meanwhile reads cut short, which then does not parse:
 * the kickoff goes without its numbers. A link is not followed, as the host does not (security.md).
 *
 * @sideEffects Opens, reads and closes the file.
 * @param dir - The direction's folder.
 * @returns Its text.
 * @throws When it cannot be read, is no plain file, or is too large.
 */
export function readProgressFile(dir: string): string {
  const fd = openSync(
    join(dir, ".atrium-study.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error("not a file");
    if (stats.size > PROGRESS_MAX) throw new Error("too large");
    const buffer = Buffer.alloc(stats.size);
    let length = 0;
    // Stryker disable next-line EqualityOperator: one more turn asks for 0 bytes, which reads 0 and stops.
    while (length < buffer.length) {
      // Stryker disable next-line ArithmeticOperator: a file read in one go asks from 0, where both give the whole buffer.
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      // Stryker disable next-line ConditionalExpression: only a file that shrank meanwhile ends early; reading on gives 0 again.
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length).toString("utf8");
    // Stryker disable next-line all: an open descriptor is not observable from the result.
  } finally {
    // Stryker disable next-line all: as above.
    closeSync(fd);
  }
}

// Stryker disable all: pi's working directory is the direction's folder; the tests give their own reader.
/**
 * Reads the direction's progress file in pi's working directory, the direction's folder.
 *
 * @remarks
 * See `readProgressFile`.
 *
 * @sideEffects Reads the file.
 * @returns Its text.
 * @throws When it cannot be read.
 */
function readProgress(): string {
  return readProgressFile(process.cwd());
}
// Stryker restore all

/**
 * Study mode's part of Atrium's extension (SPEC-0008, "ML2 定的细节").
 *
 * @remarks
 * Only a session the host started with `--atrium-study` gets anything: the use's tools, registered
 * at `session_start` once pi has set the flags (it sets them after extensions load), and the use's
 * prompt section before every run. A session without the flag, as every workspace and chat
 * session and a direction's asking ones, has no study tool in its list at all (2026-11-09). The
 * tools ask the host on the agent part's channel; the host checks the use again by the session's
 * record. `/atrium-study start` sends the kickoff as an `atrium-agent` message that starts a turn,
 * so its transcript shows the use, not this text; for a lesson and Feynman it names the level's and
 * step's numbers from the progress file, and goes without them when the file cannot be read (ML4).
 *
 * @sideEffects Registers a flag, a command and two hooks with pi; at session start, the use's
 * tools; their calls ask the host; a start reads the progress file.
 * @param pi - pi's extension API.
 * @param channel - The channel to the host.
 * @param progress - Reads the progress file; tests give their own.
 */
export default function atriumStudy(pi: StudyApi, channel: HostChannel, progress: () => string = readProgress): void {
  let launch: StudyLaunch | null | undefined;
  let registered = false;

  pi.registerFlag(STUDY_FLAG, {
    description: "This session's use in a learning direction, set by Atrium's host",
    type: "string",
  });

  /**
   * The session's use, read once.
   *
   * @remarks
   * pi sets flags after extensions load, so not at registration.
   *
   * @sideEffects Keeps what it read.
   * @returns The use, or `null`.
   */
  const use = (): StudyLaunch | null => {
    launch ??= readStudyArgument(pi.getFlag(STUDY_FLAG));
    return launch;
  };

  /**
   * Runs a study tool: checks its text, asks the host, words the answer.
   *
   * @remarks
   * See `atriumStudy`.
   *
   * @sideEffects Asks the host.
   * @param tool - The tool.
   * @param id - The call's id.
   * @param params - Its parameters.
   * @param signal - Its signal.
   * @param ui - Its status line.
   * @returns The result.
   */
  const run = async (
    tool: StudyTool,
    id: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    ui: StatusLine,
  ): Promise<ToolResult> => {
    const long = studyTooLong(tool, params);
    if (long !== null) return failed("agent_text_too_long", long);
    const reply = await channel.call(ui, id, tool, params, signal);
    if (reply === null) return result({ text: "Stopped.", error: true }, { stopped: true });
    if (!reply.ok) return failed(reply.code, reply.params);
    return result({ text: DONE[tool] }, reply.result);
  };

  pi.on("session_start", () => {
    const found = use();
    if (found === null || registered) return;
    registered = true;
    for (const tool of TOOLS_BY_USE[found.kind])
      pi.registerTool({
        name: tool,
        ...SPECS[tool],
        execute: (id, params, signal, _onUpdate, ctx) => run(tool, id, params, signal, ctx.ui),
      });
  });

  pi.on("before_agent_start", (event) => {
    const found = use();
    if (found !== null) event.systemPromptOptions.sections[STUDY_SECTION] = studyPrompt(found);
    // An asking session has no use, only the rule of staying in the direction's folder (ML4 review).
    else if (readsAsAsk(pi.getFlag(STUDY_FLAG))) event.systemPromptOptions.sections[STUDY_SECTION] = ASK_PROMPT;
  });

  pi.registerCommand(STUDY_COMMAND, {
    description: "Starts a session Atrium opened for a use in a learning direction, sent by Atrium's host",
    handler: (args, ctx) => {
      const found = use();
      // Only a version 1 start. While pi runs (the learner wrote first), after the run, not dropped.
      if (found === null || !readStart(args)) return Promise.resolve();
      const { kind, level, step, gap } = found;
      let at: ReturnType<typeof positionOf> = null;
      try {
        at = positionOf(progress(), level, step);
      } catch {
        // Without the file the kickoff goes without its numbers.
      }
      pi.sendMessage(
        {
          customType: AGENT_MESSAGE,
          content: kickoffText(found, at),
          display: true,
          details: {
            v: 1,
            kind: "study",
            deliveries: [],
            study: {
              kind,
              ...(level === undefined ? {} : { level }),
              ...(step === undefined ? {} : { step }),
              ...(gap === undefined ? {} : { gap }),
            },
          },
        },
        ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" },
      );
      return Promise.resolve();
    },
  });
}
