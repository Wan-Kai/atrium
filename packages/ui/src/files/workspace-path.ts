/**
 * The path, relative to a workspace, of a file a tool was given, if it is in the workspace.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签 · 从对话里打开"): the model passes tools whatever path
 * it likes. A relative one counts from the workspace's directory, where the session runs; an
 * absolute one must be inside that directory. `.` and empty segments go, `..` goes up one; a path
 * that leaves the workspace, starts with `~` (whose home the page does not know) or names the
 * workspace itself is none, as `read_file` takes only a plain relative path.
 *
 * @sideEffects none
 * @param path - The path the tool was given.
 * @param dir - The workspace's directory, absolute.
 * @returns The relative path, or `null`.
 */
export function workspacePath(path: string, dir: string): string | null {
  if (path.startsWith("~")) return null;
  let rest = path;
  if (path.startsWith("/")) {
    const root = dir.replace(/\/+$/u, "");
    if (!path.startsWith(`${root}/`)) return null;
    rest = path.slice(root.length + 1);
  }
  const parts: string[] = [];
  for (const segment of rest.split("/")) {
    if (segment === ".." && parts.length === 0) return null;
    if (segment === "..") parts.pop();
    else if (segment !== "" && segment !== ".") parts.push(segment);
  }
  return parts.length === 0 ? null : parts.join("/");
}
