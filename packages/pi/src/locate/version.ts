/** A parsed `major.minor.patch` version. */
export type Version = readonly [major: number, minor: number, patch: number];

/**
 * Oldest pi release Atrium supports.
 *
 * @remarks
 * pi-internals.md was verified against 1.0.1; older releases may lack behavior the host relies on,
 * such as `get_entries` and prompt dispositions (development.md, "环境与版本").
 */
export const MIN_PI_VERSION: Version = [1, 0, 1];

/**
 * Extracts the first `major.minor.patch` from text such as `pi --version` output.
 *
 * @remarks
 * pi prints a bare version today, but tolerating prefixes and suffixes (`v1.0.2`, `1.0.2-beta`)
 * keeps the check working if the format grows.
 *
 * @sideEffects none
 * @param text - Command output.
 * @returns The version, or `null` if none is present.
 */
export function parseVersion(text: string): Version | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Tells whether `version` is at least `minimum`.
 *
 * @remarks
 * Compares numerically per component, so `1.10.0` is newer than `1.9.9`.
 *
 * @sideEffects none
 * @param version - Version found.
 * @param minimum - Lowest acceptable version.
 * @returns Whether the version is acceptable.
 */
export function isAtLeast(version: Version, minimum: Version): boolean {
  const [major, minor, patch] = version;
  const [minMajor, minMinor, minPatch] = minimum;
  return (major - minMajor || minor - minMinor || patch - minPatch) >= 0;
}
