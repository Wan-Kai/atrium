import { PI_VERSION_TIMEOUT_MS, findPi, readPiVersion } from "./locate";
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
 * Says why `pi --version` failed, preferring pi's own words.
 *
 * @remarks
 * `execFile` reports every failure as "Command failed", whether pi printed an error, exited
 * silently, was killed or hit the deadline; the person reading "pi cannot run" needs to know which.
 *
 * @sideEffects none
 * @param error - What `readPiVersion` threw.
 * @param timeoutMs - The deadline it ran with.
 * @returns A one-line explanation.
 */
function describeFailure(error: unknown, timeoutMs: number): string {
  // Stryker disable next-line ConditionalExpression: `execFile` only ever rejects with an Error.
  if (!(error instanceof Error)) return String(error);
  const stderr = Reflect.get(error, "stderr");
  // Stryker disable next-line ConditionalExpression: `execFile` errors always carry stderr as a string.
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
  if (Reflect.get(error, "killed") === true) return `pi --version did not answer within ${timeoutMs} ms`;
  const signal = Reflect.get(error, "signal");
  if (typeof signal === "string") return `pi --version was stopped by ${signal}`;
  const code = Reflect.get(error, "code");
  if (typeof code === "number") return `pi --version exited with code ${code}`;
  return error.message;
}

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
 * @param options - Base environment for `pi --version` (its PATH is replaced), an abort signal and
 * the deadline.
 * @returns What was found.
 */
export async function inspectPi(
  searchPath: string,
  options: {
    readonly env: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    /** Deadline for `pi --version`; tests shorten it. */
    readonly timeoutMs?: number;
  },
): Promise<PiInspection> {
  const piPath = await findPi(searchPath);
  if (piPath === null) return { status: "missing" };
  const timeoutMs = options.timeoutMs ?? PI_VERSION_TIMEOUT_MS;
  let version: Version | null;
  try {
    version = await readPiVersion(piPath, {
      env: { ...options.env, PATH: searchPath },
      timeoutMs,
      // Stryker disable next-line ConditionalExpression: passing `signal: undefined` behaves the same; the spread only satisfies exact optional types.
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    return { status: "unusable", piPath, detail: describeFailure(error, timeoutMs) };
  }
  if (version === null) return { status: "unusable", piPath, detail: "pi --version printed no version" };
  if (!isAtLeast(version, MIN_PI_VERSION)) {
    return { status: "outdated", piPath, version, minimum: MIN_PI_VERSION };
  }
  return { status: "ready", piPath, version };
}
