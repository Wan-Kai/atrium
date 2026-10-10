import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * The only API the page gets from the desktop shell.
 *
 * @remarks
 * The renderer is sandboxed without Node (security.md, "Electron"), so this bridge is its sole
 * way to learn the host address and token, to have the user choose a project folder, to set
 * the window's appearance, and to learn the path of a file dropped on the input box; nothing else
 * from Electron is exposed.
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
};

contextBridge.exposeInMainWorld("atrium", bridge);
