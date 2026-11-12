import { STUDY_FLAG, makesNoVisual, readStudyArgument } from "../study/study";
import { VISUALS_FLAG, VISUALS_SECTION, readVisualsArgument, visualsPrompt } from "./visuals";

/** What `before_agent_start` hands the extension that it changes: pi's prompt sections. */
interface BeforeAgentStart {
  readonly systemPromptOptions: { sections: Record<string, string> };
}

/** The part of pi's extension API the visuals part uses; its test checks pi's `ExtensionAPI` fits it. */
export interface VisualsApi {
  registerFlag(name: string, options: { readonly description: string; readonly type: "string" }): void;
  getFlag(name: string): boolean | string | undefined;
  on(event: "before_agent_start", handler: (event: BeforeAgentStart) => void): void;
}

/**
 * Tells the model it can show visuals, and where to write them (SPEC-0007, "怎么让 agent 知道").
 *
 * @remarks
 * The directory comes from `--atrium-visuals`, which the host gives every pi it starts; pi sets
 * flags after extensions load, so it is read when a run starts. Without the flag the prompt is
 * left as it is. The section is set, not appended, so it stays one section across runs. A study
 * quiz or exam, which makes no visual, gets none: its study section says so (SPEC-0008, ML4 review).
 *
 * @sideEffects Registers a flag and a hook with pi; the hook changes the run's prompt sections.
 * @param pi - pi's extension API.
 */
export default function atriumVisuals(pi: VisualsApi): void {
  pi.registerFlag(VISUALS_FLAG, {
    description: "Where this session's visuals go, set by Atrium's host",
    type: "string",
  });
  pi.on("before_agent_start", (event) => {
    const launch = readVisualsArgument(pi.getFlag(VISUALS_FLAG));
    if (launch !== null && !makesNoVisual(readStudyArgument(pi.getFlag(STUDY_FLAG))))
      event.systemPromptOptions.sections[VISUALS_SECTION] = visualsPrompt(launch.dir, launch.relative);
  });
}
