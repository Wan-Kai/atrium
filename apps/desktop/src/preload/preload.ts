import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * The only API the page gets from the desktop shell.
 *
 * @remarks
 * The renderer is sandboxed without Node (security.md, "Electron"), so this bridge is its sole
 * way to learn the host address and token, to have the user choose a project folder, to set
 * the window's appearance, to learn the path of a file dropped on the input box, to show a path in
 * the Finder, to open an HTML file in the browser, to open a terminal and to capture a visual's
 * snapshot; nothing else from Electron is exposed.
 */
const bridge = {
  /** Asks the main process for the host URL and session token. */
  getBootstrap: (): Promise<{ hostUrl: string; token: string }> => ipcRenderer.invoke("atrium:bootstrap"),
  /** Asks the user to choose a folder; resolves with its path, or `null` when cancelled. */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("atrium:pick-directory"),
  /**
   * Makes the window's own parts (title bar, vibrancy) follow the appearance the user chose.
   *
   * @remarks
   * The main process accepts only the three appearances.
   *
   * @sideEffects Sends an IPC message.
   * @param appearance - The appearance.
   * @returns When the main process has applied it.
   */
  setAppearance: (appearance: "system" | "light" | "dark"): Promise<void> =>
    ipcRenderer.invoke("atrium:appearance", appearance),
  /**
   * The path of a file the user dropped on the page.
   *
   * @remarks
   * Only a file the user handed to the page has one; the page names it as a reference in a
   * message (SPEC-0001, "输入框").
   *
   * @sideEffects none
   * @param file - The dropped file.
   * @returns Its path, or `""` for one that is not on disk.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke("atrium:reveal", path),
  /**
   * Opens an HTML file in the default browser.
   *
   * @remarks
   * The main process accepts only an absolute path to a regular `.html` or `.htm` file.
   *
   * @sideEffects Sends an IPC message.
   * @param path - The file's absolute path.
   * @returns When the main process has handed it on.
   */
  openInBrowser: (path: string): Promise<void> => ipcRenderer.invoke("atrium:open-in-browser", path),
  /**
   * Opens a terminal in a workspace's directory, or in the home folder for `null`.
   *
   * @remarks
   * The main process accepts only `null` or an absolute path to a folder that exists
   * (SPEC-0001, "在终端中打开").
   *
   * @sideEffects Sends an IPC message.
   * @param dir - The directory, or `null` for the home folder.
   * @returns When the terminal has been asked for.
   */
  openTerminal: (dir: string | null): Promise<void> => ipcRenderer.invoke("atrium:open-terminal", dir),
  /**
   * Captures a rectangle of the page as a PNG `data:` address, for a visual's snapshot.
   *
   * @remarks
   * SPEC-0007 ("截图怎么截"): the main process takes only a rectangle inside the window, and the
   * image stays in the page's memory.
   *
   * @sideEffects Sends an IPC message.
   * @param rect - The rectangle, in CSS pixels of the page.
   * @returns The image, or `null` when the rectangle was refused.
   */
  captureVisual: (rect: { x: number; y: number; width: number; height: number }): Promise<string | null> =>
    ipcRenderer.invoke("atrium:capture-visual", rect),
  /**
   * Hears where the user presses the mouse anywhere in the window, frames included.
   *
   * @remarks
   * SPEC-0007, MV1 details: a visual's message counts only after a press inside its frame.
   *
   * @sideEffects Listens to the main process until stopped.
   * @param listener - Told each press, in the page's CSS pixels.
   * @returns Stops listening.
   */
  onPointerDown: (listener: (point: { x: number; y: number }) => void): (() => void) => {
    /**
     * Passes a press on.
     *
     * @remarks
     * Only the point, never the IPC event.
     *
     * @sideEffects Calls the listener.
     * @param _event - The IPC event.
     * @param point - Where.
     */
    const heard = (_event: unknown, point: { x: number; y: number }): void => listener(point);
    ipcRenderer.on("atrium:pointer-down", heard);
    return () => ipcRenderer.off("atrium:pointer-down", heard);
  },
  /**
   * Hears ⌘W and ⌘,, which the main process takes before the page or a visual can.
   *
   * @remarks
   * SPEC-0007 ("键盘", MV1 details): with the focus in a visual the page hears no key.
   *
   * @sideEffects Listens to the main process until stopped.
   * @param listener - Told which shortcut.
   * @returns Stops listening.
   */
  onShortcut: (listener: (shortcut: "close-tab" | "settings") => void): (() => void) => {
    /**
     * Passes a shortcut on.
     *
     * @remarks
     * Only one of the two names, never the IPC event or anything else.
     *
     * @sideEffects Calls the listener.
     * @param _event - The IPC event.
     * @param shortcut - Which.
     */
    const heard = (_event: unknown, shortcut: unknown): void => {
      if (shortcut === "close-tab" || shortcut === "settings") listener(shortcut);
    };
    ipcRenderer.on("atrium:shortcut", heard);
    return () => ipcRenderer.off("atrium:shortcut", heard);
  },
};

/**
 * Takes every WebRTC constructor off a frame's global for good, as `undefined` that can be neither
 * deleted nor redefined.
 *
 * @remarks
 * SPEC-0007, MV1 details: WebRTC reaches the network past the CSP and the request filter. The
 * visual's own shell does this for its frame, but a frame a visual opens inside itself (`srcdoc`,
 * `about:blank` written to, `data:`, `blob:`) is a fresh realm with a fresh `RTCPeerConnection`,
 * and loads without a navigation the main process could stop (MV1 three-way review). This
 * preload runs as each frame's realm is made, before its own script; it runs in the page's main
 * world, so it is written to stand alone.
 *
 * @sideEffects Redefines globals of the frame's main world.
 */
function withoutWebRtc(): void {
  for (const name of Object.getOwnPropertyNames(window)) {
    if (/^(?:webkit)?RTC/u.test(name)) {
      Object.defineProperty(window, name, {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    }
  }
}

// The preload runs in every frame (`nodeIntegrationInSubFrames`, still without Node): the bridge
// is the page's alone; any frame inside it, a visual or one of its own, only loses WebRTC.
if (process.isMainFrame) contextBridge.exposeInMainWorld("atrium", bridge);
else contextBridge.executeInMainWorld({ func: withoutWebRtc });
