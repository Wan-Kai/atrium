import { acquirePiSettingsLock, agentDirectory, isPiConfigValid, type PiSettingsLock } from "@atrium/pi";
import {
  CommandError,
  PI_CONFIG_MAX_BYTES,
  PiConfigName,
  PI_PROJECT_CONFIG_NAMES,
  type PiConfigFile,
} from "@atrium/protocol";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

/** Only ordinary pi configuration, never credential files. */
export interface PiConfig {
  /** Reads a bounded ordinary file, or the missing-file default. */
  read(workspaceId: string | null, name: PiConfigName): Promise<PiConfigFile>;
  /** Saves an explicitly edited JSON object after checking its revision. */
  save(workspaceId: string | null, name: PiConfigName, text: string, revision: string | null): Promise<PiConfigFile>;
}

const MAX_BYTES = PI_CONFIG_MAX_BYTES;
const NAMES = new Set<string>(PiConfigName.options);

/** Identifies an OS failure without exposing its message.
 * @remarks Filesystem messages may contain sensitive paths.
 * @sideEffects none
 * @param error - The caught failure.
 */
function codeOf(error: unknown): unknown {
  // Mutation equivalence (four loosened type/null guards): Node filesystem rejections are Error objects.
  // Primitive/null input can only come from an invalid filesystem replacement; the outer boundary still maps its failure.
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
}

/** Hashes the exact file bytes used for optimistic concurrency.
 * @remarks Whitespace-only edits also invalidate a revision.
 * @sideEffects none
 * @param bytes - Exact file bytes.
 */
function revisionOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Checks or creates each directory without accepting links.
 * @remarks Recursive mkdir alone follows symlinks, including credential-directory aliases.
 * @sideEffects Reads directory metadata and optionally creates missing directories.
 * @param path - Absolute directory path.
 * @param create - Whether explicit save may create missing directories.
 * @param existingRoot - Existing scope ancestor which must never be recreated.
 * @param missingRootCode - Error for a scope ancestor disappearing.
 */
async function directories(
  path: string,
  create: boolean,
  existingRoot?: string,
  missingRootCode: "workspace_not_found" | "path_invalid" = "workspace_not_found",
): Promise<Stats | null> {
  const root = parse(path).root;
  let current = root;
  let last: Stats | null = await lstat(root);
  // Mutation equivalence: removing slice keeps only a leading empty component, removed by filter.
  // Removing filter adds at most another metadata read of the same root for normalized absolute paths.
  for (const part of path.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    try {
      last = await lstat(current);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
      if (!create) return null;
      if (existingRoot !== undefined && (current === existingRoot || !current.startsWith(join(existingRoot, "/"))))
        throw new CommandError(missingRootCode);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (failure) {
        if (codeOf(failure) !== "EEXIST") throw failure;
      }
      last = await lstat(current);
    }
    if (!last.isDirectory() || last.isSymbolicLink()) throw new CommandError("path_invalid");
  }
  return last;
}

/** Reads one bounded regular file with no symlink or hardlink aliases.
 * @remarks Both metadata and content come from one nonblocking, no-follow handle.
 * @sideEffects Opens, reads and closes a file.
 * @param path - Allowlisted absolute file path.
 */
async function readTarget(path: string): Promise<PiConfigFile> {
  const parent = await directories(dirname(path), false);
  if (parent === null) return { path, text: "{}\n", revision: null };
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { path, text: "{}\n", revision: null };
    if (["ELOOP", "EMLINK", "ENXIO", "ENODEV"].includes(String(codeOf(error)))) throw new CommandError("path_invalid");
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new CommandError("path_invalid");
    if (info.size > MAX_BYTES) throw new CommandError("config_too_large");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    // Mutation equivalence: <= adds only a zero-length read when full; it returns zero and the same size guard rejects.
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_BYTES) throw new CommandError("config_too_large");
    const after = await directories(dirname(path), false);
    if (after === null) throw new CommandError("path_invalid");
    const target = await lstat(path);
    if (
      after.dev !== parent.dev ||
      after.ino !== parent.ino ||
      target.dev !== info.dev ||
      target.ino !== info.ino ||
      target.nlink !== 1
    )
      throw new CommandError("path_invalid");
    const content = bytes.subarray(0, length);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      throw new CommandError("config_encoding");
    }
    return { path, text, revision: revisionOf(content) };
  } finally {
    await file.close();
  }
}

/** Resolves a trusted global directory through links, including missing descendants.
 * @remarks pi follows the configured agent directory; only the final config file must not be an alias.
 * @sideEffects Reads canonical filesystem paths.
 * @param path - Configured absolute directory.
 */
async function canonicalDirectory(path: string): Promise<{ path: string; existingRoot: string; identity: Stats }> {
  try {
    const canonical = await realpath(path);
    const identity = await lstat(canonical);
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new CommandError("path_invalid");
    return { path: canonical, existingRoot: canonical, identity };
  } catch (error) {
    if (codeOf(error) === "ENOTDIR") throw new CommandError("path_invalid");
    if (codeOf(error) !== "ENOENT" || dirname(path) === path) throw error;
    const ancestor = await canonicalDirectory(dirname(path));
    return { ...ancestor, path: join(ancestor.path, basename(path)) };
  }
}

/** Creates the ordinary pi config editor.
 * @remarks No pi process is started, no schema values are executed, and failures contain only codes.
 * Saves sharing a path are serialized within this host; external edits are checked before rename.
 * @sideEffects none until called; then reads or atomically replaces explicitly selected files.
 * @param options - pi's current environment and workspace directory lookup.
 */
