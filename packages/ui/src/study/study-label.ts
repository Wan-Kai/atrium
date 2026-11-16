import type { SessionStudy, StudyProgress } from "@atrium/protocol";
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

/** What the conversation knows of the study session it shows (SPEC-0008, "ML3 定的细节"). */
export interface StudySessionInfo {
  /** The session's use. */
  readonly study: SessionStudy;
  /** Its direction's progress, when read. */
  readonly progress: StudyProgress | null;
  /** The session it is a child of: a quiz's lesson; `null` for none. */
  readonly parentId: string | null;
  /** The quiz's lesson's title, for its head; `null` when not known. */
  readonly lessonTitle: string | null;
}

/**
 * The study session the conversation shows, or `null` for any other.
 *
 * @remarks
 * The conversation area provides it; the transcript folds a quiz child's copied turns by it, the
 * source line says a quiz carried no lesson, the process track words the study tools.
 */
export const StudySessionContext = createContext<StudySessionInfo | null>(null);

/**
 * The study session shown here.
 *
 * @remarks
 * See `StudySessionContext`.
 *
 * @sideEffects none
 * @returns The session's study, or `null`.
 */
export function useStudySession(): StudySessionInfo | null {
  return useContext(StudySessionContext);
}
