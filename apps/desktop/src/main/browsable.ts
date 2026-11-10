import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

/** The file that marks a learning direction's folder (SPEC-0008). */
const STUDY_FILE = ".atrium-study.json";

/**
 * Whether the page may open a path in the browser: an absolute path to an HTML file, not a demo.
 *
 * @remarks
 * The page asks for an HTML file shown in a file tab (SPEC-0001, "查看标签"). The file must be a
 * regular file, not a link to somewhere else or a folder; anything else it sends is ignored
 * (security.md, "Electron"). A learning direction's demo never goes: in the browser it runs
 * outside the sandbox and reaches the network (SPEC-0008, "ML4 定的细节 · 从档案打开的演示"). The
 * page already holds them back; this is the second line, for a page that got it wrong.
 *
 * @sideEffects Reads the file system.
 * @param path - The path the page sent.
 * @returns Whether to open it.
 */
export async function isBrowsable(path: string): Promise<boolean> {
  if (!isAbsolute(path) || !/\.html?$/iu.test(path)) return false;
  const regular = await lstat(path).then(
    (found) => found.isFile(),
    () => false,
  );
  return regular && !(await inDirectionVisuals(path));
}

/**
 * Whether a file is somewhere in a learning direction's `visuals/`.
 *
 * @remarks
 * The desktop shell does not know where the learning directory is, so a direction is told by the
 * file that marks it, next to a folder named `visuals` in any case (the Mac's volume does not tell
 * the cases apart). The folders are taken where they really are, so a link to one does not hide it.
 * A folder that cannot be read counts as one: refusing a page is safe.
 *
 * @sideEffects Reads the file system.
 * @param path - An absolute path to a file.
 * @returns Whether.
 */
async function inDirectionVisuals(path: string): Promise<boolean> {
  let dir: string;
  try {
    dir = await realpath(dirname(path));
  } catch {
    return true;
  }
  for (; dirname(dir) !== dir; dir = dirname(dir)) {
    if (basename(dir).toLowerCase() !== "visuals") continue;
    const marked = await lstat(join(dirname(dir), STUDY_FILE)).then(
      () => true,
      () => false,
    );
    if (marked) return true;
  }
  return false;
}
