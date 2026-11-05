import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The Unicode spaces pi turns into plain ones in a path (pi's `UNICODE_SPACES`). */
const UNICODE_SPACES = /[  -   　]/g;

/** The tools whose `path` the guard checks. */
const GUARDED_TOOLS: readonly string[] = ["edit", "write"];

/**
 * What the model is told when a write is blocked.
 *
 * @remarks
 * SPEC-0006, "路径隔离": one reason for every refusal, so the model does not learn which step caught it.
 *
 * @sideEffects none
 * @param cwd - The working directory.
 * @returns The reason.
 */
export function outsideReason(cwd: string): string {
  return `Only files inside ${cwd} can be changed.`;
}

/**
 * Turns the path the model wrote into an absolute one, the way pi's own `edit` and `write` do.
 *
 * @remarks
 * Step 1 of SPEC-0006's algorithm. The `tool_call` hook gets the path as the model wrote it, so the
 * guard has to apply `resolveToCwd`'s rules itself, in pi's order: Unicode spaces become plain
 * ones, a leading `@` goes, `~` and `~/` expand to the home directory, `file://` becomes a path,
 * and a relative path is taken from `cwd`. The contract test `task-resolve-to-cwd` pins these rules to pi.
 *
 * @sideEffects none
 * @param input - The path as written.
 * @param cwd - The working directory.
 * @param home - The home directory `~` stands for.
 * @returns The absolute path, not yet resolved through links.
 */
export function resolveWritten(input: string, cwd: string, home: string): string {
  let path = input.replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = home;
  else if (path.startsWith("~/")) path = join(home, path.slice(2));
  if (path.startsWith("file://")) path = fileURLToPath(path);
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/**
 * The real location of a path that may not exist yet.
 *
 * @remarks
 * Step 2. An existing path is `realpath`ed; a missing one takes its deepest existing ancestor's real
 * path plus the missing rest; a dangling symbolic link counts as what it points at, since writing
 * through it creates the target. Anything it cannot tell (a loop, which the system stops after a few
 * dozen links, or no permission) gives `null`, which the guard treats as outside.
 *
 * @sideEffects Reads the file system.
 * @param path - An absolute path.
 * @returns The real path, or `null` when it cannot be worked out.
 */
export function realLocation(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
    if (code !== "ENOENT" && code !== "ENOTDIR") return null;
  }
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return realLocation(resolve(dirname(path), readlinkSync(path)));
    }
  } catch {
    // Nothing there at all: go up to what exists.
  }
  const parent = dirname(path);
  if (parent === path) return null;
  const real = realLocation(parent);
  return real === null ? null : join(real, basename(path));
}

/** Whether a write is allowed, and if not, what to tell the model. */
export type WriteVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * Whether `edit` or `write` may change the path the model gave.
 *
 * @remarks
 * SPEC-0006, "路径隔离": the real path must lie under the real working directory, and the first
 * segment below it must not be `.git` (in a worktree `.git` is a file pointing at the main
 * repository; changing it would send later git commands elsewhere). `.git` is compared without
 * regard to case because the volumes macOS uses fold case. This is not a sandbox: `bash` writes are
 * not seen (security.md).
 *
 * @sideEffects Reads the file system.
 * @param input - The path as the model wrote it.
 * @param cwd - The working directory.
 * @param home - The home directory `~` stands for; defaults to the process's.
 * @returns The verdict.
 */
export function checkWrite(input: string, cwd: string, home: string = homedir()): WriteVerdict {
  const refused = { allowed: false, reason: outsideReason(cwd) } as const;
  const root = realLocation(resolve(cwd));
  const target = realLocation(resolveWritten(input, cwd, home));
  if (root === null || target === null) return refused;
  const below = relative(root, target);
  if (below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) return refused;
  if (below.split(sep)[0]?.toLowerCase() === ".git") return refused;
  return { allowed: true };
}

/** The part of pi's extension API the guard uses. */
export interface PathGuardApi {
  on(
    event: "tool_call",
    handler: (
      event: { readonly toolName: string; readonly input: unknown },
      ctx: { readonly cwd: string },
    ) => { block: true; reason: string } | undefined,
  ): unknown;
}

/**
 * Registers the `tool_call` hook that keeps `edit` and `write` inside the working directory.
 *
 * @remarks
 * SPEC-0006, "路径隔离"; a task node reuses it with its own switch. `isOn` is asked at every call,
 * because pi hands the extension its flags only after loading. Without the switch (pi in a terminal,
 * the main conversation, a conversation the user opened) the hook lets everything through.
 *
 * @sideEffects Registers a `tool_call` hook with pi.
 * @param pi - pi's extension API.
 * @param isOn - Whether this session is isolated.
 */
export function guardPaths(pi: PathGuardApi, isOn: () => boolean): void {
  pi.on("tool_call", (event, ctx) => {
    if (!GUARDED_TOOLS.includes(event.toolName) || !isOn()) return undefined;
    const path: unknown =
      typeof event.input === "object" && event.input !== null ? Reflect.get(event.input, "path") : undefined;
    if (typeof path !== "string") return undefined;
    const verdict = checkWrite(path, ctx.cwd);
    return verdict.allowed ? undefined : { block: true, reason: verdict.reason };
  });
}
