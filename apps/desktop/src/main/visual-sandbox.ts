/** The scheme inline visuals load from, one origin per token (SPEC-0007, "沙箱"). */
export const VISUAL_SCHEME = "atrium-visual";

/**
 * The sites a visual may load libraries and fonts from (SPEC-0007, "沙箱", 2026-11-05).
 *
 * @remarks
 * The host's CSP and the extension's prompt list the same sites; the four code sites are held to
 * pinned versions here.
 */
export const VISUAL_CDN_HOSTS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://esm.sh",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
] as const;

/** A full version: `x.y.z`, with an optional pre-release or build. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/**
 * A GitHub tag or commit for jsDelivr's `/gh/`: a full version, `v` in front or not, or a whole
 * 40-digit commit; a short one may as well be a branch's name (MV1 review).
 */
const GIT_VERSION = /^(?:v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[0-9a-f]{40})$/u;

/** esm.sh's own stand-ins for Node's modules, `/node/<name>.mjs`, which no package's version moves. */
const ESM_NODE = /^\/node\/[a-z0-9_]+\.mjs$/u;

/**
 * The Content Security Policy every `atrium-visual:` response carries.
 *
 * @remarks
 * SPEC-0007 ("沙箱") as written, without `'unsafe-eval'`, plus `sandbox allow-scripts` so the page
 * stays an opaque origin wherever it is opened (security.md, "渲染内容"). The main process sets it
 * itself rather than trusting the host's header.
 *
 * @sideEffects none
 * @returns The policy.
 */
