import { guardPaths, type PathGuardApi } from "./path-guard";

/** The part of pi's API the task extension uses. */
export type TaskApi = PathGuardApi;

/**
 * The task part of Atrium's extension: today only the path guard (SPEC-0006).
 *
 * @remarks
 * `isolated` says whether this session may only change files under its working directory: the host
 * decides (SPEC-0002 `work` children now, task nodes later) and the agent part reads it from the flag.
 *
 * @sideEffects Registers a `tool_call` hook with pi.
 * @param pi - pi's extension API.
 * @param isolated - Whether this session is isolated.
 */
export default function atriumTask(pi: TaskApi, isolated: () => boolean): void {
  guardPaths(pi, isolated);
}
