import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

/** Paths inside the Atrium home directory. */
export interface AtriumHome {
  readonly root: string;
  readonly logs: string;
  /** Set when an existing directory is readable by other users; the host logs it as a warning. */
  readonly looseModes: readonly string[];
}

/**
 * Creates the Atrium home directory and its log folder with owner-only permissions.
 *
 * @remarks
 * `~/.atrium` holds the index and logs; security.md ("凭据与日志") requires mode `0700` so other
 * local users cannot read them. Directories are created with that mode, but existing ones are
 * never changed: `ATRIUM_HOME` could point at a shared directory such as `/tmp`, and changing its
 * mode would break it for everyone. Loose modes on existing directories are reported instead.
 * The paths are real ones: pi names a directory's session folder by its real path, so a chat's
 * folder is found only when the home is named the same way (a temporary directory on macOS is
 * under the symlink `/var`).
 *
 * @sideEffects Creates missing directories.
 * @param path - Home directory path, normally `~/.atrium`.
 * @returns The real paths and any existing directories whose mode is looser than `0700`.
 */
export async function ensureAtriumHome(path: string): Promise<AtriumHome> {
  await mkdir(join(path, "logs"), { recursive: true, mode: 0o700 });
  const root = await realpath(path);
  const logs = join(root, "logs");
  const looseModes: string[] = [];
  for (const directory of [root, logs]) {
    if (((await stat(directory)).mode & 0o077) !== 0) looseModes.push(directory);
  }
  return { root, logs, looseModes };
}
