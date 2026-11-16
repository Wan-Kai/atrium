/**
 * The directory of tasks the host should follow read-only, from the environment; dev only.
 *
 * @remarks
 * `ATRIUM_FOLLOW_TASKS` lets a running Atrium show a `pnpm task:try` run (SPEC-0006, "T7.1 定下的细节"). A
 * packaged app ignores it: only the main process reads the variable, only here, and the host under Electron takes
 * what the main process sends, so a variable set in a packaged app's environment reaches nothing.
 *
 * @sideEffects none
 * @param env - The main process's environment.
 * @param packaged - Whether this is a packaged app (`app.isPackaged`).
 * @returns The directory, or `undefined` for none (packaged, unset or empty).
 */
export function followTasksFor(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean,
): string | undefined {
  if (packaged) return undefined;
  const value = env["ATRIUM_FOLLOW_TASKS"];
  return value === undefined || value === "" ? undefined : value;
}
