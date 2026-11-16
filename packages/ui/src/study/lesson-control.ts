import type { AtriumClient } from "@atrium/client";
import type { Control, StudyAction } from "@atrium/protocol";
import { useSyncExternalStore } from "react";
import { type LoopSession, quizLessonOf } from "./loop";

/**
 * The control of the lesson a quiz button would fork from, as this window sees it.
 *
 * @remarks
 * SPEC-0008, "ML3 定的细节 · 测验" (2026-11-09, C): only a session this window shows has its control
 * here (`AtriumClient.session`); the list's `running` covers the others. Kept up to date while the
 * session's view changes; `null` without a lesson, or for one not shown here.
 *
 * @sideEffects Subscribes to the lesson's view while it has one.
 * @param client - The client.
 * @param action - The button's action.
 * @param sessions - The direction's sessions.
 * @returns The control, or `null`.
 */
export function useLessonControl(
  client: Pick<AtriumClient, "session">,
  action: StudyAction | null,
  sessions: readonly LoopSession[],
): Control | null {
  const lessonId = quizLessonOf(action, sessions)?.sessionId;
  const view = lessonId === undefined ? undefined : client.session(lessonId);
  return useSyncExternalStore(
    (changed) => view?.subscribe(changed) ?? (() => undefined),
    () => view?.getState().control ?? null,
  );
}
