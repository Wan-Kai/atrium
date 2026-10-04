import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temporary directory owned by one test. */
export interface TempDir {
  readonly path: string;
  /** Deletes the directory and everything in it. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Creates an empty temporary directory.
 *
 * @remarks
 * Tests use real file systems instead of mocks (testing.md, "分层"); each test gets its own
 * directory so runs cannot see each other's files.
 *
 * @sideEffects Creates a directory under the system temp folder.
 * @param prefix - Readable prefix for the directory name.
 * @returns The directory path and a cleanup function.
 */
export async function createTempDir(prefix: string): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), `atrium-${prefix}-`));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
