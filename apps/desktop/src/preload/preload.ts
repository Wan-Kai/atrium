import { contextBridge, ipcRenderer } from "electron";

/**
 * The only API the page gets from the desktop shell.
 *
 * @remarks
 * The renderer is sandboxed without Node (security.md, "Electron"), so this bridge is its sole
 * way to learn the host address and token, to have the user choose a project folder, and to set
 * the window's appearance; nothing else from Electron is exposed.
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
};

contextBridge.exposeInMainWorld("atrium", bridge);
