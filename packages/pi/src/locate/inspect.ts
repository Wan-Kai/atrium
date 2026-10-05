import { findPi, readPiVersion } from "./locate";
import { MIN_PI_VERSION, type Version, isAtLeast } from "./version";

/** What Atrium found when it looked for pi. */
export type PiInspection =
  | { readonly status: "missing" }
  | {
      readonly status: "unusable";
      readonly piPath: string;
      /** pi's own error output or the failure, for the "展开看原始报错" view. */
      readonly detail: string;
    }
  | { readonly status: "outdated"; readonly piPath: string; readonly version: Version; readonly minimum: Version }
  | { readonly status: "ready"; readonly piPath: string; readonly version: Version };

/**
 * Finds pi on a search path and checks that it runs and is new enough.
 *
 * @remarks
 * The result drives first launch (SPEC-0001, "第 1 步：安装 pi"): install when missing, update when
 * outdated, show the raw error when pi is there but cannot run, for example because the node it
 * finds is too old. The minimum is the version the pi-internals notes were checked against
 * (roadmap M1.2). `pi --version` runs with `searchPath` as its PATH, because pi's launcher looks up
 * `node` on PATH just like we looked up pi.
 *
 * @sideEffects Checks files on disk; runs `pi --version`.
 * @param searchPath - PATH-style directory list, normally from the login shell.
 * @param options - Base environment for `pi --version` (its PATH is replaced) and an abort signal.
 * @returns What was found.
 */
export async function inspectPi(
  searchPath: string,
  options: { readonly env: Readonly<Record<string, string>>; readonly signal?: AbortSignal },
): Promise<PiInspection> {
  const piPath = await findPi(searchPath);
  if (piPath === null) return { status: "missing" };
  let version: Version | null;
  try {
    version = await readPiVersion(piPath, {
      env: { ...options.env, PATH: searchPath },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    const stderr = error instanceof Error ? Reflect.get(error, "stderr") : undefined;
    const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : String(error);
    return { status: "unusable", piPath, detail };
  }
  if (version === null) return { status: "unusable", piPath, detail: "pi --version printed no version" };
  if (!isAtLeast(version, MIN_PI_VERSION)) {
    return { status: "outdated", piPath, version, minimum: MIN_PI_VERSION };
  }
  return { status: "ready", piPath, version };
}
