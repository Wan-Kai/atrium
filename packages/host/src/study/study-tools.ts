import { type AgentErrorCode, type AgentRequest, type StudyTool, TOOLS_BY_USE } from "@atrium/pi";
import { type SessionStudy, isDirectionId } from "@atrium/protocol";
import type { Logger } from "../platform/logger";
import type { Directions } from "./directions";
import type { StudyFile } from "./progress";
import { type ProgressFiles, type StudyFileCode, StudyFileError } from "./progress-file";
import { StudyRuleError, addGap, fixGap, report, setLadder, setName, setProfile, setSteps } from "./progress-rules";

/** What a study tool's call comes to: its result, or the code the extension words. */
type StudyAnswer =
  | { readonly ok: true; readonly result: Readonly<Record<string, never>> }
  | { readonly ok: false; readonly code: AgentErrorCode; readonly params?: Readonly<Record<string, number>> };

/** A study tool's call, its arguments as the channel's schema read them. */
type StudyCall = {
  readonly [Op in StudyTool]: {
    readonly op: Op;
    readonly args: Extract<AgentRequest, { readonly kind: "call"; readonly op: Op }>["args"];
  };
}[StudyTool];

/** Answers the study tools of the sessions of directions. */
export interface StudyTools {
  /** Answers a session's call. */
  call(sessionId: string, call: StudyCall): Promise<StudyAnswer>;
}

/**
 * A study tool's change, for the session's record.
 *
 * @remarks
 * What a report or a gap is about comes from the record, never the arguments (security.md).
 *
 * @sideEffects none
 * @param call - The call.
 * @param study - The session's record.
 * @returns The change.
 * @throws {StudyRuleError} `study_not_found` for a Feynman session without its gap.
 */
function changeFor(call: StudyCall, study: SessionStudy): (file: StudyFile) => StudyFile {
  switch (call.op) {
    case "study_set_name": {
      const { name } = call.args;
      return (file) => setName(file, name);
    }
    case "study_set_profile": {
      const { args } = call;
      return (file) => setProfile(file, args);
    }
    case "study_set_ladder": {
      const { args } = call;
      return (file) => setLadder(file, args);
    }
    case "study_set_steps": {
      const { lessons } = call.args;
      return (file) => setSteps(file, lessons);
    }
    case "study_report": {
      const { args } = call;
      return (file) => report(file, study, args);
    }
    case "study_add_gap": {
      const { args } = call;
      return (file) => addGap(file, study, args);
    }
    case "study_fix_gap":
    default: {
      const gap = study.gap;
      if (gap === undefined) throw new StudyRuleError("study_not_found");
      return (file) => fixGap(file, gap);
    }
  }
}

/**
 * The code a tool answers for the progress file's refusal.
 *
 * @remarks
 * An archive under way is the direction not taking tools any more, as an archived one; a
 * directory that is no longer a real one under the learning directory is not written.
 *
 * @sideEffects none
 * @param code - The writer's code.
 * @returns The tool's.
 */
function toolCode(code: StudyFileCode): AgentErrorCode {
  if (code === "direction_archived") return "study_not_allowed";
  return code === "learning_dir_unsafe" ? "study_write_failed" : code;
}

/**
 * Creates the study tools' answers.
 *
 * @remarks
 * SPEC-0008, "ML2 定的细节": the caller is the session whose pi asked (ADR-0013, point 3); its
 * record must be of a direction not archived, with a use that has the tool (the extension only
 * registers those, so anything else is not Atrium's extension: `study_not_allowed`). The change
 * goes through the direction's file writer; the rules' and the writer's refusals come back as
 * codes. The list is scanned again at once rather than when the watch notices. Each call is
 * logged by direction, tool and code only, never what it wrote.
 *
 * @sideEffects none until a call; then writes markers, scans and logs.
 * @param options - How to find a session's record, the directions, the writer and the logger.
 * @returns The tools.
 */
export function createStudyTools(options: {
  readonly find: (
    sessionId: string,
  ) => { readonly containerId: string; readonly study: SessionStudy | null } | undefined;
  readonly directions: Pick<Directions, "find" | "scan">;
  readonly files: Pick<ProgressFiles, "update">;
  readonly logger: Logger;
}): StudyTools {
  return {
    async call(sessionId, call) {
      const { op } = call;
      const entry = options.find(sessionId);
      const direction =
        entry === undefined || !isDirectionId(entry.containerId)
          ? undefined
          : options.directions.find(entry.containerId);
      const study = entry?.study ?? null;
      const allowed =
        direction !== undefined &&
        !direction.archived &&
        study !== null &&
        study.kind !== "ask" &&
        TOOLS_BY_USE[study.kind].includes(op);
      if (!allowed || direction === undefined || study === null) {
        return { ok: false, code: "study_not_allowed" };
      }
      let answer: StudyAnswer;
      try {
        await options.files.update(direction.dir, changeFor(call, study));
        await options.directions.scan();
        answer = { ok: true, result: {} };
      } catch (error) {
        if (error instanceof StudyRuleError) {
          // A mark is a command's, never a tool's.
          const code = error.code === "study_mark_refused" ? "agent_failed" : error.code;
          answer = { ok: false, code, ...(Object.keys(error.params).length === 0 ? {} : { params: error.params }) };
        } else if (error instanceof StudyFileError) answer = { ok: false, code: toolCode(error.code) };
        else throw error;
      }
      options.logger.info({ directionId: direction.id, op, code: answer.ok ? null : answer.code }, "study tool");
      return answer;
    },
  };
}
