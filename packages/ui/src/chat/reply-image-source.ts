/** A reply image's allowed destination, or why no address may be loaded. */
export type ReplyImageSource =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "remote" | "link"; readonly src: string }
  | { readonly kind: "blocked" };

/** Resolves Markdown image URLs without letting a local path reach the app's static server.
 * @remarks SPEC-0001, "回复渲染": files stay in the current workspace, with no traversal or
 * unknown schemes. The host still owns symlink, content-type and byte-limit enforcement.
 * File URLs are inspected before URL normalization, which would otherwise erase `..` segments.
 * @sideEffects none
 * @param source - The Markdown address, before the renderer's default URL filtering.
 * @param workspaceDir - The current workspace root, or null for an unbound chat.
 * @returns The permitted remote address or workspace-relative path.
 */
export function replyImageSource(source: string, workspaceDir: string | null): ReplyImageSource {
  if (/\p{Cc}|\\/u.test(source)) return { kind: "blocked" };
  if (/^https?:\/\//iu.test(source)) {
    try {
      const url = new URL(source);
      if (url.username !== "" || url.password !== "") return { kind: "blocked" };
      return { kind: url.protocol === "https:" ? "remote" : "link", src: source };
    } catch {
      // Mutation review: an empty catch is equivalent because this absolute HTTP(S) address
      // is also refused by the local-path scheme gate below; keep the immediate refusal explicit.
      return { kind: "blocked" };
    }
  }
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/iu.test(source)) return { kind: "remote", src: source };
  if (workspaceDir === null || source.startsWith("//") || /%2f|%5c/iu.test(source)) return { kind: "blocked" };
  let path = source;
  if (/^file:/iu.test(path)) {
    const match = /^file:\/\/(?:localhost)?(\/[^?#]*)$/iu.exec(path);
    if (match?.[1] === undefined) return { kind: "blocked" };
    path = match[1];
  } else if (/^[a-z][a-z0-9+.-]*:/iu.test(path)) return { kind: "blocked" };
  try {
    path = decodeURIComponent(path);
  } catch {
    return { kind: "blocked" };
  }
  if (/\p{Cc}|\\/u.test(path) || path.startsWith("~") || path.split("/").includes("..")) return { kind: "blocked" };
  if (path.startsWith("/")) {
    const root = workspaceDir.replace(/\/+$/u, "");
    if (!path.startsWith(`${root}/`)) return { kind: "blocked" };
    path = path.slice(root.length + 1);
  }
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || path.length > 4096) return { kind: "blocked" };
  return { kind: "local", path: parts.join("/") };
}
