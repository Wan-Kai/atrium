import { type ElectronApplication, type Page, _electron as electron, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A launched desktop app with its own Atrium home directory. */
export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly window: Page;
  /** Milliseconds from launch until the page reported a connected host. */
  readonly connectedAfterMs: number;
  /** Reads every record in the host's current log file. */
  readonly readHostLog: () => Promise<Array<Record<string, unknown>>>;
  /** Quits the app and deletes its home directory. */
  readonly close: () => Promise<void>;
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
 * the test never touches the developer's `~/.atrium`.
 *
 * @sideEffects Creates a temp directory; launches Electron; waits for the page to connect.
 * @returns The app, its window and helpers.
 */
export async function launchApp(): Promise<LaunchedApp> {
  const home = await mkdtemp(join(tmpdir(), "atrium-e2e-"));
  const started = Date.now();
  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, ATRIUM_HOME: home },
    // Playwright emulates a light scheme by default, which would hide the real system appearance.
    colorScheme: null,
  });
  const window = await app.firstWindow();
  await expect(window.getByRole("status")).toHaveText(/已连接宿主/, { timeout: 15_000 });
  const connectedAfterMs = Date.now() - started;
  return {
    app,
    window,
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
  };
}