export function visualContentSecurityPolicy(): string {
  const cdn = VISUAL_CDN_HOSTS.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${cdn} ${VISUAL_SCHEME}:`,
    `style-src 'unsafe-inline' ${cdn} ${VISUAL_SCHEME}:`,
    `img-src data: blob: ${cdn}`,
    `font-src data: ${cdn} ${VISUAL_SCHEME}:`,
    "media-src data: blob:",
    "worker-src blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "sandbox allow-scripts",
  ].join("; ");
}

/**
 * Whether a package segment, `name@version` or the version alone, has a full version.
 *
 * @remarks
 * See `isPinnedCdnUrl`.
 *
 * @sideEffects none
 * @param segment - The path segment holding the package and its version.
 * @returns Whether it is pinned.
 */
function pinnedPackage(segment: string | undefined): boolean {
  if (segment === undefined) return false;
  const at = segment.lastIndexOf("@");
  return at > 0 && VERSION.test(segment.slice(at + 1));
}

/**
 * The package segment of an npm-style path: `pkg@v` or, scoped, `@scope` then `pkg@v`.
 *
 * @remarks
 * See `isPinnedCdnUrl`.
 *
 * @sideEffects none
 * @param segments - The path's segments from the package on.
 * @returns The segment holding the version.
 */
function packageSegment(segments: readonly string[]): string | undefined {
  // Stryker disable next-line OptionalChaining: a path's split always has a first segment.
  return segments[0]?.startsWith("@") === true ? segments[1] : segments[0];
}

/**
 * Whether a CDN address is one a visual may load: a pinned version on a code site, any font.
 *
 * @remarks
 * SPEC-0007 ("沙箱"): CSP cannot see a version in a path, so each site's rule is checked here.
 * jsDelivr `/npm/<pkg>@<x.y.z>/…` and `/gh/<user>/<repo>@<version>/…`; unpkg `/<pkg>@<x.y.z>/…`;
 * esm.sh the package named in the path, after an optional build prefix such as `/v135/`, which
 * covers the pinned dependencies esm.sh imports itself; cdnjs `/ajax/libs/<name>/<x.y.z>/…`. The
 * two font sites carry no version and pass. Only https on the default port, without credentials.
 *
 * @sideEffects none
 * @param url - The address.
 * @returns Whether to let it through.
 */
export function isPinnedCdnUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false;
  const segments = url.pathname.split("/").slice(1);
  switch (url.hostname) {
    case "fonts.googleapis.com":
    case "fonts.gstatic.com":
      return true;
    case "cdn.jsdelivr.net":
      if (segments[0] === "npm") return pinnedPackage(packageSegment(segments.slice(1)));
      if (segments[0] === "gh") {
        // Stryker disable next-line StringLiteral: a missing repository has no `@`, as any other text without one.
        const repo = segments[2] ?? "";
        const at = repo.lastIndexOf("@");
        return segments[1] !== undefined && at > 0 && GIT_VERSION.test(repo.slice(at + 1));
      }
      return false;
    case "unpkg.com":
      return pinnedPackage(packageSegment(segments));
    case "esm.sh":
      if (ESM_NODE.test(url.pathname)) return true;
      // Stryker disable next-line StringLiteral: a path's split always has a first segment.
      return pinnedPackage(packageSegment(/^(?:v\d+|stable)$/u.test(segments[0] ?? "") ? segments.slice(1) : segments));
    case "cdnjs.cloudflare.com":
      return segments[0] === "ajax" && segments[1] === "libs" && segments[2] !== "" && VERSION.test(segments[3] ?? "");
    default:
      return false;
  }
}

/**
 * Who made a request, as `webRequest` tells: the app's page, a frame inside it (and whether the
 * request navigates that frame), or no frame.
 */
export type RequestFrame =
  | { readonly kind: "page" }
  | { readonly kind: "subframe"; readonly navigation: boolean }
  | { readonly kind: "none" };

/** The CDN sites by host name. */
const CDN_HOSTNAMES: ReadonlySet<string> = new Set(VISUAL_CDN_HOSTS.map((host) => new URL(host).hostname));

/**
 * An address's scheme and host, as the app's origins are written: `atrium://app`, `http://127.0.0.1:4000`.
 *
 * @remarks
 * `URL.origin` is `null` for a scheme Node does not know, as `atrium:`; this is not.
 *
 * @sideEffects none
 * @param url - The address.
 * @returns Its scheme and host.
 */
function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/**
 * Whether a visual may load an address: its own scheme, `data:`, `blob:` or a pinned CDN one.
 *
 * @remarks
 * SPEC-0007, MV1 details.
 *
 * @sideEffects none
 * @param url - The address.
 * @returns Whether it may.
 */
function visualMayLoad(url: URL): boolean {
  if (url.protocol === `${VISUAL_SCHEME}:` || url.protocol === "data:" || url.protocol === "blob:") return true;
  return CDN_HOSTNAMES.has(url.hostname) && isPinnedCdnUrl(url);
}

/**
 * Whether a request may go out, by who made it.
 *
 * @remarks
 * SPEC-0007, MV1 details: an iframe shares its page's session, so instead of a session of its own
 * a visual's requests are told by their frame. The app's page itself is left alone. A frame inside
 * it — only visuals are — may load its own scheme, `data:`, `blob:` and pinned CDN addresses,
 * nothing else; it may navigate only to its own scheme, so it never leaves the visual's CSP for a
 * page of the CDN (MV1 review). A request of no frame is the main process's own or a worker's, the
 * app's or a visual's, which cannot be told apart: it may reach the app's own origins, and what a
 * visual may load, nothing else (MV1 three-way review). Each hop of a redirect comes here again.
 *
 * @sideEffects none
 * @param url - The address asked for.
 * @param frame - Who asked.
 * @param apps - The app's own origins: its page's and the host's, as `scheme://host`.
 * @returns Whether to let it through.
 */
export function visualRequestAllowed(url: string, frame: RequestFrame, apps: readonly string[]): boolean {
  if (frame.kind === "page") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (frame.kind === "none") return apps.includes(originOf(parsed)) || visualMayLoad(parsed);
  if (frame.navigation) return parsed.protocol === `${VISUAL_SCHEME}:`;
  return visualMayLoad(parsed);
}

/** A visual's address: a 32-character lowercase hex token and one file name. */
const VISUAL_ADDRESS = /^\/([^/]+)$/u;

/**
 * The host's path for a visual's address, or `null` for any other address.
 *
 * @remarks
 * The token is the address's host; the host serves `/visual/<token>/<name>` and checks the token
 * itself. Anything else, such as a nested path, never reaches it.
 *
 * @sideEffects none
 * @param url - The `atrium-visual:` address.
 * @returns The path to ask the host for, or `null`.
 */
export function visualHostPath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${VISUAL_SCHEME}:` || !/^[0-9a-f]{32}$/u.test(parsed.hostname)) return null;
  const name = VISUAL_ADDRESS.exec(parsed.pathname)?.[1];
  return name === undefined ? null : `/visual/${parsed.hostname}/${name}`;
}

/** A rectangle of the window's page, in CSS pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The rectangle the page asked to capture, if it is one inside the window.
 *
 * @remarks
 * The page asks for a visual's snapshot (SPEC-0007, "截图怎么截"); anything that is not a finite,
 * non-empty rectangle within the window's content is refused (security.md, "Electron").
 *
 * @sideEffects none
 * @param value - What the page sent.
 * @param bounds - The window's content size.
 * @returns The rectangle in whole pixels, or `null`.
 */
export function captureRect(value: unknown, bounds: { readonly width: number; readonly height: number }): Rect | null {
  if (typeof value !== "object" || value === null) return null;
  const parts = ["x", "y", "width", "height"].map((key): unknown => Reflect.get(value, key));
  const numbers = parts.filter((part): part is number => typeof part === "number" && Number.isFinite(part));
  const [x = 0, y = 0, width = 0, height = 0] = numbers.map((part) => Math.round(part));
  if (numbers.length !== 4) return null;
  const rect = { x, y, width, height };
  if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) return null;
  if (rect.x + rect.width > bounds.width || rect.y + rect.height > bounds.height) return null;
  return rect;
}
