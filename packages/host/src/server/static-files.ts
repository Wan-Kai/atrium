import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/**
 * Content Security Policy for pages the host serves.
 *
 * @remarks
 * Scripts only from the app itself and no `eval` (security.md, "Electron"); styles allow inline
 * because React writes `style` attributes; remote images stay blocked until the UI loads them on
 * request (security.md, "渲染内容").
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Maps a request path to a file inside `root`, refusing anything that would escape it.
 *
 * @remarks
 * The host serves the UI from disk to any local page that can reach its port, so path traversal
 * (`..`, encoded separators, NUL) must never reach the file system (security.md, "子进程与文件").
 * Paths without an extension fall back to `index.html` because the UI is a single page.
 *
 * @sideEffects none
 * @param root - Absolute directory the UI is served from.
 * @param requestUrl - The raw request URL, including any query string.
 * @returns An absolute file path inside `root`, or `null` when the path is not allowed.
 */
export function resolveStaticPath(root: string, requestUrl: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://host.invalid").pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  const relative = pathname.endsWith("/") || extname(pathname) === "" ? "/index.html" : pathname;
  const absolute = resolve(root, `.${relative}`);
  return absolute.startsWith(root.endsWith(sep) ? root : root + sep) ? absolute : null;
}

/**
 * Serves one GET or HEAD request for a UI file.
 *
 * @remarks
 * Every response carries the CSP and `nosniff`; `index.html` is never cached so an updated host
 * always serves a matching UI.
 *
 * @sideEffects Reads a file and writes the HTTP response.
 * @param request - Incoming request.
 * @param response - Response to write.
 * @param root - Absolute directory the UI is served from.
 */
export async function serveStatic(request: IncomingMessage, response: ServerResponse, root: string): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const file = resolveStaticPath(root, request.url ?? "/");
  // Stryker disable next-line ConditionalExpression: stat(null) rejects and lands in the same catch; the check states the intent.
  const info = file === null ? null : await stat(file).catch(() => null);
  if (file === null || info === null || !info.isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  // Stryker disable next-line ConditionalExpression,BlockStatement: Node drops the body of HEAD responses itself; ending early only skips reading the file.
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}
