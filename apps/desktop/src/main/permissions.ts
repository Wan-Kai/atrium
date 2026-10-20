/** The one permission the app's page gets: writing the clipboard, for the copy buttons. */
const PAGE_PERMISSIONS: ReadonlySet<string> = new Set(["clipboard-sanitized-write"]);

/**
 * Whether a URL belongs to the app's page.
 *
 * @remarks
 * Compares scheme and host (with port), not `URL.origin`: Node gives every URL of a scheme it does
 * not know, `atrium:` included, the origin `"null"`, so all opaque origins would compare equal
 * (security.md, "Electron").
 *
 * @sideEffects none
 * @param url - The URL to check.
 * @param pageUrl - The page's URL.
 * @returns Whether it is the page's.
 */
export function isPageUrl(url: string, pageUrl: string): boolean {
  try {
    const candidate = new URL(url);
    const page = new URL(pageUrl);
    return candidate.protocol === page.protocol && candidate.host === page.host;
  } catch {
    return false;
  }
}

/**
 * Whether the window may have a permission it asks for.
 *
 * @remarks
 * security.md ("Electron"): every request is refused but the app's own page writing the
 * clipboard, which `navigator.clipboard.writeText` asks for; reading it stays refused.
 *
 * @sideEffects none
 * @param permission - Electron's name for it.
 * @param requestingUrl - The URL of the frame asking.
 * @param pageUrl - The app's page.
 * @returns Whether to grant it.
 */
export function allowsPermission(permission: string, requestingUrl: string, pageUrl: string): boolean {
  return PAGE_PERMISSIONS.has(permission) && isPageUrl(requestingUrl, pageUrl);
}
