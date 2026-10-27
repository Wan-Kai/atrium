import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp, markSetupDone } from "./launch";

/** Checks only a test-owned path. @remarks Missing files are observable cleanup evidence. @sideEffects Reads filesystem metadata. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Checks one deterministic launch fault against a real Electron process, including forced outer cleanup.
 * @remarks The public API wrapper records the real handle before firstWindow fails; the test never mocks launchApp.
 * @sideEffects Creates isolated homes/faux pi, launches Electron, injects failure, then restores the API and closes every known app.
 * @param scenario - Whether the home is caller-owned or cleanup itself reports an additional error.
 */
async function checkReadyFailure(scenario: "owned home" | "existing home" | "cleanup failure"): Promise<void> {
  if (process.env["ATRIUM_DEV_URL"] !== undefined || process.env["ATRIUM_HOST_ENTRY"] !== undefined)
    throw new Error("launch failure regression requires the repository's built app");
  const faux = await fauxPiEnvironment({ replies: [] });
  const existing =
    scenario === "existing home" ? await mkdtemp(join(tmpdir(), "atrium-launch-owned-by-caller-")) : undefined;
  // oxlint-disable-next-line typescript/unbound-method -- preserve exact identity for restoration; invocation explicitly uses .call(electron).
  const originalLaunch = electron.launch;
  const readyFailure = new Error("injected firstWindow failure");
  const cleanupFailure = new Error("injected close failure after real process shutdown");
  const observed: {
    app?: ElectronApplication;
    child?: ChildProcess;
    home?: string | undefined;
    close?: () => Promise<void>;
  } = {};
  const errors: unknown[] = [];
  try {
    if (existing !== undefined) {
      await markSetupDone(existing);
      await writeFile(join(existing, "caller-sentinel"), "caller-owned");
    }
    electron.launch = async (options) => {
      const app = await originalLaunch.call(electron, options);
      observed.app = app;
      // Playwright disposes app.process() after close; retain the real ChildProcess before injection.
      observed.child = app.process();
      observed.home = options?.env?.["ATRIUM_HOME"];
      observed.close = app.close.bind(app);
      app.firstWindow = async () => {
        throw readyFailure;
      };
      if (scenario === "cleanup failure") {
        const close = observed.close;
        app.close = async () => {
          await close();
          throw cleanupFailure;
        };
      }
      return app;
    };
    let failure: unknown;
    try {
      await launchApp(faux.env, existing);
    } catch (error) {
      failure = error;
    }
    if (scenario === "cleanup failure") {
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure instanceof AggregateError ? failure.errors : []).toStrictEqual([readyFailure, cleanupFailure]);
    } else {
      expect(failure).toBe(readyFailure);
    }
    if (observed.child === undefined || observed.home === undefined) throw new Error("real launcher was not observed");
    const child = observed.child;
    await expect.soft.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect.soft(await exists(observed.home)).toBe(existing !== undefined);
    if (existing !== undefined) expect(await readFile(join(existing, "caller-sentinel"), "utf8")).toBe("caller-owned");
  } catch (error) {
    errors.push(error);
  } finally {
    electron.launch = originalLaunch;
    try {
      const child = observed.child;
      if (child !== undefined && child.exitCode === null && child.signalCode === null) await observed.close?.();
    } catch (error) {
      errors.push(error);
    }
    for (const home of new Set([observed.home, existing])) {
      if (home === undefined) continue;
      try {
        await rm(home, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await faux.cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "launch regression and cleanup failed");
}

// Run sequentially but independently: a red case must not skip the other cleanup scenarios.
test.describe.configure({ mode: "default" });
for (const scenario of ["owned home", "existing home", "cleanup failure"] as const) {
  test(`cleans up a real Electron ready failure with ${scenario}`, async () => checkReadyFailure(scenario));
}
