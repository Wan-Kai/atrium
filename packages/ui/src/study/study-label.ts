import type { SessionStudy } from "@atrium/protocol";
import { createContext, useContext } from "react";
import { studyLabel } from "./progress";

/**
 * How the conversation names a use, with its direction's level and step numbers where it knows them.
 *
 * @remarks
 * The conversation area provides it for a direction's session; elsewhere a use is named alone
 * (SPEC-0008, "ML2 定的细节": the first turn of a session the host opened).
 */
export const StudyLabelContext = createContext<(study: SessionStudy) => string>((study) => studyLabel(study, null));

/**
 * The way to name a use here.
 *
 * @remarks
 * See `StudyLabelContext`.
 *
 * @sideEffects none
 * @returns The namer.
 */
export function useStudyLabel(): (study: SessionStudy) => string {
  return useContext(StudyLabelContext);
}
