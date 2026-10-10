import type { PiDeps } from "../deps";
import { findExecutable, readVersion } from "./locate";
import { type Version, isAtLeast } from "./version";

/**
 * Oldest Node Atrium accepts for pi and the login program.
 *
 * @remarks
 * The login program is a TypeScript file the system Node runs directly, which needs type stripping
 * without a flag (overview.md, "登录程序的例外"; SPEC-0001, "首次启动 · 接口").
 */
export const MIN_NODE_VERSION: Version = [22, 19, 0];

/** How long `node --version` may take. */
const NODE_VERSION_TIMEOUT_MS = 10_000;

/** What Atrium found when it looked for Node. */
export type NodeInspection =
  | { readonly status: "missing" }
  | { readonly status: "outdated" | "ready"; readonly nodePath: string; readonly version: Version };

/**
 * Finds Node on a search path and checks that it is new enough.
 *
 * @remarks
 * pi's launcher runs on the first `node` on PATH, and so does the login program. A `node` that
 * does not run, does not answer in time or prints no version counts as missing: installing Node
 * with Homebrew is the way out either way (SPEC-0001, "第 1 步：安装 pi").
 *
 * @sideEffects Checks files on disk; runs `node --version`; schedules and cancels a timer.
 * @param searchPath - PATH-style directory list, normally from the login shell.
 * @param options - Base environment (its PATH is replaced), the clock the deadline runs on, an abort
 * signal and the deadline.
 * @returns What was found.
 */
export async function inspectNode(
  searchPath: string,
  options: {
    readonly env: Readonly<Record<string, string>>;
    readonly clock: PiDeps["clock"];
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<NodeInspection> {
  const nodePath = await findExecutable(searchPath, "node");
  if (nodePath === null) return { status: "missing" };
  const deadline = new AbortController();
  const cancel = options.clock.setTimeout(() => deadline.abort(), options.timeoutMs ?? NODE_VERSION_TIMEOUT_MS);
  const signal = options.signal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, options.signal]);
  let version: Version | null;
  try {
    version = await readVersion(nodePath, { env: { ...options.env, PATH: searchPath }, signal });
  } catch {
    return { status: "missing" };
  } finally {
    cancel();
  }
  if (version === null) return { status: "missing" };
  return { status: isAtLeast(version, MIN_NODE_VERSION) ? "ready" : "outdated", nodePath, version };
}