export function createPiConfig(options: {
  readonly environment: () => Promise<Readonly<Record<string, string | undefined>>>;
  readonly dirOf: (workspaceId: string) => string | undefined;
}): PiConfig {
  const saves = new Map<string, Promise<void>>();

  /** Resolves only allowlisted names in the selected scope.
   * @remarks Runtime validation also protects callers bypassing protocol types.
   * @sideEffects Reads the current pi environment.
   * @param workspaceId - Project scope, or null for global.
   * @param name - Ordinary configuration filename.
   */
  async function locate(
    workspaceId: string | null,
    name: PiConfigName,
  ): Promise<{
    path: string;
    existingRoot: string;
    missingRootCode: "workspace_not_found" | "path_invalid";
    check: () => Promise<void>;
  }> {
    if (!NAMES.has(name) || (workspaceId !== null && !PI_PROJECT_CONFIG_NAMES.includes(name)))
      throw new CommandError("path_invalid");
    if (workspaceId !== null) {
      const dir = options.dirOf(workspaceId);
      if (dir === undefined) throw new CommandError("workspace_not_found");
      const root = resolve(dir);
      const initial = await directories(root, false);
      if (initial === null) throw new CommandError("workspace_not_found");
      return {
        path: join(root, ".pi", name),
        existingRoot: root,
        missingRootCode: "workspace_not_found",
        check: async () => {
          if (options.dirOf(workspaceId) !== dir) throw new CommandError("workspace_not_found");
          const current = await directories(root, false);
          if (current === null) throw new CommandError("workspace_not_found");
          if (current.dev !== initial.dev || current.ino !== initial.ino) throw new CommandError("path_invalid");
        },
      };
    }
    let env: Readonly<Record<string, string | undefined>>;
    try {
      env = await options.environment();
    } catch {
      throw new CommandError("config_unavailable");
    }
    const dir = agentDirectory(env);
    if (!isAbsolute(dir)) throw new CommandError("path_invalid");
    const configured = resolve(dir);
    const canonical = await canonicalDirectory(configured);
    return {
      path: join(canonical.path, name),
      existingRoot: canonical.existingRoot,
      missingRootCode: "path_invalid",
      check: async () => {
        if ((await canonicalDirectory(configured)).path !== canonical.path) throw new CommandError("path_invalid");
        let current: Stats;
        try {
          current = await lstat(canonical.existingRoot);
        } catch (error) {
          if (codeOf(error) === "ENOENT") throw new CommandError("path_invalid");
          throw error;
        }
        if (
          current.dev !== canonical.identity.dev ||
          current.ino !== canonical.identity.ino ||
          current.isSymbolicLink()
        )
          throw new CommandError("path_invalid");
      },
    };
  }

  return {
    read: async (workspaceId, name) => {
      try {
        const location = await locate(workspaceId, name);
        try {
          const result = await readTarget(location.path);
          await location.check();
          return result;
        } catch (error) {
          await location.check();
          throw error;
        }
      } catch (error) {
        throw error instanceof CommandError ? error : new CommandError("read_failed");
      }
    },
    save: async (workspaceId, name, text, revision) => {
      try {
        const location = await locate(workspaceId, name);
        const { path } = location;
        // Mutation equivalence for this encoding, writeFile below, and Buffer.from at return:
        // Node treats the mutated empty-string encoding as the same UTF-8 default.
        if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new CommandError("config_too_large");
        if (!isPiConfigValid(name, text)) throw new CommandError("config_invalid");
        const previous = saves.get(path) ?? Promise.resolve();
        const { promise: pending, resolve: release } = Promise.withResolvers<void>();
        saves.set(path, pending);
        await previous;
        let lock: PiSettingsLock | undefined;
        try {
          await location.check();
          // Do not create directories for stale revisions or unsafe existing targets.
          const before = await readTarget(path);
          if (before.revision !== revision) throw new CommandError("config_conflict");
          await location.check();
          const parent = await directories(dirname(path), true, location.existingRoot, location.missingRootCode);
          if (name === "settings.json") {
            lock = await acquirePiSettingsLock(path);
            const locked = await readTarget(path);
            if (locked.revision !== revision) throw new CommandError("config_conflict");
          }
          const temporary = join(dirname(path), `.atrium-config-${randomUUID()}.tmp`);
          let renamed = false;
          try {
            await location.check();
            const file = await open(
              temporary,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
            try {
              await file.writeFile(text, "utf8");
              await file.sync();
            } finally {
              await file.close();
            }
            const current = await readTarget(path);
            const after = await directories(dirname(path), false);
            // Mutation equivalence: directories(create=true) cannot return null, so both parent ?. are redundant.
            // after?.ino is also redundant: a null after already fails the preceding device comparison.
            if (after?.dev !== parent?.dev || after?.ino !== parent?.ino) throw new CommandError("path_invalid");
            if (current.revision !== revision) throw new CommandError("config_conflict");
            await location.check();
            lock?.check();
            await rename(temporary, path);
            renamed = true;
          } finally {
            if (!renamed)
              await unlink(temporary).catch((error: unknown) => {
                if (codeOf(error) !== "ENOENT") throw error;
              });
          }
          return { path, text, revision: revisionOf(Buffer.from(text, "utf8")) };
        } catch (error) {
          await location.check();
          throw error;
        } finally {
          try {
            await lock?.release();
          } finally {
            release();
            // Coverage limitation: omission of delete retains settled per-path entries. Ordering tests cannot
            // observe this resource-only leak without inspecting private state; do not suppress those mutants.
            if (saves.get(path) === pending) saves.delete(path);
          }
        }
      } catch (error) {
        if (codeOf(error) === "ELOCKED" || codeOf(error) === "ECOMPROMISED") throw new CommandError("config_conflict");
        throw error instanceof CommandError ? error : new CommandError("read_failed");
      }
    },
  };
}
