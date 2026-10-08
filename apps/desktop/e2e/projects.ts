import type { ElectronApplication, Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Adds a folder as a project through the sidebar, as the user would.
 *
 * @remarks
 * The system's folder dialog cannot be driven, so the main process's `dialog.showOpenDialog`
 * answers with the folder instead, the way `app.spec.ts` stands in for the system browser.
 *
 * @sideEffects Replaces the dialog in the app's main process; clicks "添加项目".
 * @param app - The app.
 * @param window - Its window.
 * @param dir - The folder.
 */
export async function addProject(app: ElectronApplication, window: Page, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, dir);
  await window.getByRole("button", { name: "添加项目" }).click();
}

/**
 * The folder pi keeps a working directory's sessions in.
 *
 * @remarks
 * pi's rule (pi-internals.md §1), as the host's catalog follows it.
 *
 * @sideEffects none
 * @param agentDir - pi's agent directory.
 * @param cwd - The working directory, a real path.
 * @returns The folder.
 */
export function piSessionFolder(agentDir: string, cwd: string): string {
  return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replaceAll(/[/\\:]/g, "-")}--`);
}

/**
 * Writes a session file as a terminal pi would, with one question.
 *
 * @remarks
 * For sessions the app should discover on its own.
 *
 * @sideEffects Creates the folder and file.
 * @param agentDir - pi's agent directory.
 * @param cwd - The session's working directory, a real path.
 * @param sessionId - Its id.
 * @param question - The first user message.
 */
export async function writeTerminalSession(
  agentDir: string,
  cwd: string,
  sessionId: string,
  question: string,
): Promise<void> {
  const folder = piSessionFolder(agentDir, cwd);
  await mkdir(folder, { recursive: true });
  const header = { type: "session", version: 3, id: sessionId, timestamp: "2026-10-08T00:00:00.000Z", cwd };
  const user = {
    type: "message",
    id: "a1b2c3d4",
    parentId: null,
    timestamp: "2026-10-08T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: question }], timestamp: 0 },
  };
  await writeFile(
    join(folder, `2026-10-08T00-00-00-000Z_${sessionId}.jsonl`),
    `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`,
  );
}

/**
 * Makes the page believe its window gained focus.
 *
 * @remarks
 * Playwright does not move the system's focus between windows; the app only listens for the
 * page's `focus` event.
 *
 * @sideEffects Dispatches a `focus` event in the page.
 * @param window - The window.
 */
export async function focusWindow(window: Page): Promise<void> {
  await window.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
}
