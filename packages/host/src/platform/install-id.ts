import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorCode } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the install id, or `null` when there is none or the file holds something else.
 *
 * @remarks
 * See {@link readInstallSeed}.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @returns The id.
 * @throws When the file cannot be read for another reason than not being there.
 */
async function readId(path: string): Promise<string | null> {
  try {
    const id = (await readFile(path, "utf8")).trim();
    return UUID.test(id) ? id : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * The seed of this install's dot pattern, from the install id in the Atrium home.
 *
 * @remarks
 * The welcome page's button and a full model button draw dots that differ from install to install
 * and stay the same for each (SPEC-0001, "首次启动 · 接口"; design-language, "点阵"). The id is a
 * UUID made the first time, or when the file holds something else, written whole through a
 * temporary file; the host lock keeps a second host from writing it at the same time. The seed is
 * the id's first seven hex digits plus one, a positive integer.
 *
 * @sideEffects Reads `install-id` in the home; writes it when missing or damaged.
 * @param home - The Atrium home, normally `~/.atrium`.
 * @param newId - Makes a new UUID.
 * @returns The seed.
 * @throws When the file cannot be read or written.
 */
export async function readInstallSeed(home: string, newId: () => string): Promise<number> {
  const path = join(home, "install-id");
  let id = await readId(path);
  if (id === null) {
    id = newId();
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${id}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }
  return Number.parseInt(id.slice(0, 7), 16) + 1;
}
