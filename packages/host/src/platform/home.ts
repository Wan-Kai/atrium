import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Paths inside the Atrium home directory. */
export interface AtriumHome {
  readonly root: string;
  readonly logs: string;
}

/**
 * Creates the Atrium home directory and its log folder with owner-only permissions.
 *
 * @remarks
 * `~/.atrium` holds the index and logs; security.md ("凭据与日志") requires mode `0700` so other
 * local users cannot read them. `chmod` runs even when the folders exist, to repair looser modes.
 *
 * @sideEffects Creates directories and changes their permissions.
 * @param root - Home directory path, normally `~/.atrium`.
 * @returns The resolved paths.
 */
export async function ensureAtriumHome(root: string): Promise<AtriumHome> {
  const logs = join(root, "logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(logs, 0o700);
  return { root, logs };
}
