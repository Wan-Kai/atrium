import { type ElectronApplication, type Page, _electron as electron, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A launched desktop app with its own Atrium home directory. */
export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly window: Page;
  /** The Atrium home directory the app was started with. */
  readonly home: string;
  /** Milliseconds from launch until the page reported a connected host. */
  readonly connectedAfterMs: number;
  /** Reads every record in the host's current log file. */
  readonly readHostLog: () => Promise<Array<Record<string, unknown>>>;
  /** Quits the app and deletes its home directory. */
  readonly close: () => Promise<void>;
  /** Quits the app but keeps its home directory, so the final log can be read. */
  readonly quit: () => Promise<void>;
  /** Deletes the home directory after `quit`. */
  readonly cleanup: () => Promise<void>;
}

/** `preferences.json` with first launch done and the rest as a new home has it. */
const DONE_PREFERENCES = `${JSON.stringify({
  version: 3,
  appearance: "system",
  lastModel: null,
  thinkingByModel: {},
  setupDone: true,
})}\n`;

/**
 * Writes the preferences of a new Atrium home with first launch done.
 *
 * @remarks
 * Tests of the workbench start past first launch, which a new home would otherwise show
 * (SPEC-0001, "首次启动 · 什么时候显示").
 *
 * @sideEffects Writes `preferences.json` in `home`.
 * @param home - The Atrium home directory, before a host starts on it.
 */
export async function markSetupDone(home: string): Promise<void> {
  await writeFile(join(home, "preferences.json"), DONE_PREFERENCES);
}

/**
 * Returns the median of a non-empty list of numbers.
 *
 * @remarks
 * Performance budgets compare medians so one slow run caused by machine load does not fail the
 * budget (testing.md, "性能预算").
 *
 * @sideEffects none
 * @param values - Measurements.
 * @returns The median.
 * @throws {Error} When `values` is empty.
 */
export function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new Error("median of no values");
  return sorted.length % 2 === 1 ? upper : (upper + (sorted[middle - 1] ?? upper)) / 2;
}

/**
 * Launches the built desktop app against the built UI and host, isolated in a temp home.
 *
 * @remarks
 * End-to-end means the real launch path (testing.md, layer 6): Electron starts the bundled host
 * in its utility process and loads the UI the host serves. Only `ATRIUM_HOME` is redirected, so
 * the test never touches the developer's `~/.atrium`, and the host looks up no latest pi unless
 * `env` says where, so it stays off the network. A new home has first launch done already, so the
 * window opens on the workbench, unless `options.firstLaunch` asks for first launch; then the
 * launch waits for the welcome page instead, which has no connection status. With
 * `options.executablePath` it launches a packaged app instead of the repository's.
 *
 * @sideEffects Creates a temp directory unless given one, with the preferences in it; launches
 * Electron; waits for the page to connect.
 * @param env - Extra environment variables, such as `ATRIUM_DEV_URL` for the development path.
 * @param existingHome - A home an earlier launch used, to start the app again on it.
 * @param options - Whether a new home begins with first launch, and the packaged app to launch.
 * @returns The app, its window and helpers.
 */
export async function launchApp(
  env: Record<string, string> = {},
  existingHome?: string,
  options: { readonly firstLaunch?: boolean; readonly executablePath?: string } = {},
): Promise<LaunchedApp> {
  const firstLaunch = options.firstLaunch === true;
  const home = existingHome ?? (await mkdtemp(join(tmpdir(), "atrium-e2e-")));
  if (existingHome === undefined && !firstLaunch) await markSetupDone(home);
  const started = Date.now();
  const app = await electron.launch({
    // A packaged app knows its own code; the repository's is the current directory.
    ...(options.executablePath === undefined
      ? { args: ["."], cwd: join(import.meta.dirname, "..") }
      : { executablePath: options.executablePath, args: [] }),
    env: { ...process.env, ATRIUM_PI_LATEST_URL: "", ...env, ATRIUM_HOME: home },
    // Playwright emulates a light scheme by default, which would hide the real system appearance.
    colorScheme: null,
  });
  const window = await app.firstWindow();
  if (firstLaunch) await expect(window.getByRole("button", { name: "开始设置" })).toBeVisible({ timeout: 15_000 });
  else await expect(window.getByRole("status")).toHaveText(/已连接宿主/, { timeout: 15_000 });
  const connectedAfterMs = Date.now() - started;
  return {
    app,
    window,
    home,
    connectedAfterMs,
    readHostLog: async () =>
      (await readFile(join(home, "logs", "current.log"), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
    quit: () => app.close(),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}
