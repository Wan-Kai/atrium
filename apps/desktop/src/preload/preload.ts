import { contextBridge, ipcRenderer } from "electron";

/**
 * The only API the page gets from the desktop shell.
 *
 * @remarks
 * The renderer is sandboxed without Node (security.md, "Electron"), so this bridge is its sole
 * way to learn the host address and token; nothing else from Electron is exposed.
 */
const bridge = {
  /** Asks the main process for the host URL and session token. */
  getBootstrap: (): Promise<{ hostUrl: string; token: string }> => ipcRenderer.invoke("atrium:bootstrap"),
};

contextBridge.exposeInMainWorld("atrium", bridge);
