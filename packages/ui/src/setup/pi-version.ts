import type { SetupPi } from "@atrium/protocol";

/**
 * The numbers of a version's core, `x.y.z`, and whether it is a pre-release.
 *
 * @remarks
 * Build metadata after `+` does not order versions.
 *
 * @sideEffects none
 * @param version - The version.
 * @returns Its core numbers and whether it has a pre-release part.
 */
function parts(version: string): { readonly core: readonly number[]; readonly pre: boolean } {
  const [main = ""] = version.split("+");
  const dash = main.indexOf("-");
  const core = (dash === -1 ? main : main.slice(0, dash)).split(".").map(Number);
  return { core, pre: dash !== -1 };
}

/**
 * Whether a released version is newer than the one installed.
 *
 * @remarks
 * Compares `x.y.z` as numbers; a pre-release of the same core is older than the release.
 *
 * @sideEffects none
 * @param latest - The version released.
 * @param current - The version installed.
 * @returns Whether to offer the update.
 */
export function isNewer(latest: string, current: string): boolean {
  const next = parts(latest);
  const now = parts(current);
  for (let at = 0; at < 3; at += 1) {
    const a = next.core[at] ?? 0;
    const b = now.core[at] ?? 0;
    if (a !== b) return a > b;
  }
  return !next.pre && now.pre;
}

/**
 * Whether pi has a newer version than the one installed.
 *
 * @remarks
 * For the "更新 pi" button and the blue dot (SPEC-0001, "设置 · pi"); only for a pi that runs.
 *
 * @sideEffects none
 * @param pi - pi, as `check_setup` reports it.
 * @returns Whether there is an update.
 */
export function piUpdateAvailable(pi: SetupPi): boolean {
  if (pi.state === "missing" || pi.state === "broken" || pi.version === null || pi.latest === null) return false;
  return isNewer(pi.latest, pi.version);
}
