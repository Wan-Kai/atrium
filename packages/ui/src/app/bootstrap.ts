/** Connection details the desktop shell hands to the page. */
export interface Bootstrap {
  /** Host origin, such as `http://127.0.0.1:4317`. */
  readonly hostUrl: string;
  readonly token: string;
}

/** What the desktop preload exposes on `window.atrium`. */
interface AtriumBridge {
  getBootstrap(): Promise<Bootstrap>;
  pickDirectory?(): Promise<string | null>;
  setAppearance?(appearance: "system" | "light" | "dark"): Promise<void>;
}

/**
 * The desktop bridge, when the page runs inside the app.
 *
 * @remarks
 * Outside Electron (browser tests, a future PWA) there is none.
 *
 * @sideEffects none
 * @returns The bridge, or `undefined`.
 */
export function desktopBridge(): AtriumBridge | undefined {
  return (window as Window & { atrium?: AtriumBridge }).atrium;
}

/**
 * Asks the desktop shell for the host address and token.
 *
 * @remarks
 * The token comes through the preload bridge at runtime, never through the URL or a file
 * (security.md, "WebSocket 与鉴权"). Outside Electron there is no bridge yet; the PWA path comes
 * later.
 *
 * @sideEffects Calls into the preload bridge, which asks the main process over IPC.
 * @returns The bootstrap data, or `null` when not running inside the desktop app.
 */
export async function readBootstrap(): Promise<Bootstrap | null> {
  const bridge = desktopBridge();
  return bridge === undefined ? null : bridge.getBootstrap();
}

/**
 * Returns this browser profile's client id, creating it on first use.
 *
 * @remarks
 * The host keeps per-client layout (open tabs) keyed by this id (domain-model.md, "客户端与一致性"),
 * so it must survive reloads.
 *
 * @sideEffects Reads, and on first use writes, `localStorage`.
 * @param storage - Storage to keep the id in.
 * @returns The client id.
 */
export function clientId(storage: Storage): string {
  const key = "atrium.clientId";
  const existing = storage.getItem(key);
  if (existing !== null) return existing;
  const created = crypto.randomUUID();
  storage.setItem(key, created);
  return created;
}
